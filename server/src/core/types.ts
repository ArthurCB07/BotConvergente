/**
 * Modelo de dominio.
 *
 * A plataforma opera DOIS mercados separados: FOREX e CRIPTO. Separados de
 * verdade — fontes, convergencia, configuracoes, automacao, limites diarios e
 * conta. Um sinal de um mercado nunca entra na contagem, no percentual nem no
 * peso do outro.
 *
 * Dentro de cada mercado existe o `ProductType`, que diz o que pode ser comparado
 * com o que. Cripto a vista e perpetuo sao produtos diferentes e nunca se
 * misturam, mesmo sendo o mesmo par.
 */

/** Mercado de topo. Determina segmentacao de dados, configuracao e automacao. */
export type MarketId = 'FOREX' | 'CRYPTO';

export const MARKET_IDS: MarketId[] = ['FOREX', 'CRYPTO'];

/** Classe de produto dentro do mercado. Define o que e comparavel. */
export type ProductType = 'FX_SPOT' | 'CRYPTO_SPOT' | 'CRYPTO_PERP';

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
  | 'REJECTED'
  /** Mercado do sinal nao bate com o cadastro da fonte. */
  | 'MARKET_MISMATCH';

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

  marketId: MarketId;
  productType: ProductType;
  symbol: string;
  venue: Venue;
  /** Moeda de cotacao do par. Preservada para nao comparar USDT com USD as cegas. */
  quoteCurrency: string;
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
  /**
   * Mercados que esta fonte atende. Uma sala que publica os dois mercados fica
   * cadastrada uma vez com os dois: cada sinal e roteado para o mercado correto e
   * a fonte continua valendo UM voto em cada mercado, nunca dois no mesmo.
   *
   * Lista vazia = mercado nao classificado. A fonte nao vota em lugar nenhum e a
   * interface pede a classificacao. Registro de origem incerta nunca e descartado.
   */
  markets: MarketId[];
  /** Etiquetas livres do usuario. Nao afetam a contagem de votos. */
  tags: string[];
  /**
   * Grupo de independencia. Fontes com o mesmo valor contam como UM voto.
   * Por padrao vale o proprio id: presume-se independencia apenas enquanto o
   * usuario nao declarar o contrario.
   */
  independenceGroupId: string;
  /** Peso por mercado. Mercados tem pesos independentes. */
  weightByMarket: Record<MarketId, number>;
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

/**
 * Base do percentual de concordancia. A regra usada aparece sempre na interface,
 * junto do numerador e do denominador.
 */
export type DenominatorMode =
  /** Fontes habilitadas para aquele instrumento no mercado. Fonte sem sinal NAO concorda. */
  | 'ENABLED_SOURCES'
  /** Apenas fontes com sinal valido e comparavel na janela. */
  | 'COMPARABLE_SIGNALS';

export interface ConvergenceSettings {
  minAgreeingSources: number;
  minAgreementPercent: number;
  criteriaMode: CriteriaMode;
  denominatorMode: DenominatorMode;
  /** Janela de agrupamento: sinais dentro deste intervalo sao comparados. */
  groupingWindowMinutes: number;
  /** Idade maxima de um sinal para continuar votando. */
  maxSignalAgeMinutes: number;
  includedSourceIds: string[] | null;
  excludedSourceIds: string[];
  /** Instrumentos permitidos neste mercado. `null` = todos do catalogo. */
  allowedSymbols: string[] | null;
  opposingPolicy: OpposingPolicy;
  /** Usado quando opposingPolicy === 'BLOCK_ABOVE_RATIO'. 0..1 */
  opposingBlockRatio: number;
  /** Tolerancia entre precos de entrada, em ticks do instrumento. */
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
  /**
   * Quando o denominador e "fontes habilitadas", a fonte sem sinal entra no
   * denominador mesmo assim — e este campo diz isso de forma explicita.
   */
  countedInDenominator: boolean;
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
  /** Chave estavel da convergencia. Inclui o mercado. */
  clusterKey: string;
  version: number;
  marketId: MarketId;
  productType: ProductType;
  symbol: string;
  venue: Venue;
  quoteCurrency: string;
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
  denominatorMode: DenominatorMode;
  /** Frase curta explicando a regra do denominador usada. */
  denominatorRule: string;

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

export type SizingMode = 'FIXED_QUANTITY' | 'RISK_PERCENT';

export interface RiskSettings {
  sizingMode: SizingMode;
  /** Quantidade fixa na unidade do instrumento (lote em forex, unidade em cripto). */
  fixedQuantity: number;
  riskPercentPerTrade: number;
  /** Distancia padrao do stop, em ticks do instrumento. */
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

/**
 * Limites que valem para os dois mercados somados. Um limite global bloqueia
 * novas entradas nos dois; nenhum mercado pode ignora-lo.
 */
export interface GlobalRiskSettings {
  enabled: boolean;
  maxOpenPositionsTotal: number;
  maxTotalExposureNotional: number;
  dailyLossLimitPercent: number;
  dailyProfitTargetPercent: number;
  /** Moeda de referencia para consolidar contas de moedas diferentes. */
  referenceCurrency: string;
}

export interface RiskBlock {
  code: string;
  label: string;
  detail: string;
  /** Se o bloqueio vale so para este mercado ou para os dois. */
  scope: 'MARKET' | 'GLOBAL';
}

export interface SizingResult {
  mode: SizingMode;
  /** Quantidade na unidade do instrumento. */
  quantity: number;
  quantityLabel: string;
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
  marketId: MarketId;
  productType: ProductType;
  /** Conta que recebeu a ordem. */
  accountId: string;
  brokerId: string;
  opportunityId: string | null;
  opportunityVersion: number | null;
  symbol: string;
  side: Side;
  quantity: number;
  quantityLabel: string;
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
  marketId: MarketId;
  productType: ProductType;
  accountId: string;
  brokerId: string;
  symbol: string;
  side: Side;
  quantity: number;
  quantityLabel: string;
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
  brokerName: string;
  currency: string;
  /** Mercados que esta conta atende. */
  markets: MarketId[];
  balance: number;
  equity: number;
  usedMargin: number;
  /** Margem separada para ordens em voo, ainda nao preenchidas. */
  reservedMargin: number;
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
  | 'SIGNAL_MARKET_MISMATCH'
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
  | 'AUTOMATION_CHANGED'
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
  /** `null` quando o evento e global (pausa geral, limite global, banco). */
  marketId: MarketId | null;
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

export const MARKET_LABEL: Record<MarketId, string> = {
  FOREX: 'Forex',
  CRYPTO: 'Cripto',
};

export const PRODUCT_LABEL: Record<ProductType, string> = {
  FX_SPOT: 'Forex a vista',
  CRYPTO_SPOT: 'Cripto a vista',
  CRYPTO_PERP: 'Cripto perpetuo',
};
