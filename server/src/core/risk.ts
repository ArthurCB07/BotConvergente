import {
  notionalValue,
  pipSizeFor,
  pipValue,
  pipsToPrice,
  requireInstrument,
  requiredMargin,
  roundPrice,
  roundQuantity,
} from './instruments.ts';
import { minutesBetween, minutesOfDay, parseHhMm, secondsBetween, zonedParts } from './time.ts';
import type {
  AccountSnapshot,
  CriterionCheck,
  GlobalRiskSettings,
  MarketId,
  OperationMode,
  Opportunity,
  Position,
  Quote,
  RiskBlock,
  RiskDecision,
  RiskSettings,
  Side,
  SizingResult,
} from './types.ts';
import { MARKET_LABEL } from './types.ts';

/**
 * Motor de risco e dimensionamento.
 *
 * Avalia SEMPRE no contexto de um mercado, e sempre com os limites globais por
 * cima. Ordem dos portoes: integridade de dados e conexao, suporte do instrumento,
 * limites do dia do mercado, limites estruturais do mercado, limites globais e por
 * fim condicoes de mercado e dimensionamento.
 *
 * Todos os portoes sao avaliados mesmo quando ja houve bloqueio, para que a
 * interface mostre a lista completa de motivos em vez de apenas o primeiro.
 *
 * Nenhum modo operacional ignora estes portoes, e nenhum mercado ignora um limite
 * global. "Executar sempre que convergir" dispensa a confirmacao manual, nao os
 * limites de risco.
 */

export interface DayState {
  /** Chave do dia operacional no fuso configurado. */
  dayKey: string;
  /** Patrimonio da conta do mercado na abertura do dia, sem depositos e saques. */
  baseEquity: number;
  /** Resultado liquido realizado no dia, neste mercado. */
  realizedNetPnl: number;
  costs: number;
  cashFlows: number;
  tradesToday: number;
  lastEntryAt: string | null;
  consecutiveLosses: number;
  pausedUntil: string | null;
  dailyLimitHit: 'LOSS' | 'PROFIT' | null;
}

/** Estado diario consolidado dos dois mercados, na moeda de referencia. */
export interface GlobalDayState {
  dayKey: string;
  baseEquity: number;
  realizedNetPnl: number;
  tradesToday: number;
  dailyLimitHit: 'LOSS' | 'PROFIT' | null;
  /** Descreve a conversao usada para consolidar contas de moedas diferentes. */
  conversionNote: string;
}

export interface RiskContext {
  nowIso: string;
  marketId: MarketId;
  /** Quem pediu o envio. Automacao desligada nao impede confirmacao manual. */
  origin: 'AUTO' | 'MANUAL';
  mode: OperationMode;
  /** Automacao deste mercado. */
  automationEnabled: boolean;
  /** Pausa global de novas entradas automaticas nos dois mercados. */
  globalPaused: boolean;
  settings: RiskSettings;
  globalSettings: GlobalRiskSettings;
  account: AccountSnapshot;
  quote: Quote | null;
  /** Posicoes abertas DESTE mercado. */
  openPositions: Position[];
  /** Posicoes abertas dos dois mercados, ja convertidas para a moeda de referencia. */
  allOpenPositions: Position[];
  /** Exposicao total dos dois mercados, na moeda de referencia. */
  globalExposureNotional: number;
  day: DayState;
  globalDay: GlobalDayState;
  /** A conta escolhida para este mercado negocia este instrumento? */
  accountSupportsSymbol: boolean;
  /** Execucoes ja disparadas por esta oportunidade. */
  executionsForOpportunity: number;
}

/** Resultado do dia, com a composicao explicita de cada parcela. */
export interface DailyResult {
  dayKey: string;
  baseEquity: number;
  realizedNetPnl: number;
  unrealizedPnl: number;
  costs: number;
  cashFlows: number;
  /** Base usada para os limites diarios: apenas o realizado. */
  limitBasisPnl: number;
  limitBasisPercent: number;
  /** Visao completa, incluindo posicoes abertas. Informativa. */
  totalWithOpenPnl: number;
  totalWithOpenPercent: number;
  lossLimitValue: number;
  profitTargetValue: number;
}

