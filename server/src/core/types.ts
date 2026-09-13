/**
 * Modelo de dominio do MVP.
 *
 * Escopo declarado: FOREX SPOT (pares major). O campo `market` existe para permitir
 * expansao futura, mas o motor de convergencia recusa comparar sinais de mercados
 * ou ambientes de negociacao diferentes (ver `core/convergence.ts`).
 */

export type Market = 'FX_SPOT';

/** Ambiente de negociacao. OTC e REGULAR nunca sao comparados entre si. */
export type Venue = 'REGULAR' | 'OTC';

export type Side = 'BUY' | 'SELL';

export type EntryType = 'MARKET' | 'LIMIT' | 'RANGE';

/** Como a mensagem bruta virou um sinal normalizado. */
export type ParserKind = 'MANUAL' | 'GENERATOR' | 'WEBHOOK' | 'AI_ASSISTED';

export type SignalStatus =
  | 'VALID'
  | 'INCOMPLETE'
  | 'AMBIGUOUS'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'SUPERSEDED'
  | 'DUPLICATE'
  | 'REJECTED';

export interface SignalIssue {
  code: string;
  /** Texto em pt-BR exibido na interface. */
  message: string;
  severity: 'INFO' | 'WARN' | 'BLOCK';
}

/** Mensagem bruta preservada exatamente como chegou. */
export interface RawMessage {
  text: string;
  /** Identificador da mensagem na origem (id do Telegram, id do webhook, etc.). */
  externalMessageId: string | null;
  /** Carga original do conector, sem transformacao. */
  payload?: Record<string, unknown>;
}

export interface Signal {
  id: string;
  sourceId: string;
  /**
   * Grupo de independencia: fontes que compartilham a mesma origem (mesmo analista,
   * revenda de sinal, espelho de canal) recebem o mesmo valor e contam como UM voto.
   */
  independenceGroupId: string;
  raw: RawMessage;
  parsedBy: ParserKind;
  /** Confianca do interpretador de linguagem natural, quando houver. 0..1 */
  parserConfidence: number | null;

  market: Market;
  symbol: string;
  venue: Venue;
  broker: string | null;

  side: Side | null;
  /** ISO-8601 com offset. */
  emittedAt: string | null;
  receivedAt: string;
  entryAt: string | null;
  timezone: string;

  timeframeMinutes: number | null;
  /** Horizonte esperado da operacao em minutos. Usado para comparar compatibilidade. */
  horizonMinutes: number | null;
  validUntil: string | null;

  entryType: EntryType;
  entryPrice: number | null;
  entryMin: number | null;
  entryMax: number | null;
  stopLoss: number | null;
  takeProfit: number | null;

  status: SignalStatus;
  issues: SignalIssue[];

  /** Versao do sinal: edicoes da mesma mensagem incrementam. */
  version: number;
  /** Sinal que este substitui (edicao/correcao). */
  supersedesSignalId: string | null;
  /** Sinal que substituiu este. */
  supersededBySignalId: string | null;
}

export interface Source {
  id: string;
  name: string;
  kind: 'GENERATOR' | 'MANUAL' | 'WEBHOOK' | 'TELEGRAM' | 'DISCORD' | 'API';
  enabled: boolean;
  /** Etiquetas livres do usuario. Nao afetam a contagem de votos. */
  tags: string[];
  /**
   * Grupo de independencia. Fontes com o mesmo valor contam como UM voto.
   * Por padrao vale o proprio id: presume-se independencia apenas enquanto o
   * usuario nao declarar o contrario.
   */
  independenceGroupId: string;
  weight: number;
  /** Token do webhook, quando kind === 'WEBHOOK'. Nunca exposto em logs. */
  webhookToken?: string;
  notes: string;
  createdAt: string;
  stats: {
    received: number;
    valid: number;
    rejected: number;
    lastSignalAt: string | null;
  };
}

// ---------------------------------------------------------------------------
// Convergencia
// ---------------------------------------------------------------------------

export type CriteriaMode = 'COUNT' | 'PERCENT' | 'BOTH';

