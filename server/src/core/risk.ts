import {
  notionalValue,
  pipValueUsd,
  pipsToPrice,
  requireInstrument,
  requiredMargin,
  roundLots,
  roundPrice,
} from './instruments.ts';
import { minutesBetween, minutesOfDay, parseHhMm, secondsBetween, zonedParts } from './time.ts';
import type {
  AccountSnapshot,
  CriterionCheck,
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

/**
 * Motor de risco e dimensionamento.
 *
 * Ordem dos portoes e proposital: primeiro integridade de dados e conexao, depois
 * limites do dia, depois limites estruturais, e por fim condicoes de mercado.
 * Todos os portoes sao avaliados mesmo quando ja houve bloqueio, para que a
 * interface mostre a lista completa de motivos em vez de apenas o primeiro.
 *
 * Nenhum modo operacional ignora estes portoes. "Executar sempre que convergir"
 * significa dispensar a confirmacao manual, nao dispensar limites de risco.
 */

export interface DayState {
  /** Chave do dia operacional no fuso configurado. */
  dayKey: string;
  /** Patrimonio na abertura do dia operacional, sem depositos e saques. */
  baseEquity: number;
  /** Resultado liquido realizado no dia (posicoes fechadas, ja com custos). */
  realizedNetPnl: number;
  /** Custos acumulados no dia. */
  costs: number;
  /** Depositos e saques do dia, contabilizados a parte do resultado. */
  cashFlows: number;
  tradesToday: number;
  lastEntryAt: string | null;
  consecutiveLosses: number;
  pausedUntil: string | null;
  /** Registrado quando um limite diario foi atingido. */
  dailyLimitHit: 'LOSS' | 'PROFIT' | null;
}

export interface RiskContext {
  nowIso: string;
  mode: OperationMode;
  automationPaused: boolean;
  settings: RiskSettings;
  account: AccountSnapshot;
  quote: Quote | null;
  openPositions: Position[];
  day: DayState;
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
  settings: RiskSettings,
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
    lossLimitValue: -(base * settings.dailyLossLimitPercent) / 100,
    profitTargetValue: (base * settings.dailyProfitTargetPercent) / 100,
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
    const dist = pipsToPrice(instrument, settings.defaultStopPips);
    stopPrice = side === 'BUY' ? entryPrice - dist : entryPrice + dist;
  }
  let tpPrice: number | null = settings.useSignalStops ? signalTakeProfit : null;
  if (tpPrice == null) {
    const dist = pipsToPrice(instrument, settings.defaultTakeProfitPips);
    tpPrice = side === 'BUY' ? entryPrice + dist : entryPrice - dist;
  }

  const stopPips = Math.abs(entryPrice - stopPrice) / instrument.pipSize;
  const takeProfitPips = Math.abs(tpPrice - entryPrice) / instrument.pipSize;

  let lots: number;
  let explanation: string;

  if (settings.sizingMode === 'FIXED_LOTS') {
    lots = settings.fixedLots;
    explanation = `Lote fixo de ${lots} definido na configuracao.`;
  } else {
    const riskBudget = (account.equity * settings.riskPercentPerTrade) / 100;
    const perLotRisk = pipValueUsd(instrument, 1) * stopPips;
    lots = perLotRisk > 0 ? riskBudget / perLotRisk : 0;
    explanation =
      `Risco de ${settings.riskPercentPerTrade}% sobre patrimonio de ${account.currency} ${account.equity.toFixed(2)} ` +
      `= ${account.currency} ${riskBudget.toFixed(2)}. Stop de ${stopPips.toFixed(1)} pips a ` +
      `${account.currency} ${pipValueUsd(instrument, 1).toFixed(2)} por pip por lote resulta em ${lots.toFixed(3)} lote(s).`;
  }

  lots = roundLots(instrument, Math.min(Math.max(lots, 0), instrument.maxLots));
  if (lots < instrument.minLots) lots = 0;

  const notional = notionalValue(instrument, lots, entryPrice);
  const risked = pipValueUsd(instrument, lots) * stopPips;

  return {
    mode: settings.sizingMode,
    lots,
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
  const { settings, account, quote, openPositions, day, nowIso } = ctx;
  const blocks: RiskBlock[] = [];
  const warnings: RiskBlock[] = [];
  const checks: CriterionCheck[] = [];

  const add = (passed: boolean, code: string, label: string, detail: string, hard = true) => {
    checks.push({ code, label, passed, detail });
    if (!passed) (hard ? blocks : warnings).push({ code, label, detail });
  };

  const instrument = requireInstrument(opportunity.symbol);

  // --- Modo operacional ------------------------------------------------------
  add(
    ctx.mode !== 'OBSERVE',
    'MODO_OBSERVACAO',
    'Modo operacional permite envio',
    ctx.mode === 'OBSERVE'
      ? 'Modo Observacao: oportunidades sao publicadas, nenhuma ordem e enviada.'
      : `Modo ${ctx.mode === 'AUTO' ? 'Autonomo' : 'Semiautomatico'} ativo.`,
  );

  add(
    !ctx.automationPaused,
    'AUTOMACAO_PAUSADA',
    'Automacao ativa',
    ctx.automationPaused ? 'Automacao pausada manualmente pelo usuario.' : 'Automacao nao esta pausada.',
  );

  // --- Integridade de dados e conexao ---------------------------------------
  add(
    account.connected,
    'SEM_CONEXAO',
    'Corretora conectada',
    account.connected
      ? `Conexao ativa com ${account.brokerId}.`
      : 'Sem conexao com a corretora. Nenhuma ordem e enviada com dados indisponiveis.',
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

  // --- Limites do dia --------------------------------------------------------
  const daily = computeDailyResult(day, openPositions, settings);
  const lossHit = daily.limitBasisPnl <= daily.lossLimitValue;
  const profitHit = daily.limitBasisPnl >= daily.profitTargetValue;
  add(
    !lossHit,
    'STOP_DIARIO',
    `Stop loss diario de ${settings.dailyLossLimitPercent}%`,
    lossHit
      ? `Resultado realizado ${daily.limitBasisPnl.toFixed(2)} atingiu o limite de ${daily.lossLimitValue.toFixed(2)}. Novas entradas bloqueadas ate a virada do dia.`
      : `Resultado realizado ${daily.limitBasisPnl.toFixed(2)} de um limite de ${daily.lossLimitValue.toFixed(2)}.`,
  );
  add(
    !profitHit,
    'STOP_WIN_DIARIO',
    `Stop win diario de ${settings.dailyProfitTargetPercent}%`,
    profitHit
      ? `Meta diaria de ${daily.profitTargetValue.toFixed(2)} atingida. Novas entradas bloqueadas.`
      : `Resultado realizado ${daily.limitBasisPnl.toFixed(2)} de uma meta de ${daily.profitTargetValue.toFixed(2)}.`,
  );

  add(
    day.tradesToday < settings.maxTradesPerDay,
    'LIMITE_OPERACOES_DIA',
    `Maximo de ${settings.maxTradesPerDay} operacoes por dia`,
    `${day.tradesToday} operacao(oes) abertas hoje (${day.dayKey}).`,
  );

  // --- Pausa por perdas consecutivas ----------------------------------------
  const paused = day.pausedUntil != null && Date.parse(day.pausedUntil) > Date.parse(nowIso);
  add(
    !paused,
    'PAUSA_POR_PERDAS',
    `Pausa apos ${settings.pauseAfterConsecutiveLosses} perdas consecutivas`,
    paused
      ? `Em pausa ate ${day.pausedUntil} apos ${day.consecutiveLosses} perdas seguidas.`
      : `${day.consecutiveLosses} perda(s) consecutiva(s).`,
  );

  // --- Intervalo entre entradas ---------------------------------------------
  const sinceLast = day.lastEntryAt == null ? Number.POSITIVE_INFINITY : minutesBetween(day.lastEntryAt, nowIso);
  add(
    sinceLast >= settings.minMinutesBetweenEntries,
    'INTERVALO_ENTRE_ENTRADAS',
    `Intervalo minimo de ${settings.minMinutesBetweenEntries} min entre entradas`,
    day.lastEntryAt == null
      ? 'Nenhuma entrada anterior no dia.'
      : `Ultima entrada ha ${sinceLast.toFixed(1)} min.`,
  );

  // --- Posicoes e exposicao --------------------------------------------------
  add(
    openPositions.length < settings.maxOpenPositions,
    'MAX_POSICOES',
    `Maximo de ${settings.maxOpenPositions} operacao(oes) aberta(s)`,
    `${openPositions.length} posicao(oes) aberta(s).`,
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
  add(
    dayAllowed && windowAllowed,
    'FORA_DE_HORARIO',
    'Dentro do horario permitido',
    !dayAllowed
      ? `Dia da semana ${parts.weekday} fora dos dias permitidos (forex spot nao negocia no fim de semana).`
      : windowAllowed
        ? `Horario ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')} (${settings.tradingTimezone}) dentro das faixas configuradas.`
        : `Horario ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')} (${settings.tradingTimezone}) fora das faixas configuradas.`,
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
    const deviationPips = Math.abs(marketPrice - opportunity.referenceEntry) / instrument.pipSize;
    add(
      deviationPips <= settings.maxPriceDeviationPips,
      'DESVIO_DE_PRECO',
      `Desvio maximo de ${settings.maxPriceDeviationPips} pips`,
      `Preco atual ${marketPrice.toFixed(instrument.digits)} esta a ${deviationPips.toFixed(1)} pips da referencia ${opportunity.referenceEntry.toFixed(instrument.digits)}.`,
    );
  }

  // --- Dimensionamento -------------------------------------------------------
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
      sizing.lots >= instrument.minLots,
      'VOLUME_INVALIDO',
      'Volume calculado utilizavel',
      sizing.lots < instrument.minLots
        ? `Volume calculado ${sizing.lots} abaixo do lote minimo ${instrument.minLots} do instrumento.`
        : `Volume ${sizing.lots} lote(s). Valor nocional ${account.currency} ${sizing.notionalValue.toFixed(2)}, valor arriscado ${account.currency} ${sizing.riskedValue.toFixed(2)}.`,
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

    const totalExposure = openPositions.reduce((s, p) => s + p.notionalValue, 0);
    add(
      totalExposure + sizing.notionalValue <= settings.maxTotalExposureNotional,
      'EXPOSICAO_TOTAL',
      `Exposicao maxima total de ${settings.maxTotalExposureNotional}`,
      `Exposicao total: ${totalExposure.toFixed(0)} aberta + ${sizing.notionalValue.toFixed(0)} da nova ordem.`,
    );

    const margin = requiredMargin(instrument, sizing.lots, marketPrice);
    add(
      margin <= account.freeMargin,
      'MARGEM_INSUFICIENTE',
      'Margem livre suficiente',
      `Margem exigida ${account.currency} ${margin.toFixed(2)} contra margem livre ${account.currency} ${account.freeMargin.toFixed(2)}.`,
    );
  }

  if (settings.martingaleEnabled) {
    warnings.push({
      code: 'MARTINGALE_ATIVO',
      label: 'Martingale ativo',
      detail:
        'Aumento de volume apos perdas esta habilitado. Concentra o risco de ruina em poucas sequencias adversas.',
    });
  }

  return { allowed: blocks.length === 0, blocks, warnings, checks, sizing };
}
