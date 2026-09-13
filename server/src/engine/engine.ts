import { PaperBroker } from '../brokers/paperBroker.ts';
import { brokerCatalog } from '../brokers/registry.ts';
import { clusterKeyOf, evaluateConvergence, type ConvergenceEvaluation } from '../core/convergence.ts';
import { clientOrderIdFor, id } from '../core/ids.ts';
import { ingest, refreshSignalStatus, type SignalInput } from '../core/ingestion.ts';
import { computeDailyResult, evaluateRisk, type DayState, type RiskContext } from '../core/risk.ts';
import {
  defaultConvergenceSettings,
  defaultMode,
  defaultRiskSettings,
} from '../core/settings.ts';
import { addMinutes, systemClock, tradingDayKey, type Clock } from '../core/time.ts';
import type {
  AuditEvent,
  ConvergenceSettings,
  EventKind,
  OperationMode,
  Opportunity,
  Order,
  Position,
  RiskDecision,
  RiskSettings,
  Signal,
  Source,
} from '../core/types.ts';

/**
 * Orquestrador.
 *
 * Une as camadas sem que nenhuma conheca a outra diretamente:
 *   ingestao -> convergencia -> risco -> execucao -> registro
 *
 * Toda decisao, inclusive as negativas, vira evento de auditoria. A interface le
 * o estado por instantaneo e recebe atualizacoes por fluxo de eventos.
 */

export type EngineListener = (event: { type: 'state' | 'event'; payload: unknown }) => void;

export interface EngineOptions {
  clock?: Clock;
  seed?: number;
  initialBalance?: number;
}

export class Engine {
  readonly clock: Clock;
  readonly broker: PaperBroker;

  sources: Source[] = [];
  signals: Signal[] = [];
  opportunities: Opportunity[] = [];
  orders: Order[] = [];
  events: AuditEvent[] = [];
  evaluations: ConvergenceEvaluation[] = [];
  decisions = new Map<string, RiskDecision>();
  /** Oportunidades aguardando confirmacao manual no modo semiautomatico. */
  awaitingConfirmation = new Set<string>();

  mode: OperationMode = defaultMode;
  automationPaused = false;
  convergenceSettings: ConvergenceSettings = { ...defaultConvergenceSettings };
  riskSettings: RiskSettings = { ...defaultRiskSettings };
  activeBrokerId = 'paper';

  day: DayState;
  private listeners: EngineListener[] = [];
  /**
   * Oportunidades com execucao em andamento. Sem esta trava, duas passagens do
   * pipeline poderiam entrar no mesmo envio antes de o contador de execucoes ser
   * incrementado, gerando ordem duplicada.
   */
  private executing = new Set<string>();
  /** Execucoes assincronas pendentes, para que os cenarios e testes possam aguardar. */
  private pending: Array<Promise<unknown>> = [];

  constructor(options: EngineOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.broker = new PaperBroker({
      clock: this.clock,
      seed: options.seed,
      initialBalance: options.initialBalance ?? 10_000,
      onPositionClosed: (position) => this.handlePositionClosed(position),
    });
    this.day = {
      dayKey: tradingDayKey(this.clock.nowIso(), this.riskSettings.tradingTimezone),
      baseEquity: options.initialBalance ?? 10_000,
      realizedNetPnl: 0,
      costs: 0,
      cashFlows: 0,
      tradesToday: 0,
      lastEntryAt: null,
      consecutiveLosses: 0,
      pausedUntil: null,
      dailyLimitHit: null,
    };
  }

  // --- Eventos ---------------------------------------------------------------