export type OpposingPolicy =
  | 'IGNORE_IN_DENOMINATOR'
  | 'COUNT_IN_DENOMINATOR'
  | 'BLOCK_IF_ANY'
  | 'BLOCK_ABOVE_RATIO';

export interface ConvergenceSettings {
  minAgreeingSources: number;
  minAgreementPercent: number;
  criteriaMode: CriteriaMode;
  /** Janela de agrupamento: sinais dentro deste intervalo sao comparados. */
  groupingWindowMinutes: number;
  /** Idade maxima de um sinal para continuar votando. */
  maxSignalAgeMinutes: number;
  includedSourceIds: string[] | null;
  excludedSourceIds: string[];
  opposingPolicy: OpposingPolicy;
  /** Usado quando opposingPolicy === 'BLOCK_ABOVE_RATIO'. 0..1 */
  opposingBlockRatio: number;
  /** Tolerancia entre precos de entrada, em pips do instrumento. */
  entryTolerancePips: number;
  requireCompatibleTimeframe: boolean;
  /** Razao maxima entre o maior e o menor horizonte para serem compativeis. */
  horizonRatioTolerance: number;
  /** Validade da oportunidade publicada. */
  opportunityTtlMinutes: number;
  useSourceWeights: boolean;
}

export interface VoteDetail {
  sourceId: string;
  sourceName: string;
  independenceGroupId: string;
  signalId: string;
  side: Side;
  entryPrice: number | null;
  emittedAt: string | null;
  receivedAt: string;
  weight: number;
  /** Motivo de o voto nao ter sido contado como concordante, quando aplicavel. */
  excludedReason: string | null;
}

export interface NonParticipant {
  sourceId: string;
  sourceName: string;
  reason: string;
}

export interface CriterionCheck {
  code: string;
  label: string;
  passed: boolean;
  detail: string;
}

export type OpportunityStatus =
  | 'PUBLISHED'
  | 'UPDATED'
  | 'EXPIRED'
  | 'EXECUTED'
  | 'BLOCKED'
  | 'REJECTED_BY_USER'
  | 'CANCELLED';

export interface Opportunity {
  id: string;
  /** Chave estavel da convergencia. Atualizacoes reusam a mesma chave. */
  clusterKey: string;
  version: number;
  market: Market;
  symbol: string;
  venue: Venue;
  side: Side;
  createdAt: string;
  updatedAt: string;
  validUntil: string;
  status: OpportunityStatus;

  referenceEntry: number | null;
  suggestedStopLoss: number | null;
  suggestedTakeProfit: number | null;

  agreeing: VoteDetail[];
  dissenting: VoteDetail[];
  /** Fontes com sinal na janela porem nao comparaveis. */
  notComparable: VoteDetail[];
  nonParticipants: NonParticipant[];

  participantCount: number;
  agreeingCount: number;
  agreementPercent: number;
  weightedAgreementPercent: number;
  registeredActiveSources: number;

  criteria: CriterionCheck[];
  summary: string;
  /** Quantas execucoes ja foram disparadas por esta oportunidade. */
  executionCount: number;
  signalIds: string[];
}

// ---------------------------------------------------------------------------
// Risco e execucao
// ---------------------------------------------------------------------------

export type OperationMode = 'OBSERVE' | 'SEMI_AUTO' | 'AUTO';

export type SizingMode = 'FIXED_LOTS' | 'RISK_PERCENT';

export interface RiskSettings {
  sizingMode: SizingMode;
  fixedLots: number;
  riskPercentPerTrade: number;
  defaultStopPips: number;
  defaultTakeProfitPips: number;
  useSignalStops: boolean;

  maxOpenPositions: number;
  maxExposurePerSymbolNotional: number;
  maxTotalExposureNotional: number;
  maxTradesPerDay: number;
  minMinutesBetweenEntries: number;
  pauseAfterConsecutiveLosses: number;
  pauseMinutes: number;

  dailyLossLimitPercent: number;
  dailyProfitTargetPercent: number;
  onDailyLimitCancelPending: boolean;
  onDailyLimitClosePositions: boolean;

  tradingTimezone: string;
  tradingWindows: Array<{ start: string; end: string }>;
  /** 1 = segunda ... 7 = domingo. */
  tradingDays: number[];

