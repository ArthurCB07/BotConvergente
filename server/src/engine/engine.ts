import { PaperBroker, type PaperBrokerState } from '../brokers/paperBroker.ts';
import { brokerCatalog } from '../brokers/registry.ts';
import type { Store } from '../infra/store.ts';
import { evaluateConvergence, type ConvergenceEvaluation } from '../core/convergence.ts';
import { clientOrderIdFor, id } from '../core/ids.ts';
import { getInstrument, instrumentsOfMarket, requireInstrument, requiredMargin } from '../core/instruments.ts';
import { ingest, refreshSignalStatus, type SignalInput } from '../core/ingestion.ts';
import {
  computeDailyResult,
  evaluateRisk,
  type DayState,
  type GlobalDayState,
} from '../core/risk.ts';
import {
  cloneConvergenceDefaults,
  cloneRiskDefaults,
  defaultAccountByMarket,
  defaultGlobalRiskSettings,
  defaultMode,
} from '../core/settings.ts';
import type { ReferenceQuotesService, ReferenceQuotesSnapshot } from '../quotes/referenceQuotes.ts';
import type { CryptoQuotesService, CryptoQuotesSnapshot } from '../quotes/cryptoQuotes.ts';
import { addMinutes, systemClock, tradingDayKey, type Clock } from '../core/time.ts';
import type {
  AuditEvent,
  ConvergenceSettings,
  EventKind,
  GlobalRiskSettings,
  MarketId,
  OperationMode,
  Opportunity,
  Order,
  Position,
  RiskDecision,
  RiskSettings,
  Signal,
  Source,
} from '../core/types.ts';
import { MARKET_IDS, MARKET_LABEL } from '../core/types.ts';

/**
 * Orquestrador multimercado.
 *
 * Mantem UM pipeline por mercado — ingestao, convergencia, risco, execucao — sobre
 * um conjunto compartilhado de fontes e um conjunto de contas. Os mercados nao se
 * enxergam: o unico ponto de contato deliberado sao os limites globais e, quando os
 * dois usam a mesma conta, a reserva coordenada de margem.
 *
 * Toda decisao, inclusive as negativas, vira evento de auditoria carimbado com o
 * mercado.
 */

export type EngineListener = (event: { type: 'state' | 'event'; payload: unknown }) => void;

export interface EngineOptions {
  clock?: Clock;
  seed?: number;
  initialBalance?: number;
  cryptoInitialBalance?: number;
  /** Quando ausente, o motor roda apenas em memoria. */
  store?: Store;
}

/** Estado de execucao de um mercado. */
export interface MarketRuntime {
  mode: OperationMode;
  automationEnabled: boolean;
  convergence: ConvergenceSettings;
  risk: RiskSettings;
  day: DayState;
  /** Conta usada por este mercado. */
  accountId: string;
}

/** Taxas de conversao para a moeda de referencia. Declaradas, nao inferidas. */
const RATE_TO_USD: Record<string, number> = { USD: 1, USDT: 1 };
const CONVERSION_NOTE =
  'Consolidado em USD. USDT convertido a 1,00 USD por paridade declarada do ambiente simulado.';

function toReference(amount: number, currency: string): number {
  return amount * (RATE_TO_USD[currency] ?? 1);
}

/** Chaves do armazenamento de estado avulso. */
const KV = {
  marketRuntime: (m: MarketId) => `runtime.market.${m}`,
  convergence: (m: MarketId) => `settings.convergence.${m}`,
  risk: (m: MarketId) => `settings.risk.${m}`,
  day: (m: MarketId) => `runtime.day.${m}`,
  globalPaused: 'runtime.globalPaused',
  globalRisk: 'settings.global',
  globalDay: 'runtime.globalDay',
  brokerState: (accountId: string) => `broker.${accountId}.state`,
} as const;

/** Intervalo minimo entre gravacoes do estado do simulador. */
const RUNTIME_PERSIST_INTERVAL_MS = 5_000;

export class Engine {
  readonly clock: Clock;
  readonly accounts = new Map<string, PaperBroker>();

  sources: Source[] = [];
  signals: Signal[] = [];
  opportunities: Opportunity[] = [];
  orders: Order[] = [];
  events: AuditEvent[] = [];
  evaluations: Record<MarketId, ConvergenceEvaluation[]> = { FOREX: [], CRYPTO: [] };
  decisions = new Map<string, RiskDecision>();
  /** Oportunidades aguardando confirmacao manual no modo semiautomatico. */
  awaitingConfirmation = new Set<string>();

  markets: Record<MarketId, MarketRuntime>;
  globalPaused = false;
  globalRisk: GlobalRiskSettings = { ...defaultGlobalRiskSettings };
  globalDay: GlobalDayState;

  readonly store: Store | null;
  /** Cotacao de referencia externa para Forex. Ausente quando nao configurada. */
  referenceQuotes: ReferenceQuotesService | null = null;
  /** Cotacao publica de mercado para Cripto (Binance Spot). */
  cryptoQuotes: CryptoQuotesService | null = null;
  /** Simbolos ja ancorados pelo menos uma vez, para nao repetir evento a cada ciclo. */
  private anchoredOnce = new Set<string>();
  /**
   * Deslocamento minimo para o realinhamento virar evento. Um ajuste de fracao de
   * pip nao informa nada; o que importa registrar e o salto de nivel, como sair do
   * preco inicial do catalogo para o preco de mercado.
   */
  private static readonly ANCHOR_EVENT_THRESHOLD = 0.001;
  private listeners: EngineListener[] = [];
  private executing = new Set<string>();
  private pending: Array<Promise<unknown>> = [];
  private lastRuntimePersistAt = 0;
  private readonly initialBalance: number;
  private readonly cryptoInitialBalance: number;
  private readonly seed: number;

  constructor(options: EngineOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.store = options.store ?? null;
    this.initialBalance = options.initialBalance ?? 10_000;
    this.cryptoInitialBalance = options.cryptoInitialBalance ?? 5_000;
    this.seed = options.seed ?? 20260913;

    this.accounts.set(
      'paper',
      new PaperBroker({
        id: 'paper',
        name: 'Conta simulada compartilhada',
        currency: 'USD',
        markets: ['FOREX', 'CRYPTO'],
        clock: this.clock,
        seed: this.seed,
        initialBalance: this.initialBalance,
        onPositionOpened: (position) => this.store?.savePosition(position),
        onPositionClosed: (position) => this.handlePositionClosed(position),
      }),
    );
    this.accounts.set(
      'paper-crypto',
      new PaperBroker({
        id: 'paper-crypto',
        name: 'Conta simulada exclusiva de cripto',
        currency: 'USDT',
        markets: ['CRYPTO'],
        clock: this.clock,
        seed: this.seed + 1,
        initialBalance: this.cryptoInitialBalance,
        onPositionOpened: (position) => this.store?.savePosition(position),
        onPositionClosed: (position) => this.handlePositionClosed(position),
      }),
    );

    const dayKey = tradingDayKey(this.clock.nowIso(), 'America/Sao_Paulo');
    const makeDay = (baseEquity: number): DayState => ({
      dayKey,
      baseEquity,
      realizedNetPnl: 0,
      costs: 0,
      cashFlows: 0,
      tradesToday: 0,
      lastEntryAt: null,
      consecutiveLosses: 0,
      pausedUntil: null,
      dailyLimitHit: null,
    });

    this.markets = {
      FOREX: {
        mode: defaultMode,
        automationEnabled: false,
        convergence: cloneConvergenceDefaults('FOREX'),
        risk: cloneRiskDefaults('FOREX'),
        day: makeDay(this.initialBalance),
        accountId: defaultAccountByMarket.FOREX,
      },
      CRYPTO: {
        mode: defaultMode,
        automationEnabled: false,
        convergence: cloneConvergenceDefaults('CRYPTO'),
        risk: cloneRiskDefaults('CRYPTO'),
        day: makeDay(this.initialBalance),
        accountId: defaultAccountByMarket.CRYPTO,
      },
    };

    this.globalDay = {
      dayKey,
      baseEquity: this.consolidatedEquity(),
      realizedNetPnl: 0,
      tradesToday: 0,
      dailyLimitHit: null,
      conversionNote: CONVERSION_NOTE,
    };
  }