  subscribe(listener: EngineListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private emit(type: 'state' | 'event', payload: unknown): void {
    for (const listener of this.listeners) listener({ type, payload });
  }

  log(
    kind: EventKind,
    severity: AuditEvent['severity'],
    title: string,
    detail: string,
    refs: AuditEvent['refs'] = {},
  ): AuditEvent {
    const event: AuditEvent = {
      id: id('evt'),
      at: this.clock.nowIso(),
      kind,
      severity,
      title,
      detail,
      refs,
    };
    this.events.unshift(event);
    if (this.events.length > 800) this.events.length = 800;
    this.emit('event', event);
    return event;
  }

  private notifyState(): void {
    this.emit('state', null);
  }

  // --- Fontes ----------------------------------------------------------------

  addSource(input: Partial<Source> & { name: string }): Source {
    const sourceId = input.id ?? id('src');
    const source: Source = {
      id: sourceId,
      name: input.name,
      kind: input.kind ?? 'MANUAL',
      enabled: input.enabled ?? true,
      tags: input.tags ?? [],
      independenceGroupId: input.independenceGroupId ?? sourceId,
      weight: input.weight ?? 1,
      webhookToken: input.kind === 'WEBHOOK' ? (input.webhookToken ?? id('whk')) : undefined,
      notes: input.notes ?? '',
      createdAt: this.clock.nowIso(),
      stats: { received: 0, valid: 0, rejected: 0, lastSignalAt: null },
    };
    this.sources.push(source);
    this.notifyState();
    return source;
  }

  updateSource(sourceId: string, patch: Partial<Source>): Source | null {
    const source = this.sources.find((s) => s.id === sourceId);
    if (!source) return null;
    Object.assign(source, {
      name: patch.name ?? source.name,
      enabled: patch.enabled ?? source.enabled,
      tags: patch.tags ?? source.tags,
      independenceGroupId: patch.independenceGroupId ?? source.independenceGroupId,
      weight: patch.weight ?? source.weight,
      notes: patch.notes ?? source.notes,
    });
    this.runPipeline();
    return source;
  }

  removeSource(sourceId: string): boolean {
    const before = this.sources.length;
    this.sources = this.sources.filter((s) => s.id !== sourceId);
    if (this.sources.length === before) return false;
    this.runPipeline();
    return true;
  }

  // --- Ingestao --------------------------------------------------------------

  ingestSignal(input: SignalInput): { ok: boolean; message: string; signalId?: string } {
    const source = this.sources.find((s) => s.id === input.sourceId);
    if (!source) return { ok: false, message: 'Fonte nao encontrada.' };

    source.stats.received += 1;
    source.stats.lastSignalAt = this.clock.nowIso();

    const outcome = ingest(input, {
      nowIso: this.clock.nowIso(),
      source,
      existing: this.signals.filter((s) => s.sourceId === source.id),
      defaultTimezone: this.riskSettings.tradingTimezone,
    });

    let result: { ok: boolean; message: string; signalId?: string };

    switch (outcome.kind) {
      case 'DUPLICATE': {
        this.log(
          'SIGNAL_DUPLICATE',
          'INFO',
          `Mensagem duplicada de ${source.name}`,
          `Conteudo identico ao sinal ${outcome.duplicateOfId}. Nenhum voto novo foi criado.`,
          { sourceId: source.id, signalId: outcome.duplicateOfId },
        );
        result = { ok: true, message: 'Duplicata ignorada.', signalId: outcome.duplicateOfId };
        break;
      }
      case 'CANCELLATION': {
        const target = this.signals.find((s) => s.id === outcome.cancelledId);
        if (target) {
          target.status = 'CANCELLED';
          target.issues = [
            ...target.issues,
            { code: 'CANCELADO', message: outcome.note, severity: 'BLOCK' },
          ];
        }
        this.log(
          'SIGNAL_CANCELLED',
          'WARN',
          `Sinal cancelado por ${source.name}`,
          outcome.note,
          { sourceId: source.id, signalId: outcome.cancelledId },
        );
        result = { ok: true, message: 'Sinal cancelado.', signalId: outcome.cancelledId };
        break;
      }
      case 'REJECTED': {
        source.stats.rejected += 1;
        this.signals.unshift(outcome.signal);
        this.log(
          'SIGNAL_REJECTED',
          'BLOCK',
          `Sinal recusado de ${source.name}`,
          outcome.reason,
          { sourceId: source.id, signalId: outcome.signal.id },
        );
        result = { ok: false, message: outcome.reason, signalId: outcome.signal.id };
        break;
      }
      case 'ACCEPTED': {
        if (outcome.supersededId) {
          const prior = this.signals.find((s) => s.id === outcome.supersededId);
          if (prior) {
            prior.status = 'SUPERSEDED';
            prior.supersededBySignalId = outcome.signal.id;
          }
          this.log(
            'SIGNAL_SUPERSEDED',
            'WARN',
            `Mensagem editada por ${source.name}`,
            `Versao ${outcome.signal.version} substitui o sinal ${outcome.supersededId}. O voto anterior sai do agrupamento.`,
            { sourceId: source.id, signalId: outcome.signal.id },
          );
        }
        this.signals.unshift(outcome.signal);
        if (outcome.signal.status === 'VALID') source.stats.valid += 1;
        else source.stats.rejected += 1;

        const blocking = outcome.signal.issues.filter((i) => i.severity === 'BLOCK');
        this.log(
          outcome.signal.status === 'VALID' ? 'SIGNAL_RECEIVED' : 'SIGNAL_REJECTED',
          outcome.signal.status === 'VALID' ? 'INFO' : 'WARN',
          `${outcome.signal.status === 'VALID' ? 'Sinal valido' : `Sinal ${outcome.signal.status.toLowerCase()}`} de ${source.name}`,
          outcome.signal.status === 'VALID'
            ? `${outcome.signal.side === 'BUY' ? 'Compra' : 'Venda'} em ${outcome.signal.symbol}${outcome.signal.entryPrice ? ` a ${outcome.signal.entryPrice}` : ' a mercado'}.`
            : blocking.map((i) => i.message).join(' '),
          { sourceId: source.id, signalId: outcome.signal.id },
        );
        result = { ok: true, message: 'Sinal registrado.', signalId: outcome.signal.id };
        break;
      }
    }

    if (this.signals.length > 500) this.signals.length = 500;
    this.runPipeline();
    return result;
  }

  // --- Pipeline --------------------------------------------------------------

  /** Reavalia expiracoes, convergencia, risco e execucao. */
  runPipeline(): void {
    const now = this.clock.nowIso();
    this.rolloverDayIfNeeded();

    this.signals = this.signals.map((s) =>
      refreshSignalStatus(s, now, this.convergenceSettings.maxSignalAgeMinutes),
    );

    this.evaluations = evaluateConvergence({
      nowIso: now,
      settings: this.convergenceSettings,
      signals: this.signals,
      sources: this.sources,
    });

    for (const evaluation of this.evaluations) {
      if (evaluation.meetsCriteria) this.upsertOpportunity(evaluation, now);
    }

    // Expiracao das oportunidades publicadas.
    for (const opportunity of this.opportunities) {
      const active = opportunity.status === 'PUBLISHED' || opportunity.status === 'UPDATED';
      if (active && Date.parse(opportunity.validUntil) <= Date.parse(now)) {
        opportunity.status = 'EXPIRED';
        this.awaitingConfirmation.delete(opportunity.id);
        this.log(
          'OPPORTUNITY_EXPIRED',
          'WARN',
          `Oportunidade expirada em ${opportunity.symbol}`,
          `Validade de ${this.convergenceSettings.opportunityTtlMinutes} min encerrada sem execucao.`,
          { opportunityId: opportunity.id },
        );
      }
    }

    for (const opportunity of this.opportunities) {
      if (opportunity.status === 'PUBLISHED' || opportunity.status === 'UPDATED') {
        this.pending.push(this.considerExecution(opportunity));
      }
    }

    this.notifyState();
  }

  /** Aguarda as execucoes disparadas pelo pipeline. */
  async flush(): Promise<void> {
    while (this.pending.length > 0) {
      const batch = this.pending;
      this.pending = [];
      await Promise.all(batch);
    }
  }

  private upsertOpportunity(evaluation: ConvergenceEvaluation, now: string): void {
    /*
     * Uma convergencia so absorve novos sinais enquanto estiver viva. Passada a
     * validade, uma nova concordancia no mesmo instrumento e direcao e outra
     * oportunidade, com identificador proprio — e nao uma atualizacao da anterior.
     * Sem isso, uma oportunidade ja executada engoliria para sempre as seguintes.
     */
    const existing = this.opportunities.find(
      (o) =>
        o.clusterKey === evaluation.clusterKey &&
        (o.status === 'PUBLISHED' || o.status === 'UPDATED' || o.status === 'EXECUTED') &&
        Date.parse(o.validUntil) > Date.parse(now),
    );

    const payload = {
      market: evaluation.market,
      symbol: evaluation.symbol,
      venue: evaluation.venue,
      side: evaluation.side,
      referenceEntry: evaluation.referenceEntry,
      suggestedStopLoss: evaluation.suggestedStopLoss,
      suggestedTakeProfit: evaluation.suggestedTakeProfit,
      agreeing: evaluation.agreeing,
      dissenting: evaluation.dissenting,
      notComparable: evaluation.notComparable,
      nonParticipants: evaluation.nonParticipants,
      participantCount: evaluation.participantCount,
      agreeingCount: evaluation.agreeingCount,
      agreementPercent: evaluation.agreementPercent,
      weightedAgreementPercent: evaluation.weightedAgreementPercent,
      registeredActiveSources: evaluation.registeredActiveSources,
      criteria: evaluation.criteria,
      summary: evaluation.summary,
      signalIds: evaluation.signalIds,
    };

    if (existing) {
      const changed =
        existing.agreeingCount !== evaluation.agreeingCount ||
        existing.participantCount !== evaluation.participantCount ||
        existing.referenceEntry !== evaluation.referenceEntry;
      Object.assign(existing, payload, { updatedAt: now });
      if (changed) {
        existing.version += 1;
        if (existing.status !== 'EXECUTED') existing.status = 'UPDATED';
        existing.validUntil = addMinutes(now, this.convergenceSettings.opportunityTtlMinutes);
        this.log(
          'OPPORTUNITY_UPDATED',
          'INFO',
          `Convergencia atualizada em ${existing.symbol}`,
          `Versao ${existing.version}: ${evaluation.agreeingCount} de ${evaluation.participantCount} fontes. Atualizacao nao gera entrada adicional (limite de ${this.riskSettings.maxExecutionsPerOpportunity} execucao por oportunidade).`,
          { opportunityId: existing.id },
        );
      }
      return;
    }

    const opportunity: Opportunity = {
      id: id('opp'),
      clusterKey: evaluation.clusterKey,
      version: 1,
      createdAt: now,
      updatedAt: now,
      validUntil: addMinutes(now, this.convergenceSettings.opportunityTtlMinutes),
      status: 'PUBLISHED',
      executionCount: 0,
      ...payload,
    };
    this.opportunities.unshift(opportunity);
    if (this.opportunities.length > 200) this.opportunities.length = 200;

    this.log(
      'OPPORTUNITY_PUBLISHED',
      'SUCCESS',
      `Convergencia em ${opportunity.symbol}: ${opportunity.side === 'BUY' ? 'compra' : 'venda'}`,
      opportunity.summary,
      { opportunityId: opportunity.id },
    );
  }

  // --- Risco e execucao ------------------------------------------------------

  buildRiskContext(): Omit<RiskContext, 'executionsForOpportunity'> {
    return {
      nowIso: this.clock.nowIso(),
      mode: this.mode,
      automationPaused: this.automationPaused,
      settings: this.riskSettings,
      account: this.broker.getAccount(),
      quote: null,
      openPositions: this.broker.getPositions().filter((p) => p.status === 'OPEN'),
      day: this.day,
    };
  }

  evaluateOpportunityRisk(opportunity: Opportunity): RiskDecision {
    const base = this.buildRiskContext();
    const decision = evaluateRisk(opportunity, {
      ...base,
      quote: this.broker.getQuote(opportunity.symbol),
      executionsForOpportunity: opportunity.executionCount,
    });
    this.decisions.set(opportunity.id, decision);
    return decision;
  }

  private async considerExecution(opportunity: Opportunity): Promise<void> {
    const decision = this.evaluateOpportunityRisk(opportunity);

    if (this.mode === 'OBSERVE') return;
    if (!decision.allowed) return;
    if (this.executing.has(opportunity.id)) return;

    if (this.mode === 'SEMI_AUTO') {
      if (!this.awaitingConfirmation.has(opportunity.id)) {
        this.awaitingConfirmation.add(opportunity.id);
        this.log(
          'RISK_APPROVED',
          'INFO',
          `Aguardando confirmacao em ${opportunity.symbol}`,
          'Modo semiautomatico: todos os criterios e limites foram atendidos. A ordem so sai apos confirmacao manual.',
          { opportunityId: opportunity.id },
        );
      }
      return;
    }

    await this.execute(opportunity, 'AUTO');
  }

  /** Confirmacao manual no modo semiautomatico. */
  async confirmOpportunity(opportunityId: string): Promise<{ ok: boolean; message: string }> {
    const opportunity = this.opportunities.find((o) => o.id === opportunityId);
    if (!opportunity) return { ok: false, message: 'Oportunidade nao encontrada.' };
    const decision = this.evaluateOpportunityRisk(opportunity);
    if (!decision.allowed) {
      this.log(
        'RISK_BLOCKED',
        'BLOCK',
        `Confirmacao recusada em ${opportunity.symbol}`,
        decision.blocks.map((b) => `${b.label}: ${b.detail}`).join(' | '),
        { opportunityId: opportunity.id },
      );
      this.notifyState();
      return { ok: false, message: decision.blocks.map((b) => b.label).join('; ') };
    }
    const outcome = await this.execute(opportunity, 'MANUAL');
    return outcome;
  }

  rejectOpportunity(opportunityId: string): boolean {
    const opportunity = this.opportunities.find((o) => o.id === opportunityId);
    if (!opportunity) return false;
    opportunity.status = 'REJECTED_BY_USER';
    this.awaitingConfirmation.delete(opportunityId);
    this.log(
      'RISK_BLOCKED',
      'WARN',
      `Oportunidade descartada pelo usuario em ${opportunity.symbol}`,
      'Nenhuma ordem enviada.',
      { opportunityId },
    );
    this.notifyState();
    return true;
  }

  private async execute(
    opportunity: Opportunity,
    origin: 'AUTO' | 'MANUAL',
  ): Promise<{ ok: boolean; message: string }> {
    if (this.executing.has(opportunity.id)) {
      return { ok: false, message: 'Ja existe um envio em andamento para esta oportunidade.' };
    }
    this.executing.add(opportunity.id);
    try {
      return await this.executeInner(opportunity, origin);
    } finally {
      this.executing.delete(opportunity.id);
    }
  }

  private async executeInner(
    opportunity: Opportunity,
    origin: 'AUTO' | 'MANUAL',
  ): Promise<{ ok: boolean; message: string }> {
    const decision = this.decisions.get(opportunity.id);
    if (!decision?.sizing) return { ok: false, message: 'Sem dimensionamento calculado.' };

    const attempt = opportunity.executionCount + 1;
    const clientOrderId = clientOrderIdFor(opportunity.id, attempt);

    /*
     * Reconciliacao preventiva: se esta chave ja existe na corretora, a ordem ja
     * foi aceita antes (por exemplo, em uma tentativa que expirou sem resposta).
     * Nunca reenviar as cegas.
     */
    const known = await this.broker.findByClientOrderId(clientOrderId);
    if (known && (known.status === 'FILLED' || known.status === 'DUPLICATE')) {
      this.log(
        'ORDER_RECONCILED',
        'WARN',
        `Ordem ja existente na corretora para ${opportunity.symbol}`,
        `Chave de cliente ${clientOrderId} ja possui execucao. Reenvio evitado.`,
        { opportunityId: opportunity.id },
      );
      return { ok: false, message: 'Ordem ja existente. Reenvio evitado.' };
    }

    const order: Order = {
      id: id('ord'),
      clientOrderId,
      brokerOrderId: null,
      opportunityId: opportunity.id,
      opportunityVersion: opportunity.version,
      symbol: opportunity.symbol,
      side: opportunity.side,
      lots: decision.sizing.lots,
      requestedPrice: opportunity.referenceEntry,
      filledPrice: null,
      stopLoss: decision.sizing.stopLossPrice,
      takeProfit: decision.sizing.takeProfitPrice,
      status: 'SENT',
      createdAt: this.clock.nowIso(),
      updatedAt: this.clock.nowIso(),
      message: null,
      simulated: true,
    };
    this.orders.unshift(order);

    this.log(
      'ORDER_SENT',
      'INFO',
      `Ordem enviada (${origin === 'AUTO' ? 'modo autonomo' : 'confirmacao manual'}) em ${opportunity.symbol}`,
      `${opportunity.side === 'BUY' ? 'Compra' : 'Venda'} de ${order.lots} lote(s). Valor nocional ${decision.sizing.notionalValue.toFixed(2)}, valor arriscado ${decision.sizing.riskedValue.toFixed(2)}. Chave ${clientOrderId}.`,
      { opportunityId: opportunity.id, orderId: order.id },
    );

    let result = await this.broker.placeOrder({
      clientOrderId,
      symbol: opportunity.symbol,
      side: opportunity.side,
      lots: order.lots,
      stopLoss: order.stopLoss,
      takeProfit: order.takeProfit,
      maxDeviationPips: this.riskSettings.maxPriceDeviationPips,
    });

    if (result.status === 'TIMEOUT') {
      order.status = 'TIMEOUT';
      order.message = result.reason;
      order.updatedAt = this.clock.nowIso();
      this.log(
        'ORDER_TIMEOUT',
        'WARN',
        `Sem resposta da corretora em ${opportunity.symbol}`,
        `${result.reason} Consultando o estado da ordem ${clientOrderId} antes de qualquer reenvio.`,
        { opportunityId: opportunity.id, orderId: order.id },
      );
      const reconciled = await this.broker.findByClientOrderId(clientOrderId);
      if (reconciled && (reconciled.status === 'FILLED' || reconciled.status === 'DUPLICATE')) {
        result = reconciled;
        order.status = 'RECONCILED';
        this.log(
          'ORDER_RECONCILED',
          'SUCCESS',
          `Ordem reconciliada em ${opportunity.symbol}`,
          `A corretora ja tinha executado a chave ${clientOrderId}. Nenhuma ordem duplicada foi enviada.`,
          { opportunityId: opportunity.id, orderId: order.id },
        );
      } else {
        this.notifyState();
        return { ok: false, message: 'Sem resposta e sem execucao confirmada.' };
      }
    }

    if (result.status === 'REJECTED') {
      order.status = 'REJECTED';
      order.message = result.reason;
      order.updatedAt = this.clock.nowIso();
      this.log('ORDER_REJECTED', 'BLOCK', `Ordem recusada em ${opportunity.symbol}`, result.reason, {
        opportunityId: opportunity.id,
        orderId: order.id,
      });
      this.notifyState();
      return { ok: false, message: result.reason };
    }

    order.status = 'FILLED';
    order.brokerOrderId = result.brokerOrderId;
    order.filledPrice = result.filledPrice;
    order.updatedAt = this.clock.nowIso();
    this.broker.tagPosition(result.positionId, opportunity.id);

    opportunity.executionCount += 1;
    opportunity.status = 'EXECUTED';
    this.awaitingConfirmation.delete(opportunity.id);
    this.day.tradesToday += 1;
    this.day.lastEntryAt = this.clock.nowIso();

    this.log(
      'ORDER_FILLED',
      'SUCCESS',
      `Ordem executada em ${opportunity.symbol}`,
      `Preenchimento a ${result.filledPrice}. Stop ${order.stopLoss ?? 'nao definido'}, alvo ${order.takeProfit ?? 'nao definido'}. Operacao SIMULADA.`,
      { opportunityId: opportunity.id, orderId: order.id, positionId: result.positionId },
    );

    this.notifyState();
    return { ok: true, message: 'Ordem executada na conta simulada.' };
  }

  // --- Ciclo de vida das posicoes -------------------------------------------

  private handlePositionClosed(position: Position): void {
    this.day.realizedNetPnl = Math.round((this.day.realizedNetPnl + position.netPnl) * 100) / 100;
    this.day.costs = Math.round((this.day.costs + position.costs) * 100) / 100;

    if (position.netPnl < 0) {
      this.day.consecutiveLosses += 1;
      if (
        this.riskSettings.pauseAfterConsecutiveLosses > 0 &&
        this.day.consecutiveLosses >= this.riskSettings.pauseAfterConsecutiveLosses
      ) {
        this.day.pausedUntil = addMinutes(this.clock.nowIso(), this.riskSettings.pauseMinutes);
        this.log(
          'AUTOMATION_PAUSED',
          'WARN',
          'Pausa automatica por perdas consecutivas',
          `${this.day.consecutiveLosses} perdas seguidas. Novas entradas bloqueadas ate ${this.day.pausedUntil}.`,
        );
      }
    } else {
      this.day.consecutiveLosses = 0;
    }

    this.log(
      'POSITION_CLOSED',
      position.netPnl >= 0 ? 'SUCCESS' : 'WARN',
      `Posicao encerrada em ${position.symbol} (${position.closeReason})`,
      `Resultado bruto ${position.grossPnl.toFixed(2)}, custos ${position.costs.toFixed(2)}, liquido ${position.netPnl.toFixed(2)}.`,
      { positionId: position.id, opportunityId: position.opportunityId ?? undefined },
    );

    this.checkDailyLimits();
  }

  private checkDailyLimits(): void {
    const daily = computeDailyResult(
      this.day,
      this.broker.getPositions().filter((p) => p.status === 'OPEN'),
      this.riskSettings,
    );
    if (this.day.dailyLimitHit) return;

    let hit: 'LOSS' | 'PROFIT' | null = null;
    if (daily.limitBasisPnl <= daily.lossLimitValue) hit = 'LOSS';
    else if (daily.limitBasisPnl >= daily.profitTargetValue) hit = 'PROFIT';
    if (!hit) return;

    this.day.dailyLimitHit = hit;
    this.log(
      'DAILY_LIMIT_HIT',
      'BLOCK',
      hit === 'LOSS' ? 'Stop loss diario atingido' : 'Stop win diario atingido',
      `Resultado realizado ${daily.limitBasisPnl.toFixed(2)} sobre base do dia ${daily.baseEquity.toFixed(2)} (${daily.limitBasisPercent.toFixed(2)}%). Novas entradas bloqueadas ate a virada do dia operacional.`,
    );

    if (this.riskSettings.onDailyLimitCancelPending) {
      void this.broker.cancelAllPending().then((count) => {
        this.log(
          'DAILY_LIMIT_HIT',
          'INFO',
          'Ordens pendentes canceladas',
          `${count} ordem(ns) pendente(s) cancelada(s) por configuracao do limite diario.`,
        );
      });
    }
    if (this.riskSettings.onDailyLimitClosePositions) {
      const open = this.broker.getPositions().filter((p) => p.status === 'OPEN');
      for (const position of open) {
        void this.broker.closePosition(position.id, 'DAILY_LIMIT');
      }
      this.log(
        'DAILY_LIMIT_HIT',
        'WARN',
        'Encerramento de posicoes abertas',
        `${open.length} posicao(oes) encerrada(s) a mercado por configuracao do limite diario. Encerramento a mercado nao garante preco.`,
      );
    }
  }

  private rolloverDayIfNeeded(): void {
    const key = tradingDayKey(this.clock.nowIso(), this.riskSettings.tradingTimezone);
    if (key === this.day.dayKey) return;
    this.day = {
      dayKey: key,
      baseEquity: this.broker.getAccount().equity,
      realizedNetPnl: 0,
      costs: 0,
      cashFlows: 0,
      tradesToday: 0,
      lastEntryAt: null,
      consecutiveLosses: 0,
      pausedUntil: null,
      dailyLimitHit: null,
    };
    this.log('MODE_CHANGED', 'INFO', 'Virada do dia operacional', `Novo dia ${key}. Base do dia redefinida para o patrimonio de abertura.`);
  }

  // --- Controles -------------------------------------------------------------

  setMode(mode: OperationMode): void {
    const previous = this.mode;
    this.mode = mode;
    this.awaitingConfirmation.clear();
    const label: Record<OperationMode, string> = {
      OBSERVE: 'Observacao',
      SEMI_AUTO: 'Semiautomatico',
      AUTO: 'Autonomo',
    };
    this.log('MODE_CHANGED', 'INFO', `Modo alterado para ${label[mode]}`, `Modo anterior: ${label[previous]}.`);
    this.runPipeline();
  }

  setAutomationPaused(paused: boolean): void {
    this.automationPaused = paused;
    this.log(
      'AUTOMATION_PAUSED',
      paused ? 'WARN' : 'INFO',
      paused ? 'Automacao pausada' : 'Automacao retomada',
      paused
        ? 'Nenhuma ordem sera enviada ate a retomada. Posicoes abertas continuam com stop e alvo.'
        : 'Envio de ordens liberado conforme o modo operacional.',
    );
    this.runPipeline();
  }

  updateConvergenceSettings(patch: Partial<ConvergenceSettings>): void {
    const changed = Object.keys(patch);
    this.convergenceSettings = { ...this.convergenceSettings, ...patch };
    this.log(
      'SETTINGS_CHANGED',
      'INFO',
      'Configuracao de convergencia alterada',
      `Campos: ${changed.join(', ')}.`,
    );
    this.runPipeline();
  }

  updateRiskSettings(patch: Partial<RiskSettings>): void {
    const changed = Object.keys(patch);
    this.riskSettings = { ...this.riskSettings, ...patch };
    this.log('SETTINGS_CHANGED', 'INFO', 'Configuracao de risco alterada', `Campos: ${changed.join(', ')}.`);
    this.runPipeline();
  }

  async setConnected(connected: boolean): Promise<void> {
    if (connected) {
      await this.broker.connect();
      this.broker.failureMode = 'NONE';
      this.broker.freezeQuotes = false;
      this.log('CONNECTION_RESTORED', 'SUCCESS', 'Conexao restabelecida', 'Cotacoes voltaram a atualizar.');
    } else {
      this.broker.failureMode = 'DISCONNECTED';
      this.log(
        'CONNECTION_LOST',
        'BLOCK',
        'Conexao perdida com a corretora',
        'Novas ordens bloqueadas enquanto os dados essenciais estiverem indisponiveis.',
      );
    }
    this.runPipeline();
  }

  /** Passo do relogio: atualiza precos, expiracoes e reavalia o pipeline. */
  tick(elapsedSeconds: number): void {
    this.broker.tick(elapsedSeconds);
    this.runPipeline();
  }

  snapshot() {
    const account = this.broker.getAccount();
    const positions = this.broker.getPositions();
    const openPositions = positions.filter((p) => p.status === 'OPEN');
    const daily = computeDailyResult(this.day, openPositions, this.riskSettings);
    return {
      now: this.clock.nowIso(),
      mode: this.mode,
      automationPaused: this.automationPaused,
      account,
      broker: this.broker.describe(),
      brokerCatalog,
      quotes: this.broker.getAllQuotes(),
      sources: this.sources,
      signals: this.signals.slice(0, 120),
      opportunities: this.opportunities.slice(0, 60),
      evaluations: this.evaluations,
      decisions: Object.fromEntries(this.decisions),
      awaitingConfirmation: [...this.awaitingConfirmation],
      orders: this.orders.slice(0, 60),
      positions,
      openPositions,
      events: this.events.slice(0, 120),
      convergenceSettings: this.convergenceSettings,
      riskSettings: this.riskSettings,
      day: this.day,
      daily,
    };
  }
}

export type Snapshot = ReturnType<Engine['snapshot']>;