  maxSpreadPips: number;
  maxPriceDeviationPips: number;
  maxQuoteAgeSeconds: number;
  maxExecutionsPerOpportunity: number;
  martingaleEnabled: boolean;
}

export interface RiskBlock {
  code: string;
  label: string;
  detail: string;
}

export interface SizingResult {
  mode: SizingMode;
  lots: number;
  notionalValue: number;
  riskedValue: number;
  stopPips: number | null;
  takeProfitPips: number | null;
  stopLossPrice: number | null;
  takeProfitPrice: number | null;
  explanation: string;
}

export interface RiskDecision {
  allowed: boolean;
  blocks: RiskBlock[];
  warnings: RiskBlock[];
  checks: CriterionCheck[];
  sizing: SizingResult | null;
}

export type OrderStatus =
  | 'PENDING'
  | 'SENT'
  | 'FILLED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'TIMEOUT'
  | 'RECONCILED';

export interface Order {
  id: string;
  clientOrderId: string;
  brokerOrderId: string | null;
  opportunityId: string | null;
  opportunityVersion: number | null;
  symbol: string;
  side: Side;
  lots: number;
  requestedPrice: number | null;
  filledPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  status: OrderStatus;
  createdAt: string;
  updatedAt: string;
  message: string | null;
  simulated: boolean;
}

export type PositionStatus = 'OPEN' | 'CLOSED';

export interface Position {
  id: string;
  orderId: string;
  opportunityId: string | null;
  symbol: string;
  side: Side;
  lots: number;
  openPrice: number;
  openedAt: string;
  stopLoss: number | null;
  takeProfit: number | null;
  closePrice: number | null;
  closedAt: string | null;
  closeReason: 'STOP_LOSS' | 'TAKE_PROFIT' | 'MANUAL' | 'DAILY_LIMIT' | null;
  status: PositionStatus;
  /** Resultado bruto, sem custos. */
  grossPnl: number;
  costs: number;
  /** Resultado liquido (bruto menos custos). */
  netPnl: number;
  notionalValue: number;
  riskedValue: number;
  simulated: boolean;
}

export interface AccountSnapshot {
  accountId: string;
  accountType: 'SIMULADA' | 'DEMO_CORRETORA' | 'REAL';
  brokerId: string;
  currency: string;
  balance: number;
  equity: number;
  usedMargin: number;
  freeMargin: number;
  connected: boolean;
  lastUpdateAt: string;
}

export interface Quote {
  symbol: string;
  bid: number;
  ask: number;
  spreadPips: number;
  at: string;
}

// ---------------------------------------------------------------------------
// Auditoria
// ---------------------------------------------------------------------------

export type EventKind =
  | 'SIGNAL_RECEIVED'
  | 'SIGNAL_REJECTED'
  | 'SIGNAL_SUPERSEDED'
  | 'SIGNAL_CANCELLED'
  | 'SIGNAL_DUPLICATE'
  | 'OPPORTUNITY_PUBLISHED'
  | 'OPPORTUNITY_UPDATED'
  | 'OPPORTUNITY_EXPIRED'
  | 'RISK_BLOCKED'
  | 'RISK_APPROVED'
  | 'ORDER_SENT'
  | 'ORDER_FILLED'
  | 'ORDER_REJECTED'
  | 'ORDER_TIMEOUT'
  | 'ORDER_RECONCILED'
  | 'POSITION_CLOSED'
  | 'MODE_CHANGED'
  | 'SETTINGS_CHANGED'
  | 'CONNECTION_LOST'
  | 'CONNECTION_RESTORED'
  | 'DAILY_LIMIT_HIT'
  | 'AUTOMATION_PAUSED'
  | 'SCENARIO_RUN';

export interface AuditEvent {
  id: string;
  at: string;
  kind: EventKind;
  severity: 'INFO' | 'WARN' | 'BLOCK' | 'SUCCESS';
  title: string;
  detail: string;
  refs: {
    signalId?: string;
    sourceId?: string;
    opportunityId?: string;
    orderId?: string;
    positionId?: string;
  };
}