  // --- Cotacao de referencia -------------------------------------------------

  /**
   * Liga o servico de cotacao externa. O preco de referencia passa a valer em dois
   * pontos: na checagem de plausibilidade do sinal e como ancora do preco simulado.
   *
   * O preco simulado continua sendo simulado — a ancora so alinha o nivel para que
   * a conta de demonstracao nao opere a 1,0850 enquanto o mercado esta a 1,1596.
   */
  attachReferenceQuotes(service: ReferenceQuotesService): void {
    this.referenceQuotes = service;
    this.applyReferenceQuotes();
  }

  /** Liga a cotacao publica de cripto. Mesma logica de ancoragem do Forex. */
  attachCryptoQuotes(service: CryptoQuotesService): void {
    this.cryptoQuotes = service;
    this.applyCryptoQuotes();
  }

  /**
   * Preco de referencia do instrumento, da fonte externa do mercado dele.
   * Forex vem da AwesomeAPI; Cripto, do livro publico da Binance Spot. As duas
   * fontes nunca se cruzam.
   */
  referencePriceOf(symbol: string): number | null {
    const instrument = getInstrument(symbol);
    if (!instrument) return null;
    if (instrument.marketId === 'CRYPTO') return this.cryptoQuotes?.midPrice(symbol) ?? null;
    const quote = this.referenceQuotes?.get(symbol);
    if (!quote || quote.bid == null || quote.ask == null) return null;
    return (quote.bid + quote.ask) / 2;
  }

  /** Reancora os precos simulados de Cripto no livro publico da Binance. */
  applyCryptoQuotes(): void {
    if (!this.cryptoQuotes) return;
    this.anchorMarket('CRYPTO', 'Binance Spot');
  }

  /** Reancora os precos simulados de Forex na referencia externa. */
  applyReferenceQuotes(): void {
    if (!this.referenceQuotes) return;
    this.anchorMarket('FOREX', 'AwesomeAPI');
  }

  private anchorMarket(marketId: MarketId, fonte: string): void {
    for (const instrument of instrumentsOfMarket(marketId)) {
      const mid = this.referencePriceOf(instrument.symbol);
      if (mid == null) continue;
      for (const broker of this.accounts.values()) {
        if (!broker.supportsSymbol(instrument.symbol)) continue;
        const before = broker.getQuote(instrument.symbol);
        const beforeMid = before ? (before.bid + before.ask) / 2 : null;
        const shift = beforeMid ? Math.abs(mid - beforeMid) / beforeMid : 1;
        const result = broker.anchorPrice(instrument.symbol, mid);
        /*
         * Evento apenas na primeira ancoragem de cada simbolo E quando o
         * deslocamento e relevante. Cinco pares a cada 60 s encheriam o historico,
         * e reiniciar o servidor com o preco ja alinhado nao e noticia.
         */
        const relevante = shift >= Engine.ANCHOR_EVENT_THRESHOLD;
        if (result.applied && relevante && !this.anchoredOnce.has(instrument.symbol)) {
          this.anchoredOnce.add(instrument.symbol);
          this.log(
            'CONNECTION_RESTORED',
            'INFO',
            marketId,
            `Preco simulado de ${instrument.symbol} alinhado ao preco externo`,
            `${result.reason} O preco externo vem de ${fonte} e serve para exibicao e conferencia; o preenchimento continua simulado.`,
          );
        }
      }
    }
    this.notifyState();
  }

  // --- Acesso a contas -------------------------------------------------------

  brokerFor(marketId: MarketId): PaperBroker {
    const broker = this.accounts.get(this.markets[marketId].accountId);
    if (!broker) throw new Error(`Conta ${this.markets[marketId].accountId} nao encontrada.`);
    return broker;
  }

  /** Contas efetivamente em uso pelos mercados, sem repetir quando compartilhada. */
  activeAccounts(): PaperBroker[] {
    const ids = new Set(MARKET_IDS.map((m) => this.markets[m].accountId));
    return [...ids].map((accountId) => this.accounts.get(accountId)).filter((b): b is PaperBroker => b != null);
  }

  private consolidatedEquity(): number {
    return this.activeAccounts().reduce((sum, broker) => {
      const account = broker.getAccount();
      return sum + toReference(account.equity, account.currency);
    }, 0);
  }

  /** Posicoes abertas de um mercado, buscando na conta daquele mercado. */
  openPositionsOf(marketId: MarketId): Position[] {
    return this.brokerFor(marketId)
      .getPositions()
      .filter((p) => p.status === 'OPEN' && p.marketId === marketId);
  }

  allOpenPositions(): Position[] {
    return this.activeAccounts().flatMap((b) => b.getPositions().filter((p) => p.status === 'OPEN'));
  }

  private globalExposureNotional(): number {
    return this.activeAccounts().reduce((sum, broker) => {
      const currency = broker.getAccount().currency;
      const exposure = broker
        .getPositions()
        .filter((p) => p.status === 'OPEN')
        .reduce((s, p) => s + p.notionalValue, 0);
      return sum + toReference(exposure, currency);
    }, 0);
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
    marketId: MarketId | null,
    title: string,
    detail: string,
    refs: AuditEvent['refs'] = {},
  ): AuditEvent {
    const event: AuditEvent = {
      id: id('evt'),
      at: this.clock.nowIso(),
      kind,
      severity,
      marketId,
      title,
      detail,
      refs,
    };
    this.events.unshift(event);
    if (this.events.length > 900) this.events.length = 900;
    this.store?.saveEvent(event);
    this.emit('event', event);
    return event;
  }

  /** Avisa a interface de que o estado mudou. Publico: integracoes externas
   * (como o Telegram) tambem precisam acordar a tela. */
  notifyState(): void {
    this.emit('state', null);
  }

  // --- Persistencia ----------------------------------------------------------