export function computeDailyResult(
  day: DayState,
  openPositions: Position[],
  lossLimitPercent: number,
  profitTargetPercent: number,
): DailyResult {
  const unrealizedPnl = openPositions.reduce((s, p) => s + p.netPnl, 0);
  const limitBasisPnl = day.realizedNetPnl;
  const base = day.baseEquity || 1;
  return {
    dayKey: day.dayKey,
    baseEquity: day.baseEquity,
    realizedNetPnl: day.realizedNetPnl,
    unrealizedPnl,
    costs: day.costs,
    cashFlows: day.cashFlows,
    limitBasisPnl,
    limitBasisPercent: (limitBasisPnl / base) * 100,
    totalWithOpenPnl: limitBasisPnl + unrealizedPnl,
    totalWithOpenPercent: ((limitBasisPnl + unrealizedPnl) / base) * 100,
    lossLimitValue: -(base * lossLimitPercent) / 100,
    profitTargetValue: (base * profitTargetPercent) / 100,
  };
}

// ---------------------------------------------------------------------------
// Dimensionamento
// ---------------------------------------------------------------------------

export function computeSizing(
  symbol: string,
  side: Side,
  entryPrice: number,
  signalStopLoss: number | null,
  signalTakeProfit: number | null,
  settings: RiskSettings,
  account: AccountSnapshot,
): SizingResult {
  const instrument = requireInstrument(symbol);

  let stopPrice: number | null = settings.useSignalStops ? signalStopLoss : null;
  if (stopPrice == null) {
    const dist = pipsToPrice(instrument, settings.defaultStopPips, entryPrice);
    stopPrice = side === 'BUY' ? entryPrice - dist : entryPrice + dist;
  }
  let tpPrice: number | null = settings.useSignalStops ? signalTakeProfit : null;
  if (tpPrice == null) {
    const dist = pipsToPrice(instrument, settings.defaultTakeProfitPips, entryPrice);
    tpPrice = side === 'BUY' ? entryPrice + dist : entryPrice - dist;
  }

  const pip = pipSizeFor(instrument, entryPrice);
  const stopPips = Math.abs(entryPrice - stopPrice) / pip;
  const takeProfitPips = Math.abs(tpPrice - entryPrice) / pip;

  let quantity: number;
  let explanation: string;

  if (settings.sizingMode === 'FIXED_QUANTITY') {
    quantity = settings.fixedQuantity;
    explanation = `Quantidade fixa de ${quantity} ${instrument.quantityLabel} definida na configuracao de ${MARKET_LABEL[instrument.marketId]}.`;
  } else {
    const riskBudget = (account.equity * settings.riskPercentPerTrade) / 100;
    const perUnitRisk = pipValue(instrument, 1, entryPrice) * stopPips;
    quantity = perUnitRisk > 0 ? riskBudget / perUnitRisk : 0;
    explanation =
      `Risco de ${settings.riskPercentPerTrade}% sobre patrimonio de ${account.currency} ${account.equity.toFixed(2)} ` +
      `= ${account.currency} ${riskBudget.toFixed(2)}. Stop de ${stopPips.toFixed(1)} pips a ` +
      `${account.currency} ${pipValue(instrument, 1, entryPrice).toFixed(4)} por pip por ${instrument.quantityLabel} ` +
      `resulta em ${quantity.toFixed(6)} ${instrument.quantityLabel}.`;
  }

  quantity = roundQuantity(instrument, Math.min(Math.max(quantity, 0), instrument.maxQuantity));
  if (quantity < instrument.minQuantity) quantity = 0;

  const notional = notionalValue(instrument, quantity, entryPrice);
  const risked = pipValue(instrument, quantity, entryPrice) * stopPips;

  return {
    mode: settings.sizingMode,
    quantity,
    quantityLabel: instrument.quantityLabel,
    notionalValue: Math.round(notional * 100) / 100,
    riskedValue: Math.round(risked * 100) / 100,
    stopPips: Math.round(stopPips * 10) / 10,
    takeProfitPips: Math.round(takeProfitPips * 10) / 10,
    stopLossPrice: roundPrice(instrument, stopPrice),
    takeProfitPrice: roundPrice(instrument, tpPrice),
    explanation,
  };
}

// ---------------------------------------------------------------------------
// Portoes de risco
// ---------------------------------------------------------------------------