  hydrate(): boolean {
    if (!this.store) return false;
    const sources = this.store.loadSources();
    if (sources.length === 0) return false;

    this.sources = sources;
    this.signals = this.store.loadSignals();
    this.opportunities = this.store.loadOpportunities();
    this.orders = this.store.loadOrders();
    this.events = this.store.loadEvents();

    for (const marketId of MARKET_IDS) {
      const runtime = this.store.get<Partial<MarketRuntime>>(KV.marketRuntime(marketId));
      if (runtime) {
        if (runtime.mode) this.markets[marketId].mode = runtime.mode;
        if (typeof runtime.automationEnabled === 'boolean') {
          this.markets[marketId].automationEnabled = runtime.automationEnabled;
        }
        if (runtime.accountId && this.accounts.has(runtime.accountId)) {
          this.markets[marketId].accountId = runtime.accountId;
        }
      }
      const convergence = this.store.get<ConvergenceSettings>(KV.convergence(marketId));
      if (convergence) {
        this.markets[marketId].convergence = { ...this.markets[marketId].convergence, ...convergence };
      }
      const risk = this.store.get<RiskSettings>(KV.risk(marketId));
      if (risk) this.markets[marketId].risk = { ...this.markets[marketId].risk, ...risk };
      const day = this.store.get<DayState>(KV.day(marketId));
      if (day) this.markets[marketId].day = day;
    }

    const globalPaused = this.store.get<boolean>(KV.globalPaused);
    if (typeof globalPaused === 'boolean') this.globalPaused = globalPaused;
    const globalRisk = this.store.get<GlobalRiskSettings>(KV.globalRisk);
    if (globalRisk) this.globalRisk = { ...this.globalRisk, ...globalRisk };
    const globalDay = this.store.get<GlobalDayState>(KV.globalDay);
    if (globalDay) this.globalDay = { ...globalDay, conversionNote: CONVERSION_NOTE };

    for (const [accountId, broker] of this.accounts) {
      const state = this.store.get<PaperBrokerState>(KV.brokerState(accountId));
      if (state) broker.restore(state);
    }

    /*
     * Oportunidade que ficou publicada com o processo fora do ar nao pode voltar
     * elegivel: o preco andou sem supervisao.
     */
    const now = this.clock.nowIso();
    for (const opportunity of this.opportunities) {
      const active = opportunity.status === 'PUBLISHED' || opportunity.status === 'UPDATED';
      if (active && Date.parse(opportunity.validUntil) <= Date.parse(now)) {
        opportunity.status = 'EXPIRED';
        this.store.saveOpportunity(opportunity);
      }
    }

    this.log(
      'CONNECTION_RESTORED',
      'INFO',
      null,
      'Estado recuperado do banco',
      `${sources.length} fonte(s), ${this.signals.length} sinal(is), ${this.opportunities.length} oportunidade(s) e ${this.orders.length} ordem(ns) carregadas de ${this.store.path}.`,
    );
    return true;
  }

  persistRuntime(force = false): void {
    if (!this.store) return;
    const elapsed = Date.now() - this.lastRuntimePersistAt;
    if (!force && elapsed < RUNTIME_PERSIST_INTERVAL_MS) return;
    this.lastRuntimePersistAt = Date.now();

    const store = this.store;
    store.transaction(() => {
      for (const marketId of MARKET_IDS) {
        const runtime = this.markets[marketId];
        store.put(KV.marketRuntime(marketId), {
          mode: runtime.mode,
          automationEnabled: runtime.automationEnabled,
          accountId: runtime.accountId,
        });
        store.put(KV.convergence(marketId), runtime.convergence);
        store.put(KV.risk(marketId), runtime.risk);
        store.put(KV.day(marketId), runtime.day);
      }
      store.put(KV.globalPaused, this.globalPaused);
      store.put(KV.globalRisk, this.globalRisk);
      store.put(KV.globalDay, this.globalDay);
      for (const [accountId, broker] of this.accounts) {
        store.put(KV.brokerState(accountId), broker.serialize());
      }
    });
  }

  resetEnvironment(seeder?: (engine: Engine) => void): void {
    this.store?.wipe();
    this.sources = [];
    this.signals = [];
    this.opportunities = [];
    this.orders = [];
    this.events = [];
    this.evaluations = { FOREX: [], CRYPTO: [] };
    this.decisions.clear();
    this.awaitingConfirmation.clear();
    this.executing.clear();
    this.pending = [];

    this.globalPaused = false;
    this.globalRisk = { ...defaultGlobalRiskSettings };
    this.accounts.get('paper')?.reset(this.initialBalance, this.seed);
    this.accounts.get('paper-crypto')?.reset(this.cryptoInitialBalance, this.seed + 1);

    const dayKey = tradingDayKey(this.clock.nowIso(), 'America/Sao_Paulo');
    for (const marketId of MARKET_IDS) {
      this.markets[marketId] = {
        mode: defaultMode,
        automationEnabled: false,
        convergence: cloneConvergenceDefaults(marketId),
        risk: cloneRiskDefaults(marketId),
        day: {
          dayKey,
          baseEquity: this.initialBalance,
          realizedNetPnl: 0,
          costs: 0,
          cashFlows: 0,
          tradesToday: 0,
          lastEntryAt: null,
          consecutiveLosses: 0,
          pausedUntil: null,
          dailyLimitHit: null,
        },
        accountId: defaultAccountByMarket[marketId],
      };
    }
    this.globalDay = {
      dayKey,
      baseEquity: this.consolidatedEquity(),
      realizedNetPnl: 0,
      tradesToday: 0,
      dailyLimitHit: null,
      conversionNote: CONVERSION_NOTE,
    };

    seeder?.(this);
    this.log(
      'SETTINGS_CHANGED',
      'WARN',
      null,
      'Ambiente reiniciado',
      'Banco apagado e configuracoes dos dois mercados de volta aos valores sugeridos. Acao irreversivel.',
    );
    this.persistRuntime(true);
    this.runPipeline();
  }

  shutdown(): void {
    if (!this.store) return;
    this.persistRuntime(true);
    this.store.prune();
    this.store.close();
  }

  // --- Fontes ----------------------------------------------------------------

  addSource(input: Partial<Source> & { name: string }): Source {
    const sourceId = input.id ?? id('src');
    const markets = input.markets ?? [];
    const source: Source = {
      id: sourceId,
      name: input.name,
      kind: input.kind ?? 'MANUAL',
      enabled: input.enabled ?? true,
      markets,
      tags: input.tags ?? [],
      independenceGroupId: input.independenceGroupId ?? sourceId,
      weightByMarket: input.weightByMarket ?? { FOREX: 1, CRYPTO: 1 },
      webhookToken: input.kind === 'WEBHOOK' ? (input.webhookToken ?? id('whk')) : undefined,
      notes: input.notes ?? '',
      createdAt: this.clock.nowIso(),
      stats: { received: 0, valid: 0, rejected: 0, lastSignalAt: null },
    };
    this.sources.push(source);
    this.store?.saveSource(source);
    if (markets.length === 0) {
      this.log(
        'SETTINGS_CHANGED',
        'WARN',
        null,
        `Fonte "${source.name}" sem mercado classificado`,
        'A fonte fica cadastrada e recebe sinais, porem nao vota em nenhum mercado ate ser classificada.',
        { sourceId: source.id },
      );
    }
    this.notifyState();
    return source;
  }