export function evaluateRisk(opportunity: Opportunity, ctx: RiskContext): RiskDecision {
  const { settings, globalSettings, account, quote, openPositions, day, globalDay, nowIso } = ctx;
  const blocks: RiskBlock[] = [];
  const warnings: RiskBlock[] = [];
  const checks: CriterionCheck[] = [];
  const marketLabel = MARKET_LABEL[ctx.marketId];

  const add = (
    passed: boolean,
    code: string,
    label: string,
    detail: string,
    scope: 'MARKET' | 'GLOBAL' = 'MARKET',
    hard = true,
  ) => {
    checks.push({ code, label, passed, detail });
    if (!passed) (hard ? blocks : warnings).push({ code, label, detail, scope });
  };

  const instrument = requireInstrument(opportunity.symbol);

  // --- Modo operacional e automacao -----------------------------------------
  add(
    ctx.mode !== 'OBSERVE',
    'MODO_OBSERVACAO',
    `Modo operacional de ${marketLabel} permite envio`,
    ctx.mode === 'OBSERVE'
      ? `Modo Observacao em ${marketLabel}: oportunidades sao publicadas, nenhuma ordem e enviada.`
      : `Modo ${ctx.mode === 'AUTO' ? 'Autonomo' : 'Semiautomatico'} ativo em ${marketLabel}.`,
  );

  /*
   * Automacao e pausa global travam apenas o envio AUTOMATICO. Confirmacao manual
   * continua valendo: desligar a automacao nao e o mesmo que proibir o operador.
   */
  if (ctx.origin === 'AUTO') {
    add(
      ctx.automationEnabled,
      'AUTOMACAO_MERCADO_DESLIGADA',
      `Automacao de ${marketLabel} ligada`,
      ctx.automationEnabled
        ? `Automacao de ${marketLabel} ligada.`
        : `Automacao de ${marketLabel} desligada. Sinais continuam chegando, oportunidades continuam aparecendo e as posicoes abertas seguem sendo geridas.`,
    );
    add(
      !ctx.globalPaused,
      'PAUSA_GLOBAL',
      'Pausa global inativa',
      ctx.globalPaused
        ? 'Pausa global ativa: novas entradas automaticas bloqueadas nos dois mercados.'
        : 'Nenhuma pausa global ativa.',
      'GLOBAL',
    );
  } else {
    if (!ctx.automationEnabled) {
      warnings.push({
        code: 'AUTOMACAO_MERCADO_DESLIGADA',
        label: `Automacao de ${marketLabel} desligada`,
        detail: 'Esta ordem sai por confirmacao manual, nao pela automacao.',
        scope: 'MARKET',
      });
    }
    if (ctx.globalPaused) {
      warnings.push({
        code: 'PAUSA_GLOBAL',
        label: 'Pausa global ativa',
        detail: 'A pausa global impede envios automaticos. Esta ordem e manual.',
        scope: 'GLOBAL',
      });
    }
  }

  // --- Integridade de dados e conexao ---------------------------------------
  add(
    account.connected,
    'SEM_CONEXAO',
    'Conexao do mercado ativa',
    account.connected
      ? `Conexao ativa com ${account.brokerName} (conta ${account.accountId}).`
      : `Sem conexao com a conta de ${marketLabel}. Nenhuma ordem e enviada com dados indisponiveis.`,
  );

  add(
    ctx.accountSupportsSymbol,
    'INSTRUMENTO_NAO_SUPORTADO',
    'Conexao suporta o instrumento',
    ctx.accountSupportsSymbol
      ? `${account.brokerName} negocia ${opportunity.symbol}.`
      : `${account.brokerName} nao negocia ${opportunity.symbol}. Uma conexao de um mercado nao opera o outro automaticamente.`,
  );

  const quoteAge = quote ? secondsBetween(quote.at, nowIso) : Number.POSITIVE_INFINITY;
  add(
    quote != null && quoteAge <= settings.maxQuoteAgeSeconds,
    'COTACAO_DESATUALIZADA',
    'Cotacao atual disponivel',
    quote == null
      ? 'Nenhuma cotacao recebida para o instrumento.'
      : `Ultima cotacao ha ${quoteAge.toFixed(0)} s (limite ${settings.maxQuoteAgeSeconds} s).`,
  );

  // --- Validade da oportunidade ---------------------------------------------
  const expired = Date.parse(opportunity.validUntil) <= Date.parse(nowIso);
  add(
    !expired,
    'OPORTUNIDADE_EXPIRADA',
    'Oportunidade dentro da validade',
    expired
      ? `Validade encerrada em ${opportunity.validUntil}.`
      : `Valida por mais ${Math.max(0, minutesBetween(nowIso, opportunity.validUntil)).toFixed(1)} min.`,
  );

  // --- Idempotencia ----------------------------------------------------------
  add(
    ctx.executionsForOpportunity < settings.maxExecutionsPerOpportunity,
    'LIMITE_EXECUCOES_OPORTUNIDADE',
    'Execucoes por oportunidade',
    `${ctx.executionsForOpportunity} de ${settings.maxExecutionsPerOpportunity} execucao(oes) usada(s). Atualizacoes da mesma convergencia nao geram entrada adicional.`,
  );

  // --- Limites do dia do mercado --------------------------------------------
  const daily = computeDailyResult(
    day,
    openPositions,
    settings.dailyLossLimitPercent,
    settings.dailyProfitTargetPercent,
  );
  add(
    daily.limitBasisPnl > daily.lossLimitValue,
    'STOP_DIARIO',
    `Stop loss diario de ${marketLabel} (${settings.dailyLossLimitPercent}%)`,
    daily.limitBasisPnl <= daily.lossLimitValue
      ? `Resultado realizado de ${marketLabel} ${daily.limitBasisPnl.toFixed(2)} atingiu o limite de ${daily.lossLimitValue.toFixed(2)}. Novas entradas deste mercado bloqueadas ate a virada do dia.`
      : `Resultado realizado ${daily.limitBasisPnl.toFixed(2)} de um limite de ${daily.lossLimitValue.toFixed(2)}.`,
  );
  add(
    daily.limitBasisPnl < daily.profitTargetValue,
    'STOP_WIN_DIARIO',
    `Stop win diario de ${marketLabel} (${settings.dailyProfitTargetPercent}%)`,
    daily.limitBasisPnl >= daily.profitTargetValue
      ? `Meta diaria de ${marketLabel} (${daily.profitTargetValue.toFixed(2)}) atingida. Novas entradas deste mercado bloqueadas.`
      : `Resultado realizado ${daily.limitBasisPnl.toFixed(2)} de uma meta de ${daily.profitTargetValue.toFixed(2)}.`,
  );

  add(
    day.tradesToday < settings.maxTradesPerDay,
    'LIMITE_OPERACOES_DIA',
    `Maximo de ${settings.maxTradesPerDay} operacoes por dia em ${marketLabel}`,
    `${day.tradesToday} operacao(oes) abertas hoje em ${marketLabel} (${day.dayKey}).`,
  );

  const paused = day.pausedUntil != null && Date.parse(day.pausedUntil) > Date.parse(nowIso);
  add(
    !paused,
    'PAUSA_POR_PERDAS',
    `Pausa apos ${settings.pauseAfterConsecutiveLosses} perdas consecutivas`,
    paused
      ? `${marketLabel} em pausa ate ${day.pausedUntil} apos ${day.consecutiveLosses} perdas seguidas.`
      : `${day.consecutiveLosses} perda(s) consecutiva(s) em ${marketLabel}.`,
  );

  const sinceLast =
    day.lastEntryAt == null ? Number.POSITIVE_INFINITY : minutesBetween(day.lastEntryAt, nowIso);
  add(
    sinceLast >= settings.minMinutesBetweenEntries,
    'INTERVALO_ENTRE_ENTRADAS',
    `Intervalo minimo de ${settings.minMinutesBetweenEntries} min entre entradas de ${marketLabel}`,
    day.lastEntryAt == null
      ? `Nenhuma entrada anterior em ${marketLabel} hoje.`
      : `Ultima entrada de ${marketLabel} ha ${sinceLast.toFixed(1)} min.`,
  );

  add(
    openPositions.length < settings.maxOpenPositions,
    'MAX_POSICOES',
    `Maximo de ${settings.maxOpenPositions} operacao(oes) aberta(s) em ${marketLabel}`,
    `${openPositions.length} posicao(oes) aberta(s) em ${marketLabel}.`,
  );

  // --- Janela de horario -----------------------------------------------------
  const parts = zonedParts(nowIso, settings.tradingTimezone);
  const dayAllowed = settings.tradingDays.includes(parts.weekday);
  const nowMin = minutesOfDay(nowIso, settings.tradingTimezone);
  const windowAllowed = settings.tradingWindows.some((w) => {
    const start = parseHhMm(w.start);
    const end = parseHhMm(w.end);
    return start <= end ? nowMin >= start && nowMin <= end : nowMin >= start || nowMin <= end;
  });
  const hhmm = `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
  add(
    dayAllowed && windowAllowed,
    'FORA_DE_HORARIO',
    `Dentro do horario permitido de ${marketLabel}`,
    !dayAllowed
      ? `Dia da semana ${parts.weekday} fora dos dias permitidos de ${marketLabel}${instrument.tradesAllWeek ? '.' : ' (mercado fechado no fim de semana).'}`
      : windowAllowed
        ? `Horario ${hhmm} (${settings.tradingTimezone}) dentro das faixas configuradas.`
        : `Horario ${hhmm} (${settings.tradingTimezone}) fora das faixas configuradas de ${marketLabel}.`,
  );

  // --- Condicoes de mercado --------------------------------------------------
  if (quote) {
    add(
      quote.spreadPips <= settings.maxSpreadPips,
      'SPREAD_ALTO',
      `Spread maximo de ${settings.maxSpreadPips} pips`,
      `Spread atual ${quote.spreadPips.toFixed(1)} pips.`,
    );
  }

  const marketPrice = quote ? (opportunity.side === 'BUY' ? quote.ask : quote.bid) : null;
  if (quote && marketPrice != null && opportunity.referenceEntry != null) {
    const deviationPips =
      Math.abs(marketPrice - opportunity.referenceEntry) / pipSizeFor(instrument, marketPrice);
    add(
      deviationPips <= settings.maxPriceDeviationPips,
      'DESVIO_DE_PRECO',
      `Desvio maximo de ${settings.maxPriceDeviationPips} pips`,
      `Preco atual ${marketPrice.toFixed(instrument.digits)} esta a ${deviationPips.toFixed(1)} pips da referencia ${opportunity.referenceEntry.toFixed(instrument.digits)}.`,
    );
  }

  // --- Dimensionamento e exposicao -------------------------------------------
  let sizing: SizingResult | null = null;
  if (marketPrice != null) {
    sizing = computeSizing(
      opportunity.symbol,
      opportunity.side,
      opportunity.referenceEntry ?? marketPrice,
      opportunity.suggestedStopLoss,
      opportunity.suggestedTakeProfit,
      settings,
      account,
    );

    add(
      sizing.quantity >= instrument.minQuantity,
      'QUANTIDADE_INVALIDA',
      'Quantidade calculada utilizavel',
      sizing.quantity < instrument.minQuantity
        ? `Quantidade calculada ${sizing.quantity} abaixo do minimo ${instrument.minQuantity} ${instrument.quantityLabel} do instrumento.`
        : `${sizing.quantity} ${instrument.quantityLabel}, passo ${instrument.quantityStep}. Valor nocional ${account.currency} ${sizing.notionalValue.toFixed(2)}, valor arriscado ${account.currency} ${sizing.riskedValue.toFixed(2)}.`,
    );

    add(
      instrument.minNotional === 0 || sizing.notionalValue >= instrument.minNotional,
      'NOCIONAL_MINIMO',
      'Valor minimo da ordem atendido',
      instrument.minNotional === 0
        ? 'Instrumento sem valor minimo por ordem.'
        : `Nocional ${sizing.notionalValue.toFixed(2)} contra minimo de ${instrument.minNotional} exigido pela venue.`,
    );

    const symbolExposure = openPositions
      .filter((p) => p.symbol === opportunity.symbol)
      .reduce((s, p) => s + p.notionalValue, 0);
    add(
      symbolExposure + sizing.notionalValue <= settings.maxExposurePerSymbolNotional,
      'EXPOSICAO_ATIVO',
      `Exposicao maxima por ativo de ${settings.maxExposurePerSymbolNotional}`,
      `Exposicao em ${opportunity.symbol}: ${symbolExposure.toFixed(0)} aberta + ${sizing.notionalValue.toFixed(0)} da nova ordem.`,
    );

    const marketExposure = openPositions.reduce((s, p) => s + p.notionalValue, 0);
    add(
      marketExposure + sizing.notionalValue <= settings.maxTotalExposureNotional,
      'EXPOSICAO_MERCADO',
      `Exposicao maxima de ${marketLabel} (${settings.maxTotalExposureNotional})`,
      `Exposicao de ${marketLabel}: ${marketExposure.toFixed(0)} aberta + ${sizing.notionalValue.toFixed(0)} da nova ordem.`,
    );

    const margin = requiredMargin(instrument, sizing.quantity, marketPrice);
    add(
      margin <= account.freeMargin,
      'MARGEM_INSUFICIENTE',
      'Margem livre suficiente',
      `Margem exigida ${account.currency} ${margin.toFixed(2)} contra margem livre ${account.currency} ${account.freeMargin.toFixed(2)}` +
        (account.reservedMargin > 0
          ? `, ja descontada a reserva de ${account.reservedMargin.toFixed(2)} de ordens em voo.`
          : '.'),
    );

    // --- Limites globais -----------------------------------------------------
    if (globalSettings.enabled) {
      add(
        ctx.allOpenPositions.length < globalSettings.maxOpenPositionsTotal,
        'MAX_POSICOES_GLOBAL',
        `Maximo global de ${globalSettings.maxOpenPositionsTotal} operacao(oes) aberta(s)`,
        `${ctx.allOpenPositions.length} posicao(oes) aberta(s) somando Forex e Cripto.`,
        'GLOBAL',
      );
      add(
        ctx.globalExposureNotional + sizing.notionalValue <= globalSettings.maxTotalExposureNotional,
        'EXPOSICAO_GLOBAL',
        `Exposicao global maxima de ${globalSettings.maxTotalExposureNotional} ${globalSettings.referenceCurrency}`,
        `Exposicao somada: ${ctx.globalExposureNotional.toFixed(0)} aberta + ${sizing.notionalValue.toFixed(0)} da nova ordem. ${globalDay.conversionNote}`,
        'GLOBAL',
      );

      const globalBase = globalDay.baseEquity || 1;
      const globalLossLimit = -(globalBase * globalSettings.dailyLossLimitPercent) / 100;
      const globalProfitTarget = (globalBase * globalSettings.dailyProfitTargetPercent) / 100;
      add(
        globalDay.realizedNetPnl > globalLossLimit,
        'STOP_DIARIO_GLOBAL',
        `Stop loss diario global (${globalSettings.dailyLossLimitPercent}%)`,
        globalDay.realizedNetPnl <= globalLossLimit
          ? `Resultado realizado consolidado ${globalDay.realizedNetPnl.toFixed(2)} atingiu o limite global de ${globalLossLimit.toFixed(2)}. Novas entradas bloqueadas nos DOIS mercados. ${globalDay.conversionNote}`
          : `Resultado consolidado ${globalDay.realizedNetPnl.toFixed(2)} de um limite global de ${globalLossLimit.toFixed(2)}.`,
        'GLOBAL',
      );
      add(
        globalDay.realizedNetPnl < globalProfitTarget,
        'STOP_WIN_DIARIO_GLOBAL',
        `Stop win diario global (${globalSettings.dailyProfitTargetPercent}%)`,
        globalDay.realizedNetPnl >= globalProfitTarget
          ? `Meta global de ${globalProfitTarget.toFixed(2)} atingida. Novas entradas bloqueadas nos DOIS mercados.`
          : `Resultado consolidado ${globalDay.realizedNetPnl.toFixed(2)} de uma meta global de ${globalProfitTarget.toFixed(2)}.`,
        'GLOBAL',
      );
    }
  }

  if (settings.martingaleEnabled) {
    warnings.push({
      code: 'MARTINGALE_ATIVO',
      label: 'Martingale ativo',
      detail:
        'Aumento de volume apos perdas esta habilitado. Concentra o risco de ruina em poucas sequencias adversas.',
      scope: 'MARKET',
    });
  }

  return { allowed: blocks.length === 0, blocks, warnings, checks, sizing };
}