  updateSource(sourceId: string, patch: Partial<Source>): Source | null {
    const source = this.sources.find((s) => s.id === sourceId);
    if (!source) return null;
    const marketsChanged =
      patch.markets != null && patch.markets.join(',') !== source.markets.join(',');
    Object.assign(source, {
      name: patch.name ?? source.name,
      enabled: patch.enabled ?? source.enabled,
      markets: patch.markets ?? source.markets,
      tags: patch.tags ?? source.tags,
      independenceGroupId: patch.independenceGroupId ?? source.independenceGroupId,
      weightByMarket: patch.weightByMarket ?? source.weightByMarket,
      notes: patch.notes ?? source.notes,
    });
    this.store?.saveSource(source);
    if (marketsChanged) {
      this.log(
        'SETTINGS_CHANGED',
        'INFO',
        null,
        `Mercados de "${source.name}" atualizados`,
        source.markets.length === 0
          ? 'Sem mercado classificado: a fonte nao vota.'
          : `Agora participa de ${source.markets.map((m) => MARKET_LABEL[m]).join(' e ')}.`,
        { sourceId: source.id },
      );
      this.revalidateSignalsOf(source);
    }
    this.runPipeline();
    return source;
  }

  /**
   * Reavalia os sinais ja recebidos de uma fonte apos mudanca de mercado. Isso
   * resgata sinais que estavam em MARKET_MISMATCH quando o usuario classifica a
   * fonte, em vez de exigir que a sala reenvie tudo.
   */
  private revalidateSignalsOf(source: Source): void {
    for (const signal of this.signals) {
      if (signal.sourceId !== source.id) continue;
      const instrument = getInstrument(signal.symbol);
      if (!instrument) continue;
      const belongs = source.markets.includes(instrument.marketId);
      if (signal.status === 'MARKET_MISMATCH' && belongs) {
        signal.status = 'VALID';
        signal.issues = signal.issues.filter((i) => i.code !== 'MERCADO_NAO_CADASTRADO');
        this.store?.saveSignal(signal);
      } else if (signal.status === 'VALID' && !belongs) {
        signal.status = 'MARKET_MISMATCH';
        signal.issues = [
          ...signal.issues,
          {
            code: 'MERCADO_NAO_CADASTRADO',
            message: `A fonte deixou de atender ${MARKET_LABEL[instrument.marketId]}. O sinal sai da convergencia.`,
            severity: 'BLOCK',
          },
        ];
        this.store?.saveSignal(signal);
      }
    }
  }

  removeSource(sourceId: string): boolean {
    const before = this.sources.length;
    this.sources = this.sources.filter((s) => s.id !== sourceId);
    if (this.sources.length === before) return false;
    this.store?.deleteSource(sourceId);
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
      defaultTimezone: this.markets.FOREX.risk.tradingTimezone,
      referencePriceOf: (symbol) => this.referencePriceOf(symbol),
    });

    let result: { ok: boolean; message: string; signalId?: string };

    switch (outcome.kind) {
      case 'DUPLICATE': {
        this.log(
          'SIGNAL_DUPLICATE',
          'INFO',
          outcome.signal.marketId,
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
          this.store?.saveSignal(target);
        }
        this.log(
          'SIGNAL_CANCELLED',
          'WARN',
          target?.marketId ?? null,
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
        this.store?.saveSignal(outcome.signal);
        this.log(
          'SIGNAL_REJECTED',
          'BLOCK',
          outcome.signal.marketId,
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
            this.store?.saveSignal(prior);
          }
          this.log(
            'SIGNAL_SUPERSEDED',
            'WARN',
            outcome.signal.marketId,
            `Mensagem editada por ${source.name}`,
            `Versao ${outcome.signal.version} substitui o sinal ${outcome.supersededId}. O voto anterior sai do agrupamento.`,
            { sourceId: source.id, signalId: outcome.signal.id },
          );
        }
        this.signals.unshift(outcome.signal);
        this.store?.saveSignal(outcome.signal);
        if (outcome.signal.status === 'VALID') source.stats.valid += 1;
        else source.stats.rejected += 1;

        const blocking = outcome.signal.issues.filter((i) => i.severity === 'BLOCK');
        if (outcome.signal.status === 'MARKET_MISMATCH') {
          this.log(
            'SIGNAL_MARKET_MISMATCH',
            'WARN',
            outcome.signal.marketId,
            `Sinal de mercado nao cadastrado em ${source.name}`,
            blocking.map((i) => i.message).join(' '),
            { sourceId: source.id, signalId: outcome.signal.id },
          );
        } else {
          this.log(
            outcome.signal.status === 'VALID' ? 'SIGNAL_RECEIVED' : 'SIGNAL_REJECTED',
            outcome.signal.status === 'VALID' ? 'INFO' : 'WARN',
            outcome.signal.marketId,
            `${outcome.signal.status === 'VALID' ? 'Sinal valido' : `Sinal ${outcome.signal.status.toLowerCase()}`} de ${source.name}`,
            outcome.signal.status === 'VALID'
              ? `${outcome.signal.side === 'BUY' ? 'Compra' : 'Venda'} em ${outcome.signal.symbol} (${MARKET_LABEL[outcome.signal.marketId]})${outcome.signal.entryPrice ? ` a ${outcome.signal.entryPrice}` : ' a mercado'}.`
              : blocking.map((i) => i.message).join(' '),
            { sourceId: source.id, signalId: outcome.signal.id },
          );
        }
        result = { ok: true, message: 'Sinal registrado.', signalId: outcome.signal.id };
        break;
      }
    }

    if (this.signals.length > 600) this.signals.length = 600;
    this.store?.saveSource(source);
    this.runPipeline();
    return result;
  }

  // --- Pipeline --------------------------------------------------------------

  runPipeline(): void {
    const now = this.clock.nowIso();
    this.rolloverDayIfNeeded();

    /*
     * Expiracao de sinal usa a idade maxima do mercado a que o sinal pertence.
     * Forex e Cripto tem janelas diferentes de proposito.
     */
    this.signals = this.signals.map((s) =>
      refreshSignalStatus(s, now, this.markets[s.marketId].convergence.maxSignalAgeMinutes),
    );

    for (const marketId of MARKET_IDS) {
      this.evaluations[marketId] = evaluateConvergence({
        nowIso: now,
        marketId,
        settings: this.markets[marketId].convergence,
        signals: this.signals,
        sources: this.sources,
      });
      for (const evaluation of this.evaluations[marketId]) {
        if (evaluation.meetsCriteria) this.upsertOpportunity(evaluation, now);
      }
    }

    for (const opportunity of this.opportunities) {
      const active = opportunity.status === 'PUBLISHED' || opportunity.status === 'UPDATED';
      if (active && Date.parse(opportunity.validUntil) <= Date.parse(now)) {
        opportunity.status = 'EXPIRED';
        this.awaitingConfirmation.delete(opportunity.id);
        this.store?.saveOpportunity(opportunity);
        this.log(
          'OPPORTUNITY_EXPIRED',
          'WARN',
          opportunity.marketId,
          `Oportunidade expirada em ${opportunity.symbol}`,
          `Validade de ${this.markets[opportunity.marketId].convergence.opportunityTtlMinutes} min encerrada sem execucao.`,
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
    const ttl = this.markets[evaluation.marketId].convergence.opportunityTtlMinutes;
    const existing = this.opportunities.find(
      (o) =>
        o.clusterKey === evaluation.clusterKey &&
        (o.status === 'PUBLISHED' || o.status === 'UPDATED' || o.status === 'EXECUTED') &&
        Date.parse(o.validUntil) > Date.parse(now),
    );

    const payload = {
      marketId: evaluation.marketId,
      productType: evaluation.productType,
      symbol: evaluation.symbol,
      venue: evaluation.venue,
      quoteCurrency: evaluation.quoteCurrency,
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
      denominatorMode: evaluation.denominatorMode,
      denominatorRule: evaluation.denominatorRule,
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
      this.store?.saveOpportunity(existing);
      if (changed) {
        existing.version += 1;
        if (existing.status !== 'EXECUTED') existing.status = 'UPDATED';
        existing.validUntil = addMinutes(now, ttl);
        this.log(
          'OPPORTUNITY_UPDATED',
          'INFO',
          existing.marketId,
          `Convergencia atualizada em ${existing.symbol}`,
          `Versao ${existing.version}: ${evaluation.agreeingCount} de ${evaluation.participantCount} fontes. Atualizacao nao gera entrada adicional (limite de ${this.markets[existing.marketId].risk.maxExecutionsPerOpportunity} execucao por oportunidade).`,
          { opportunityId: existing.id },
        );
        this.store?.saveOpportunity(existing);
      }
      return;
    }

    const opportunity: Opportunity = {
      id: id('opp'),
      clusterKey: evaluation.clusterKey,
      version: 1,
      createdAt: now,
      updatedAt: now,
      validUntil: addMinutes(now, ttl),
      status: 'PUBLISHED',
      executionCount: 0,
      ...payload,
    };
    this.opportunities.unshift(opportunity);
    if (this.opportunities.length > 240) this.opportunities.length = 240;
    this.store?.saveOpportunity(opportunity);

    this.log(
      'OPPORTUNITY_PUBLISHED',
      'SUCCESS',
      opportunity.marketId,
      `Convergencia em ${opportunity.symbol}: ${opportunity.side === 'BUY' ? 'compra' : 'venda'}`,
      opportunity.summary,
      { opportunityId: opportunity.id },
    );
  }

  // --- Risco e execucao ------------------------------------------------------

  evaluateOpportunityRisk(
    opportunity: Opportunity,
    origin: 'AUTO' | 'MANUAL' = 'AUTO',
  ): RiskDecision {
    const marketId = opportunity.marketId;
    const runtime = this.markets[marketId];
    const broker = this.brokerFor(marketId);
    const account = broker.getAccount();

    const decision = evaluateRisk(opportunity, {
      nowIso: this.clock.nowIso(),
      marketId,
      origin,
      mode: runtime.mode,
      automationEnabled: runtime.automationEnabled,
      globalPaused: this.globalPaused,
      settings: runtime.risk,
      globalSettings: this.globalRisk,
      account,
      quote: broker.getQuote(opportunity.symbol),
      openPositions: this.openPositionsOf(marketId),
      allOpenPositions: this.allOpenPositions(),
      globalExposureNotional: this.globalExposureNotional(),
      day: runtime.day,
      globalDay: this.globalDay,
      accountSupportsSymbol: broker.supportsSymbol(opportunity.symbol),
      executionsForOpportunity: opportunity.executionCount,
    });
    this.decisions.set(opportunity.id, decision);
    return decision;
  }

  private async considerExecution(opportunity: Opportunity): Promise<void> {
    const runtime = this.markets[opportunity.marketId];
    const decision = this.evaluateOpportunityRisk(opportunity, 'AUTO');

    if (runtime.mode === 'OBSERVE') return;
    if (this.executing.has(opportunity.id)) return;

    if (runtime.mode === 'SEMI_AUTO') {
      /*
       * No semiautomatico a oportunidade fica aguardando confirmacao quando os
       * criterios de risco passam, ignorando apenas os portoes que existem para
       * travar automacao — a confirmacao manual e outra coisa.
       */
      const manualDecision = this.evaluateOpportunityRisk(opportunity, 'MANUAL');
      if (manualDecision.allowed && !this.awaitingConfirmation.has(opportunity.id)) {
        this.awaitingConfirmation.add(opportunity.id);
        this.log(
          'RISK_APPROVED',
          'INFO',
          opportunity.marketId,
          `Aguardando confirmacao em ${opportunity.symbol}`,
          `Modo semiautomatico em ${MARKET_LABEL[opportunity.marketId]}: criterios e limites atendidos. A ordem so sai apos confirmacao manual.`,
          { opportunityId: opportunity.id },
        );
      }
      return;
    }

    if (!decision.allowed) return;
    await this.execute(opportunity, 'AUTO');
  }

  async confirmOpportunity(opportunityId: string): Promise<{ ok: boolean; message: string }> {
    const opportunity = this.opportunities.find((o) => o.id === opportunityId);
    if (!opportunity) return { ok: false, message: 'Oportunidade nao encontrada.' };
    const decision = this.evaluateOpportunityRisk(opportunity, 'MANUAL');
    if (!decision.allowed) {
      this.log(
        'RISK_BLOCKED',
        'BLOCK',
        opportunity.marketId,
        `Confirmacao recusada em ${opportunity.symbol}`,
        decision.blocks.map((b) => `${b.label} (${b.scope === 'GLOBAL' ? 'global' : 'mercado'}): ${b.detail}`).join(' | '),
        { opportunityId: opportunity.id },
      );
      this.notifyState();
      return { ok: false, message: decision.blocks.map((b) => b.label).join('; ') };
    }
    return this.execute(opportunity, 'MANUAL');
  }

  rejectOpportunity(opportunityId: string): boolean {
    const opportunity = this.opportunities.find((o) => o.id === opportunityId);
    if (!opportunity) return false;
    opportunity.status = 'REJECTED_BY_USER';
    this.awaitingConfirmation.delete(opportunityId);
    this.store?.saveOpportunity(opportunity);
    this.log(
      'RISK_BLOCKED',
      'WARN',
      opportunity.marketId,
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
    const marketId = opportunity.marketId;
    const runtime = this.markets[marketId];
    const broker = this.brokerFor(marketId);
    const decision = this.decisions.get(opportunity.id);
    if (!decision?.sizing) return { ok: false, message: 'Sem dimensionamento calculado.' };

    const attempt = opportunity.executionCount + 1;
    const clientOrderId = clientOrderIdFor(opportunity.id, attempt);
    const instrument = requireInstrument(opportunity.symbol);
    const quote = broker.getQuote(opportunity.symbol);
    const referencePrice = quote
      ? opportunity.side === 'BUY'
        ? quote.ask
        : quote.bid
      : (opportunity.referenceEntry ?? instrument.referencePrice);

    /*
     * RESERVA DE MARGEM — sincrona, antes de qualquer `await`.
     *
     * Se Forex e Cripto usam a mesma conta e convergem ao mesmo tempo, sem esta
     * reserva as duas avaliacoes de risco veriam a mesma margem livre e as duas
     * ordens sairiam comprometendo o mesmo saldo. A reserva entra no calculo de
     * margem livre da conta imediatamente.
     */
    const margin = requiredMargin(instrument, decision.sizing.quantity, referencePrice);
    if (!broker.reserveMargin(clientOrderId, margin)) {
      this.log(
        'RISK_BLOCKED',
        'BLOCK',
        marketId,
        `Margem indisponivel em ${opportunity.symbol}`,
        `Reserva de ${margin.toFixed(2)} ${broker.getAccount().currency} recusada: outra ordem em voo ja comprometeu a margem livre da conta ${broker.getAccount().accountId}.`,
        { opportunityId: opportunity.id },
      );
      this.notifyState();
      return { ok: false, message: 'Margem ja comprometida por outra ordem em voo.' };
    }

    try {
      /*
       * Reconciliacao preventiva: se esta chave ja existe na conexao, a ordem ja
       * foi aceita antes. Nunca reenviar as cegas.
       */
      const known = await broker.findByClientOrderId(clientOrderId);
      if (known && (known.status === 'FILLED' || known.status === 'DUPLICATE')) {
        this.log(
          'ORDER_RECONCILED',
          'WARN',
          marketId,
          `Ordem ja existente na conexao para ${opportunity.symbol}`,
          `Chave de cliente ${clientOrderId} ja possui execucao. Reenvio evitado.`,
          { opportunityId: opportunity.id },
        );
        return { ok: false, message: 'Ordem ja existente. Reenvio evitado.' };
      }

      const account = broker.getAccount();
      const order: Order = {
        id: id('ord'),
        clientOrderId,
        brokerOrderId: null,
        marketId,
        productType: opportunity.productType,
        accountId: account.accountId,
        brokerId: account.brokerId,
        opportunityId: opportunity.id,
        opportunityVersion: opportunity.version,
        symbol: opportunity.symbol,
        side: opportunity.side,
        quantity: decision.sizing.quantity,
        quantityLabel: decision.sizing.quantityLabel,
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
      this.store?.saveOrder(order);

      this.log(
        'ORDER_SENT',
        'INFO',
        marketId,
        `Ordem enviada (${origin === 'AUTO' ? 'modo autonomo' : 'confirmacao manual'}) em ${opportunity.symbol}`,
        `${opportunity.side === 'BUY' ? 'Compra' : 'Venda'} de ${order.quantity} ${order.quantityLabel}. Nocional ${decision.sizing.notionalValue.toFixed(2)}, arriscado ${decision.sizing.riskedValue.toFixed(2)}, margem reservada ${margin.toFixed(2)}. Conta ${account.accountId}. Chave ${clientOrderId}.`,
        { opportunityId: opportunity.id, orderId: order.id },
      );

      let result = await broker.placeOrder({
        clientOrderId,
        symbol: opportunity.symbol,
        side: opportunity.side,
        quantity: order.quantity,
        stopLoss: order.stopLoss,
        takeProfit: order.takeProfit,
        maxDeviationPips: runtime.risk.maxPriceDeviationPips,
      });

      if (result.status === 'TIMEOUT') {
        order.status = 'TIMEOUT';
        order.message = result.reason;
        order.updatedAt = this.clock.nowIso();
        this.store?.saveOrder(order);
        this.log(
          'ORDER_TIMEOUT',
          'WARN',
          marketId,
          `Sem resposta da conexao em ${opportunity.symbol}`,
          `${result.reason} Consultando o estado da ordem ${clientOrderId} antes de qualquer reenvio.`,
          { opportunityId: opportunity.id, orderId: order.id },
        );
        const reconciled = await broker.findByClientOrderId(clientOrderId);
        if (reconciled && (reconciled.status === 'FILLED' || reconciled.status === 'DUPLICATE')) {
          result = reconciled;
          order.status = 'RECONCILED';
          this.store?.saveOrder(order);
          this.log(
            'ORDER_RECONCILED',
            'SUCCESS',
            marketId,
            `Ordem reconciliada em ${opportunity.symbol}`,
            `A conexao ja tinha executado a chave ${clientOrderId}. Nenhuma ordem duplicada foi enviada.`,
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
        this.store?.saveOrder(order);
        this.log(
          'ORDER_REJECTED',
          'BLOCK',
          marketId,
          `Ordem recusada em ${opportunity.symbol}`,
          result.reason,
          { opportunityId: opportunity.id, orderId: order.id },
        );
        this.notifyState();
        return { ok: false, message: result.reason };
      }

      order.status = 'FILLED';
      order.brokerOrderId = result.brokerOrderId;
      order.filledPrice = result.filledPrice;
      order.updatedAt = this.clock.nowIso();
      broker.tagPosition(result.positionId, opportunity.id);

      opportunity.executionCount += 1;
      opportunity.status = 'EXECUTED';
      this.awaitingConfirmation.delete(opportunity.id);
      runtime.day.tradesToday += 1;
      runtime.day.lastEntryAt = this.clock.nowIso();
      this.globalDay.tradesToday += 1;
      this.store?.saveOrder(order);
      this.store?.saveOpportunity(opportunity);
      this.persistRuntime(true);

      this.log(
        'ORDER_FILLED',
        'SUCCESS',
        marketId,
        `Ordem executada em ${opportunity.symbol}`,
        `Preenchimento a ${result.filledPrice}. Stop ${order.stopLoss ?? 'nao definido'}, alvo ${order.takeProfit ?? 'nao definido'}. Mercado ${MARKET_LABEL[marketId]}, conta ${order.accountId}, oportunidade ${opportunity.id}. Operacao SIMULADA.`,
        { opportunityId: opportunity.id, orderId: order.id, positionId: result.positionId },
      );

      this.notifyState();
      return { ok: true, message: 'Ordem executada na conta simulada.' };
    } finally {
      // A margem da posicao aberta passa a contar como usada; a reserva sai.
      broker.releaseMargin(clientOrderId);
    }
  }

  // --- Ciclo de vida das posicoes -------------------------------------------

  private handlePositionClosed(position: Position): void {
    this.store?.savePosition(position);
    const marketId = position.marketId;
    const runtime = this.markets[marketId];
    const broker = this.accounts.get(position.brokerId);
    const currency = broker?.getAccount().currency ?? 'USD';

    runtime.day.realizedNetPnl =
      Math.round((runtime.day.realizedNetPnl + position.netPnl) * 100) / 100;
    runtime.day.costs = Math.round((runtime.day.costs + position.costs) * 100) / 100;
    this.globalDay.realizedNetPnl =
      Math.round((this.globalDay.realizedNetPnl + toReference(position.netPnl, currency)) * 100) / 100;

    if (position.netPnl < 0) {
      runtime.day.consecutiveLosses += 1;
      if (
        runtime.risk.pauseAfterConsecutiveLosses > 0 &&
        runtime.day.consecutiveLosses >= runtime.risk.pauseAfterConsecutiveLosses
      ) {
        runtime.day.pausedUntil = addMinutes(this.clock.nowIso(), runtime.risk.pauseMinutes);
        this.log(
          'AUTOMATION_PAUSED',
          'WARN',
          marketId,
          `Pausa automatica em ${MARKET_LABEL[marketId]} por perdas consecutivas`,
          `${runtime.day.consecutiveLosses} perdas seguidas. Novas entradas deste mercado bloqueadas ate ${runtime.day.pausedUntil}.`,
        );
      }
    } else {
      runtime.day.consecutiveLosses = 0;
    }

    this.log(
      'POSITION_CLOSED',
      position.netPnl >= 0 ? 'SUCCESS' : 'WARN',
      marketId,
      `Posicao encerrada em ${position.symbol} (${position.closeReason})`,
      `Resultado bruto ${position.grossPnl.toFixed(2)}, custos ${position.costs.toFixed(2)}, liquido ${position.netPnl.toFixed(2)} ${currency}. Conta ${position.accountId}.`,
      { positionId: position.id, opportunityId: position.opportunityId ?? undefined },
    );

    this.checkDailyLimits(marketId);
    this.checkGlobalLimits();
    this.persistRuntime(true);
  }

  private checkDailyLimits(marketId: MarketId): void {
    const runtime = this.markets[marketId];
    if (runtime.day.dailyLimitHit) return;

    const daily = computeDailyResult(
      runtime.day,
      this.openPositionsOf(marketId),
      runtime.risk.dailyLossLimitPercent,
      runtime.risk.dailyProfitTargetPercent,
    );

    let hit: 'LOSS' | 'PROFIT' | null = null;
    if (daily.limitBasisPnl <= daily.lossLimitValue) hit = 'LOSS';
    else if (daily.limitBasisPnl >= daily.profitTargetValue) hit = 'PROFIT';
    if (!hit) return;

    runtime.day.dailyLimitHit = hit;
    this.log(
      'DAILY_LIMIT_HIT',
      'BLOCK',
      marketId,
      hit === 'LOSS'
        ? `Stop loss diario de ${MARKET_LABEL[marketId]} atingido`
        : `Stop win diario de ${MARKET_LABEL[marketId]} atingido`,
      `Resultado realizado ${daily.limitBasisPnl.toFixed(2)} sobre base do dia ${daily.baseEquity.toFixed(2)} (${daily.limitBasisPercent.toFixed(2)}%). Novas entradas deste mercado bloqueadas ate a virada do dia. O outro mercado segue operando.`,
    );

    const broker = this.brokerFor(marketId);
    if (runtime.risk.onDailyLimitCancelPending) {
      void broker.cancelAllPending().then((count) => {
        this.log(
          'DAILY_LIMIT_HIT',
          'INFO',
          marketId,
          'Ordens pendentes canceladas',
          `${count} ordem(ns) pendente(s) de ${MARKET_LABEL[marketId]} cancelada(s) por configuracao do limite diario.`,
        );
      });
    }
    if (runtime.risk.onDailyLimitClosePositions) {
      const open = this.openPositionsOf(marketId);
      for (const position of open) void broker.closePosition(position.id, 'DAILY_LIMIT');
      this.log(
        'DAILY_LIMIT_HIT',
        'WARN',
        marketId,
        'Encerramento de posicoes abertas',
        `${open.length} posicao(oes) de ${MARKET_LABEL[marketId]} encerrada(s) a mercado. Encerramento a mercado nao garante preco.`,
      );
    }
  }

  private checkGlobalLimits(): void {
    if (!this.globalRisk.enabled || this.globalDay.dailyLimitHit) return;
    const base = this.globalDay.baseEquity || 1;
    const lossLimit = -(base * this.globalRisk.dailyLossLimitPercent) / 100;
    const profitTarget = (base * this.globalRisk.dailyProfitTargetPercent) / 100;

    let hit: 'LOSS' | 'PROFIT' | null = null;
    if (this.globalDay.realizedNetPnl <= lossLimit) hit = 'LOSS';
    else if (this.globalDay.realizedNetPnl >= profitTarget) hit = 'PROFIT';
    if (!hit) return;

    this.globalDay.dailyLimitHit = hit;
    this.log(
      'DAILY_LIMIT_HIT',
      'BLOCK',
      null,
      hit === 'LOSS' ? 'Stop loss diario GLOBAL atingido' : 'Stop win diario GLOBAL atingido',
      `Resultado consolidado ${this.globalDay.realizedNetPnl.toFixed(2)} sobre base de ${base.toFixed(2)}. Novas entradas bloqueadas nos DOIS mercados ate a virada do dia. ${this.globalDay.conversionNote}`,
    );
  }

  private rolloverDayIfNeeded(): void {
    const key = tradingDayKey(this.clock.nowIso(), this.markets.FOREX.risk.tradingTimezone);
    if (key === this.globalDay.dayKey) return;

    for (const marketId of MARKET_IDS) {
      const account = this.brokerFor(marketId).getAccount();
      this.markets[marketId].day = {
        dayKey: key,
        baseEquity: account.equity,
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
    this.globalDay = {
      dayKey: key,
      baseEquity: this.consolidatedEquity(),
      realizedNetPnl: 0,
      tradesToday: 0,
      dailyLimitHit: null,
      conversionNote: CONVERSION_NOTE,
    };
    this.log(
      'MODE_CHANGED',
      'INFO',
      null,
      'Virada do dia operacional',
      `Novo dia ${key}. Base do dia redefinida nos dois mercados e no consolidado.`,
    );
    this.persistRuntime(true);
  }

  // --- Controles -------------------------------------------------------------

  setMode(marketId: MarketId, mode: OperationMode): void {
    const previous = this.markets[marketId].mode;
    this.markets[marketId].mode = mode;
    for (const opportunity of this.opportunities) {
      if (opportunity.marketId === marketId) this.awaitingConfirmation.delete(opportunity.id);
    }
    const label: Record<OperationMode, string> = {
      OBSERVE: 'Observacao',
      SEMI_AUTO: 'Semiautomatico',
      AUTO: 'Autonomo',
    };
    this.log(
      'MODE_CHANGED',
      'INFO',
      marketId,
      `Modo de ${MARKET_LABEL[marketId]} alterado para ${label[mode]}`,
      `Modo anterior: ${label[previous]}. O outro mercado nao foi afetado.`,
    );
    this.persistRuntime(true);
    this.runPipeline();
  }

  setAutomationEnabled(marketId: MarketId, enabled: boolean): void {
    this.markets[marketId].automationEnabled = enabled;
    this.log(
      'AUTOMATION_CHANGED',
      enabled ? 'INFO' : 'WARN',
      marketId,
      `Automacao de ${MARKET_LABEL[marketId]} ${enabled ? 'ligada' : 'desligada'}`,
      enabled
        ? `Novas entradas automaticas de ${MARKET_LABEL[marketId]} liberadas conforme o modo e os limites.`
        : `Nenhuma entrada automatica nova em ${MARKET_LABEL[marketId]}. Sinais continuam chegando, oportunidades continuam sendo publicadas e as posicoes abertas seguem com stop e alvo.`,
    );
    this.persistRuntime(true);
    this.runPipeline();
  }

  setGlobalPaused(paused: boolean): void {
    this.globalPaused = paused;
    this.log(
      'AUTOMATION_PAUSED',
      paused ? 'WARN' : 'INFO',
      null,
      paused ? 'Pausa global ativada' : 'Pausa global desativada',
      paused
        ? 'Nenhuma entrada automatica nova nos dois mercados. Posicoes abertas continuam geridas, com stop e alvo.'
        : 'Envio automatico liberado conforme a automacao e o modo de cada mercado.',
    );
    this.persistRuntime(true);
    this.runPipeline();
  }

  updateConvergenceSettings(marketId: MarketId, patch: Partial<ConvergenceSettings>): void {
    const changed = Object.keys(patch);
    this.markets[marketId].convergence = { ...this.markets[marketId].convergence, ...patch };
    this.log(
      'SETTINGS_CHANGED',
      'INFO',
      marketId,
      `Convergencia de ${MARKET_LABEL[marketId]} alterada`,
      `Campos: ${changed.join(', ')}. O outro mercado nao foi afetado.`,
    );
    this.persistRuntime(true);
    this.runPipeline();
  }

  updateRiskSettings(marketId: MarketId, patch: Partial<RiskSettings>): void {
    const changed = Object.keys(patch);
    this.markets[marketId].risk = { ...this.markets[marketId].risk, ...patch };
    this.log(
      'SETTINGS_CHANGED',
      'INFO',
      marketId,
      `Risco de ${MARKET_LABEL[marketId]} alterado`,
      `Campos: ${changed.join(', ')}. O outro mercado nao foi afetado.`,
    );
    this.persistRuntime(true);
    this.runPipeline();
  }

  updateGlobalRiskSettings(patch: Partial<GlobalRiskSettings>): void {
    const changed = Object.keys(patch);
    this.globalRisk = { ...this.globalRisk, ...patch };
    this.log(
      'SETTINGS_CHANGED',
      'INFO',
      null,
      'Limites globais alterados',
      `Campos: ${changed.join(', ')}. Valem para os dois mercados.`,
    );
    this.persistRuntime(true);
    this.runPipeline();
  }

  setAccountForMarket(marketId: MarketId, accountId: string): { ok: boolean; message: string } {
    const broker = this.accounts.get(accountId);
    if (!broker) return { ok: false, message: 'Conta desconhecida.' };
    const account = broker.getAccount();
    if (!account.markets.includes(marketId)) {
      return {
        ok: false,
        message: `${account.brokerName} nao atende ${MARKET_LABEL[marketId]}.`,
      };
    }
    if (this.openPositionsOf(marketId).length > 0) {
      return {
        ok: false,
        message: `Existem posicoes abertas de ${MARKET_LABEL[marketId]} na conta atual. Encerre antes de trocar.`,
      };
    }
    this.markets[marketId].accountId = accountId;
    this.markets[marketId].day.baseEquity = account.equity;
    this.globalDay.baseEquity = this.consolidatedEquity();
    this.log(
      'SETTINGS_CHANGED',
      'INFO',
      marketId,
      `Conta de ${MARKET_LABEL[marketId]} alterada`,
      `Agora usando ${account.brokerName} (${account.accountId}, ${account.currency}).`,
    );
    this.persistRuntime(true);
    this.runPipeline();
    return { ok: true, message: 'Conta alterada.' };
  }

  async setConnected(accountId: string, connected: boolean): Promise<void> {
    const broker = this.accounts.get(accountId);
    if (!broker) return;
    if (connected) {
      await broker.connect();
      broker.failureMode = 'NONE';
      broker.freezeQuotes = false;
      this.log(
        'CONNECTION_RESTORED',
        'SUCCESS',
        null,
        `Conexao restabelecida em ${broker.getAccount().brokerName}`,
        'Cotacoes voltaram a atualizar.',
      );
    } else {
      broker.failureMode = 'DISCONNECTED';
      this.log(
        'CONNECTION_LOST',
        'BLOCK',
        null,
        `Conexao perdida em ${broker.getAccount().brokerName}`,
        'Novas ordens bloqueadas nos mercados que usam esta conta enquanto os dados estiverem indisponiveis.',
      );
    }
    this.runPipeline();
  }

  /** Liga todas as contas. Usado na subida do servidor e nos cenarios. */
  async connectAll(): Promise<void> {
    for (const accountId of this.accounts.keys()) await this.setConnected(accountId, true);
  }

  /** Passo do relogio: atualiza precos, expiracoes e reavalia o pipeline. */
  tick(elapsedSeconds: number): void {
    for (const broker of this.accounts.values()) broker.tick(elapsedSeconds);
    this.runPipeline();
    this.persistRuntime();
  }

  // --- Instantaneo -----------------------------------------------------------

  private marketSnapshot(marketId: MarketId) {
    const runtime = this.markets[marketId];
    const referenceQuotes: ReferenceQuotesSnapshot | null =
      marketId === 'FOREX' && this.referenceQuotes ? this.referenceQuotes.snapshot() : null;
    const cryptoQuotes: CryptoQuotesSnapshot | null =
      marketId === 'CRYPTO' && this.cryptoQuotes ? this.cryptoQuotes.snapshot() : null;
    const broker = this.brokerFor(marketId);
    const account = broker.getAccount();
    const openPositions = this.openPositionsOf(marketId);
    const positions = broker.getPositions().filter((p) => p.marketId === marketId);
    const daily = computeDailyResult(
      runtime.day,
      openPositions,
      runtime.risk.dailyLossLimitPercent,
      runtime.risk.dailyProfitTargetPercent,
    );
    const opportunities = this.opportunities.filter((o) => o.marketId === marketId);
    return {
      marketId,
      mode: runtime.mode,
      automationEnabled: runtime.automationEnabled,
      accountId: runtime.accountId,
      account,
      convergenceSettings: runtime.convergence,
      riskSettings: runtime.risk,
      instruments: instrumentsOfMarket(marketId),
      quotes: broker.getAllQuotes().filter((q) => getInstrument(q.symbol)?.marketId === marketId),
      referenceQuotes,
      cryptoQuotes,
      sources: this.sources.filter((s) => s.markets.includes(marketId)),
      signals: this.signals.filter((s) => s.marketId === marketId).slice(0, 120),
      opportunities: opportunities.slice(0, 60),
      evaluations: this.evaluations[marketId],
      orders: this.orders.filter((o) => o.marketId === marketId).slice(0, 60),
      positions,
      openPositions,
      events: this.events.filter((e) => e.marketId === marketId || e.marketId === null).slice(0, 120),
      day: runtime.day,
      daily,
    };
  }

  snapshot() {
    const accounts = this.activeAccounts().map((b) => b.getAccount());
    const consolidatedEquity = this.consolidatedEquity();
    return {
      now: this.clock.nowIso(),
      persistence: { enabled: this.store != null, path: this.store?.path ?? null },
      globalPaused: this.globalPaused,
      globalRisk: this.globalRisk,
      globalDay: this.globalDay,
      consolidated: {
        accounts,
        sharedAccount: this.markets.FOREX.accountId === this.markets.CRYPTO.accountId,
        equityInReference: Math.round(consolidatedEquity * 100) / 100,
        exposureInReference: Math.round(this.globalExposureNotional() * 100) / 100,
        openPositions: this.allOpenPositions().length,
        referenceCurrency: this.globalRisk.referenceCurrency,
        conversionNote: CONVERSION_NOTE,
      },
      brokerCatalog,
      availableAccounts: [...this.accounts.values()].map((b) => b.getAccount()),
      sources: this.sources,
      unclassifiedSources: this.sources.filter((s) => s.markets.length === 0),
      decisions: Object.fromEntries(this.decisions),
      awaitingConfirmation: [...this.awaitingConfirmation],
      events: this.events.slice(0, 160),
      markets: {
        FOREX: this.marketSnapshot('FOREX'),
        CRYPTO: this.marketSnapshot('CRYPTO'),
      },
    };
  }
}

export type Snapshot = ReturnType<Engine['snapshot']>;
