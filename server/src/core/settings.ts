import type {
  ConvergenceSettings,
  GlobalRiskSettings,
  MarketId,
  OperationMode,
  RiskSettings,
} from './types.ts';

/**
 * Padroes iniciais de DEMONSTRACAO, por mercado.
 *
 * Sao valores escolhidos para o protocolo de teste do prototipo, com conta
 * simulada. NAO sao parametros validados com dados historicos e nao ha qualquer
 * evidencia de rentabilidade associada a eles.
 *
 * Forex e Cripto tem padroes DIFERENTES de proposito. Nada e copiado de um
 * mercado para o outro: cada divergencia tem um motivo declarado no descritor do
 * campo — volatilidade tipica, horario de funcionamento ou alavancagem.
 */

export const DEFAULT_TIMEZONE = 'America/Sao_Paulo';

const forexConvergence: ConvergenceSettings = {
  minAgreeingSources: 3,
  minAgreementPercent: 75,
  criteriaMode: 'BOTH',
  denominatorMode: 'COMPARABLE_SIGNALS',
  groupingWindowMinutes: 15,
  maxSignalAgeMinutes: 20,
  includedSourceIds: null,
  excludedSourceIds: [],
  allowedSymbols: null,
  opposingPolicy: 'COUNT_IN_DENOMINATOR',
  opposingBlockRatio: 0.34,
  entryTolerancePips: 8,
  requireCompatibleTimeframe: true,
  horizonRatioTolerance: 3,
  opportunityTtlMinutes: 10,
  useSourceWeights: false,
};

const cryptoConvergence: ConvergenceSettings = {
  minAgreeingSources: 3,
  minAgreementPercent: 75,
  criteriaMode: 'BOTH',
  denominatorMode: 'COMPARABLE_SIGNALS',
  // Cripto se move mais rapido: janela e idade menores que as de forex.
  groupingWindowMinutes: 10,
  maxSignalAgeMinutes: 12,
  includedSourceIds: null,
  excludedSourceIds: [],
  allowedSymbols: null,
  opposingPolicy: 'COUNT_IN_DENOMINATOR',
  opposingBlockRatio: 0.34,
  // 40 pips = 0,40% do preco. Em forex, 8 pips = 0,08%.
  entryTolerancePips: 40,
  requireCompatibleTimeframe: true,
  horizonRatioTolerance: 3,
  opportunityTtlMinutes: 6,
  useSourceWeights: false,
};

const forexRisk: RiskSettings = {
  sizingMode: 'RISK_PERCENT',
  fixedQuantity: 0.05,
  riskPercentPerTrade: 0.5,
  defaultStopPips: 20,
  defaultTakeProfitPips: 30,
  useSignalStops: true,

  maxOpenPositions: 1,
  maxExposurePerSymbolNotional: 60_000,
  maxTotalExposureNotional: 120_000,
  maxTradesPerDay: 6,
  minMinutesBetweenEntries: 10,
  pauseAfterConsecutiveLosses: 3,
  pauseMinutes: 120,

  dailyLossLimitPercent: 2,
  dailyProfitTargetPercent: 3,
  onDailyLimitCancelPending: true,
  onDailyLimitClosePositions: false,

  tradingTimezone: DEFAULT_TIMEZONE,
  tradingWindows: [{ start: '05:00', end: '18:00' }],
  tradingDays: [1, 2, 3, 4, 5],

  maxSpreadPips: 2.5,
  maxPriceDeviationPips: 6,
  maxQuoteAgeSeconds: 20,
  maxExecutionsPerOpportunity: 1,
  martingaleEnabled: false,
};

const cryptoRisk: RiskSettings = {
  sizingMode: 'RISK_PERCENT',
  fixedQuantity: 0.01,
  // Premissa conservadora pela volatilidade maior. Nao e recomendacao validada.
  riskPercentPerTrade: 0.3,
  // 150 pips = 1,5% do preco. 250 pips = 2,5%.
  defaultStopPips: 150,
  defaultTakeProfitPips: 250,
  useSignalStops: true,

  maxOpenPositions: 1,
  // Cripto a vista nao tem alavancagem: o nocional sai inteiro da conta.
  maxExposurePerSymbolNotional: 3_000,
  maxTotalExposureNotional: 6_000,
  maxTradesPerDay: 8,
  minMinutesBetweenEntries: 5,
  pauseAfterConsecutiveLosses: 3,
  pauseMinutes: 120,

  dailyLossLimitPercent: 2,
  dailyProfitTargetPercent: 3,
  onDailyLimitCancelPending: true,
  onDailyLimitClosePositions: false,

  tradingTimezone: DEFAULT_TIMEZONE,
  // Mercado 24 horas, 7 dias. Restricao tecnica, nao preferencia.
  tradingWindows: [{ start: '00:00', end: '23:59' }],
  tradingDays: [1, 2, 3, 4, 5, 6, 7],

  maxSpreadPips: 3,
  maxPriceDeviationPips: 30,
  maxQuoteAgeSeconds: 20,
  maxExecutionsPerOpportunity: 1,
  martingaleEnabled: false,
};

export const defaultConvergenceSettings: Record<MarketId, ConvergenceSettings> = {
  FOREX: forexConvergence,
  CRYPTO: cryptoConvergence,
};

export const defaultRiskSettings: Record<MarketId, RiskSettings> = {
  FOREX: forexRisk,
  CRYPTO: cryptoRisk,
};

export const defaultGlobalRiskSettings: GlobalRiskSettings = {
  enabled: true,
  maxOpenPositionsTotal: 2,
  maxTotalExposureNotional: 100_000,
  dailyLossLimitPercent: 3,
  dailyProfitTargetPercent: 5,
  referenceCurrency: 'USD',
};

export const defaultMode: OperationMode = 'OBSERVE';

/** Conta usada por cada mercado quando o ambiente e semeado. */
export const defaultAccountByMarket: Record<MarketId, string> = {
  FOREX: 'paper',
  CRYPTO: 'paper',
};

export function cloneConvergenceDefaults(marketId: MarketId): ConvergenceSettings {
  const base = defaultConvergenceSettings[marketId];
  return {
    ...base,
    excludedSourceIds: [...base.excludedSourceIds],
    includedSourceIds: base.includedSourceIds ? [...base.includedSourceIds] : null,
    allowedSymbols: base.allowedSymbols ? [...base.allowedSymbols] : null,
  };
}

export function cloneRiskDefaults(marketId: MarketId): RiskSettings {
  const base = defaultRiskSettings[marketId];
  return {
    ...base,
    tradingWindows: base.tradingWindows.map((w) => ({ ...w })),
    tradingDays: [...base.tradingDays],
  };
}

// ---------------------------------------------------------------------------
// Descritores: cada parametro ajustavel carrega sugestao, explicacao e efeito.
// ---------------------------------------------------------------------------

export type SettingKind = 'number' | 'percent' | 'boolean' | 'enum' | 'list' | 'time' | 'secret';

/** Natureza da sugestao apresentada ao usuario. */
export type SuggestionBasis =
  /** Valor inicial escolhido para a simulacao. Sem validacao em dados. */
  | 'PADRAO_INICIAL_SIMULACAO'
  /** Restricao tecnica do instrumento, da corretora ou do protocolo. */
  | 'LIMITE_TECNICO'
  /** Nao se aplica ao mercado ou ao modo atual. */
  | 'NAO_SE_APLICA'
  /** Dado pessoal ou credencial: o usuario preenche, o sistema nao inventa. */
  | 'PREENCHIMENTO_DO_USUARIO';

export interface SettingDescriptor {
  key: string;
  group: 'convergencia' | 'risco' | 'execucao' | 'operacao' | 'global';
  /** MARKET = valor por mercado. GLOBAL = valor unico para a plataforma. */
  scope: 'MARKET' | 'GLOBAL';
  label: string;
  kind: SettingKind;
  unit?: string;
  /** Sugestao por mercado, quando `scope === 'MARKET'`. */
  suggestedByMarket?: Record<MarketId, unknown>;
  /** Sugestao unica, quando `scope === 'GLOBAL'`. */
  suggested?: unknown;
  basis: SuggestionBasis;
  /** Base da sugestao por mercado, quando difere. */
  basisByMarket?: Record<MarketId, SuggestionBasis>;
  /** O que o parametro faz. */
  explanation: string;
  /** O que muda ao aumentar ou diminuir. */
  effect: string;
  /** De que outros parametros ou condicoes depende. */
  dependencies: string;
  /** Explicacao adicional especifica de um mercado. */
  marketNotes?: Partial<Record<MarketId, string>>;
  min?: number;
  max?: number;
  step?: number;
  options?: Array<{ value: string; label: string }>;
}

const byMarket = <T>(forex: T, crypto: T): Record<MarketId, T> => ({ FOREX: forex, CRYPTO: crypto });

export const settingDescriptors: SettingDescriptor[] = [
  // ----- Operacao -----
  {
    key: 'mode',
    group: 'operacao',
    scope: 'MARKET',
    label: 'Modo operacional',
    kind: 'enum',
    suggestedByMarket: byMarket('OBSERVE', 'OBSERVE'),
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation:
      'Observacao apenas publica oportunidades. Semiautomatico pede confirmacao por ordem. Autonomo envia ordens elegiveis sozinho.',
    effect:
      'Subir o nivel aumenta a quantidade de ordens enviadas sem intervencao e reduz o tempo entre o sinal e a execucao.',
    dependencies:
      'Cada mercado tem seu proprio modo. Semiautomatico e Autonomo exigem conexao compativel com o mercado. Nenhum modo ignora os limites de risco.',
    options: [
      { value: 'OBSERVE', label: 'Observacao' },
      { value: 'SEMI_AUTO', label: 'Semiautomatico' },
      { value: 'AUTO', label: 'Autonomo' },
    ],
  },
  {
    key: 'automationEnabled',
    group: 'operacao',
    scope: 'MARKET',
    label: 'Automacao do mercado',
    kind: 'boolean',
    suggestedByMarket: byMarket(false, false),
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation:
      'Liga e desliga o envio automatico de ordens deste mercado, sem afetar o outro.',
    effect:
      'Desligada, o mercado continua recebendo sinais, publicando oportunidades e gerindo as posicoes ja abertas. Somente novas entradas automaticas param.',
    dependencies:
      'Independente do outro mercado e da pausa global. Confirmacao manual no modo semiautomatico continua disponivel.',
  },

  // ----- Convergencia -----
  {
    key: 'minAgreeingSources',
    group: 'convergencia',
    scope: 'MARKET',
    label: 'Minimo de fontes concordantes',
    kind: 'number',
    unit: 'fontes',
    suggestedByMarket: byMarket(3, 3),
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation:
      'Quantidade minima de grupos de independencia distintos que precisam concordar com a mesma direcao, dentro deste mercado.',
    effect:
      'Valores maiores reduzem o numero de oportunidades publicadas e exigem mais confirmacao. Valores menores publicam mais e com menos corroboracao.',
    dependencies:
      'Parametro independente do percentual. Conta grupos de independencia, nao fontes brutas. Fontes do outro mercado nunca entram nesta contagem.',
    min: 1,
    max: 20,
    step: 1,
  },
  {
    key: 'minAgreementPercent',
    group: 'convergencia',
    scope: 'MARKET',
    label: 'Percentual minimo de concordancia',
    kind: 'percent',
    unit: '%',
    suggestedByMarket: byMarket(75, 75),
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation:
      'Percentual de concordancia entre as fontes participantes deste mercado. O denominador segue a regra escolhida no campo "Base do percentual".',
    effect:
      'Valores maiores filtram cenarios com divergencia. Valores menores aceitam convergencias mais disputadas.',
    dependencies:
      'Depende da base do percentual e da politica de sinais contrarios. Nao representa probabilidade de acerto.',
    min: 1,
    max: 100,
    step: 1,
  },
  {
    key: 'denominatorMode',
    group: 'convergencia',
    scope: 'MARKET',
    label: 'Base do percentual',
    kind: 'enum',
    suggestedByMarket: byMarket('COMPARABLE_SIGNALS', 'COMPARABLE_SIGNALS'),
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation:
      'Define o denominador. "Fontes habilitadas" usa todas as fontes ativas do mercado para aquele instrumento, e uma fonte sem sinal NAO conta como concordante. "Sinais comparaveis" usa apenas quem tem sinal valido e comparavel na janela.',
    effect:
      'Fontes habilitadas e mais exigente: silencio pesa contra. Sinais comparaveis mede so quem se manifestou.',
    dependencies:
      'A regra usada aparece junto do numerador e do denominador em toda oportunidade. A quantidade minima de confirmacoes continua sendo parametro separado.',
    options: [
      { value: 'COMPARABLE_SIGNALS', label: 'Fontes com sinal comparavel na janela' },
      { value: 'ENABLED_SOURCES', label: 'Fontes habilitadas para o instrumento' },
    ],
  },
  {
    key: 'criteriaMode',
    group: 'convergencia',
    scope: 'MARKET',
    label: 'Criterio de corte',
    kind: 'enum',
    suggestedByMarket: byMarket('BOTH', 'BOTH'),
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation: 'Define se o corte usa quantidade, percentual ou os dois simultaneamente.',
    effect:
      'Ambos e o mais restritivo: protege contra o caso de 2 de 2 fontes, que da 100% com amostra minima.',
    dependencies: 'Usa os campos de quantidade minima e percentual minimo conforme a escolha.',
    options: [
      { value: 'COUNT', label: 'Somente quantidade' },
      { value: 'PERCENT', label: 'Somente percentual' },
      { value: 'BOTH', label: 'Quantidade e percentual' },
    ],
  },
  {
    key: 'groupingWindowMinutes',
    group: 'convergencia',
    scope: 'MARKET',
    label: 'Janela de agrupamento',
    kind: 'number',
    unit: 'min',
    suggestedByMarket: byMarket(15, 10),
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation:
      'Intervalo dentro do qual sinais do mesmo instrumento sao comparados entre si.',
    effect:
      'Janelas maiores agrupam mais fontes, porem misturam contextos de preco diferentes. Janelas menores exigem sincronia entre as salas.',
    dependencies: 'Trabalha junto com a tolerancia de preco e com a idade maxima do sinal.',
    marketNotes: {
      FOREX: 'Premissa: salas de forex intradia divulgam entradas com poucos minutos de diferenca.',
      CRYPTO: 'Janela menor que a de forex porque cripto percorre a mesma distancia relativa em menos tempo.',
    },
    min: 1,
    max: 240,
    step: 1,
  },
  {
    key: 'maxSignalAgeMinutes',
    group: 'convergencia',
    scope: 'MARKET',
    label: 'Idade maxima do sinal',
    kind: 'number',
    unit: 'min',
    suggestedByMarket: byMarket(20, 12),
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation: 'Tempo maximo desde o recebimento para um sinal continuar votando.',
    effect: 'Valores altos mantem votos velhos vivos; valores baixos descartam sinais atrasados.',
    dependencies:
      'Se o sinal trouxer validade propria, prevalece a menor das duas. Sinal expirado nunca vota.',
    min: 1,
    max: 480,
    step: 1,
  },
  {
    key: 'opposingPolicy',
    group: 'convergencia',
    scope: 'MARKET',
    label: 'Tratamento de sinais contrarios',
    kind: 'enum',
    suggestedByMarket: byMarket('COUNT_IN_DENOMINATOR', 'COUNT_IN_DENOMINATOR'),
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation: 'Define o que fazer quando fontes indicam a direcao oposta no mesmo instrumento.',
    effect:
      'Contar no denominador reduz o percentual de concordancia. Bloquear elimina a oportunidade inteira.',
    dependencies: 'Afeta diretamente o percentual minimo de concordancia.',
    options: [
      { value: 'COUNT_IN_DENOMINATOR', label: 'Contar no denominador' },
      { value: 'IGNORE_IN_DENOMINATOR', label: 'Ignorar no denominador' },
      { value: 'BLOCK_IF_ANY', label: 'Bloquear se houver qualquer contrario' },
      { value: 'BLOCK_ABOVE_RATIO', label: 'Bloquear acima de uma proporcao' },
    ],
  },
  {
    key: 'opposingBlockRatio',
    group: 'convergencia',
    scope: 'MARKET',
    label: 'Proporcao de contrarios que bloqueia',
    kind: 'percent',
    unit: '%',
    suggestedByMarket: byMarket(0.34, 0.34),
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation:
      'Proporcao de fontes contrarias sobre participantes acima da qual a convergencia e bloqueada.',
    effect: 'Valores baixos bloqueiam com pouca divergencia.',
    dependencies: 'So tem efeito quando a politica de contrarios e "Bloquear acima de uma proporcao".',
    min: 0.01,
    max: 1,
    step: 0.01,
  },
  {
    key: 'entryTolerancePips',
    group: 'convergencia',
    scope: 'MARKET',
    label: 'Tolerancia entre precos de entrada',
    kind: 'number',
    unit: 'pips',
    suggestedByMarket: byMarket(8, 40),
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation:
      'Distancia maxima entre o preco de entrada de um sinal e o preco de referencia do agrupamento.',
    effect:
      'Tolerancias maiores agrupam sinais com precos distantes e inflam a concordancia. Menores exigem entradas quase iguais.',
    dependencies:
      'Aplica-se apenas a sinais com preco informado. Sinais a mercado, sem preco, nao sao reprovados por este criterio.',
    marketNotes: {
      FOREX: '8 pips = 0,08% em pares major. Cobre variacao normal de alguns minutos.',
      CRYPTO:
        'Em cripto 1 pip = 0,01% do preco, entao 40 pips = 0,40%. O valor maior acompanha a volatilidade, nao afrouxa o criterio.',
    },
    min: 0,
    max: 500,
    step: 1,
  },
  {
    key: 'requireCompatibleTimeframe',
    group: 'convergencia',
    scope: 'MARKET',
    label: 'Exigir timeframe compativel',
    kind: 'boolean',
    suggestedByMarket: byMarket(true, true),
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation:
      'Impede somar o voto de uma sala de 1 minuto com o de uma sala de swing de varios dias.',
    effect: 'Desligar aumenta a contagem de votos e mistura horizontes diferentes.',
    dependencies: 'Usa a tolerancia de razao de horizonte.',
  },
  {
    key: 'horizonRatioTolerance',
    group: 'convergencia',
    scope: 'MARKET',
    label: 'Tolerancia de razao entre horizontes',
    kind: 'number',
    unit: 'x',
    suggestedByMarket: byMarket(3, 3),
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation:
      'Razao maxima entre o maior e o menor horizonte para que dois sinais sejam considerados do mesmo tipo de operacao.',
    effect: 'Valores altos aproximam scalp de swing.',
    dependencies: 'So se aplica quando a exigencia de timeframe compativel esta ligada.',
    min: 1,
    max: 50,
    step: 0.5,
  },
  {
    key: 'opportunityTtlMinutes',
    group: 'convergencia',
    scope: 'MARKET',
    label: 'Validade da oportunidade',
    kind: 'number',
    unit: 'min',
    suggestedByMarket: byMarket(10, 6),
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation: 'Tempo que a oportunidade permanece elegivel apos a publicacao.',
    effect: 'Validades longas aumentam a chance de executar com o preco ja deslocado.',
    dependencies: 'A checagem de desvio de preco tambem limita entradas tardias.',
    min: 1,
    max: 240,
    step: 1,
  },
  {
    key: 'useSourceWeights',
    group: 'convergencia',
    scope: 'MARKET',
    label: 'Usar pesos por fonte',
    kind: 'boolean',
    suggestedByMarket: byMarket(false, false),
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation:
      'Quando desligado, todas as fontes valem 1. O peso ponderado continua sendo exibido apenas como informacao.',
    effect:
      'Ligar faz o percentual usar a soma dos pesos. Pesos derivados de desempenho exigem amostra grande e validacao fora da amostra; sem isso, tendem a refletir ruido.',
    dependencies: 'O peso e por mercado: a mesma fonte pode pesar diferente em Forex e em Cripto.',
  },

  // ----- Risco por mercado -----
  {
    key: 'sizingMode',
    group: 'risco',
    scope: 'MARKET',
    label: 'Dimensionamento da entrada',
    kind: 'enum',
    suggestedByMarket: byMarket('RISK_PERCENT', 'RISK_PERCENT'),
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation:
      'Quantidade fixa usa sempre o mesmo volume. Risco percentual calcula o volume a partir da distancia ate o stop.',
    effect:
      'Risco percentual mantem a perda potencial estavel quando a distancia do stop muda; quantidade fixa nao.',
    dependencies: 'Risco percentual exige stop definido, do sinal ou do padrao configurado.',
    options: [
      { value: 'RISK_PERCENT', label: 'Percentual de risco por operacao' },
      { value: 'FIXED_QUANTITY', label: 'Quantidade fixa' },
    ],
  },
  {
    key: 'riskPercentPerTrade',
    group: 'risco',
    scope: 'MARKET',
    label: 'Risco por operacao',
    kind: 'percent',
    unit: '% do patrimonio',
    suggestedByMarket: byMarket(0.5, 0.3),
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation:
      'Percentual do patrimonio que a distancia ate o stop representa. Este e o valor arriscado, diferente do valor nocional da ordem.',
    effect:
      'Aumentar amplia ganho e perda na mesma proporcao e acelera o consumo do limite diario.',
    dependencies:
      'Usado apenas no modo de risco percentual. Nao garante a perda exata: gaps e deslizamento podem ultrapassar o stop.',
    marketNotes: {
      CRYPTO:
        'Premissa conservadora pela volatilidade e pelos gaps maiores em cripto. Nao e recomendacao validada em dados.',
    },
    min: 0.05,
    max: 10,
    step: 0.05,
  },
  {
    key: 'fixedQuantity',
    group: 'risco',
    scope: 'MARKET',
    label: 'Quantidade fixa',
    kind: 'number',
    unit: 'unidades do instrumento',
    suggestedByMarket: byMarket(0.05, 0.01),
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation:
      'Volume usado quando o dimensionamento e por quantidade fixa. Em forex a unidade e o lote; em cripto, a unidade do proprio ativo.',
    effect: 'Volume maior aumenta nocional, margem exigida e resultado por pip.',
    dependencies: 'Limitado pela quantidade minima e maxima do instrumento e pela margem livre.',
    min: 0.0001,
    max: 1000,
    step: 0.0001,
  },
  {
    key: 'defaultStopPips',
    group: 'risco',
    scope: 'MARKET',
    label: 'Stop loss padrao',
    kind: 'number',
    unit: 'pips',
    suggestedByMarket: byMarket(20, 150),
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation: 'Distancia usada quando o sinal nao traz stop.',
    effect: 'Stops curtos sao atingidos com mais frequencia; stops longos aumentam a perda por operacao.',
    dependencies: 'No modo de risco percentual, define o volume calculado.',
    marketNotes: {
      FOREX: '20 pips = 0,2%, dentro da faixa intradia tipica de pares major (50 a 80 pips por dia).',
      CRYPTO: '150 pips = 1,5% do preco, coerente com a faixa diaria simulada de 3% a 5%.',
    },
    min: 1,
    max: 2000,
    step: 1,
  },
  {
    key: 'defaultTakeProfitPips',
    group: 'risco',
    scope: 'MARKET',
    label: 'Take profit padrao',
    kind: 'number',
    unit: 'pips',
    suggestedByMarket: byMarket(30, 250),
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation: 'Alvo usado quando o sinal nao traz alvo. Relacao de 1,5 para 1 com o stop padrao.',
    effect: 'Alvos distantes reduzem a taxa de acerto e aumentam o retorno por acerto.',
    dependencies: 'Ignorado quando o sinal traz alvo e o uso de stops do sinal esta ligado.',
    min: 1,
    max: 5000,
    step: 1,
  },
  {
    key: 'useSignalStops',
    group: 'risco',
    scope: 'MARKET',
    label: 'Priorizar stop e alvo do sinal',
    kind: 'boolean',
    suggestedByMarket: byMarket(true, true),
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation: 'Quando o sinal traz stop e alvo, usa os valores dele em vez dos padroes.',
    effect: 'Desligar padroniza todas as operacoes com a mesma distancia.',
    dependencies: 'Se os sinais concordantes trouxerem stops diferentes, usa-se a mediana.',
  },
  {
    key: 'maxOpenPositions',
    group: 'risco',
    scope: 'MARKET',
    label: 'Maximo de operacoes abertas no mercado',
    kind: 'number',
    unit: 'posicoes',
    suggestedByMarket: byMarket(1, 1),
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation: 'Quantas posicoes deste mercado podem estar abertas ao mesmo tempo.',
    effect: 'Mais posicoes simultaneas aumentam a exposicao agregada do mercado.',
    dependencies:
      'Alem deste limite existe o limite global de posicoes, que soma os dois mercados e nao pode ser ignorado.',
    min: 1,
    max: 20,
    step: 1,
  },
  {
    key: 'maxExposurePerSymbolNotional',
    group: 'risco',
    scope: 'MARKET',
    label: 'Exposicao maxima por ativo',
    kind: 'number',
    unit: 'nocional na moeda da conta',
    suggestedByMarket: byMarket(60_000, 3_000),
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation: 'Soma maxima do valor nocional aberto em um mesmo instrumento.',
    effect: 'Tetos baixos rejeitam ordens grandes mesmo com margem livre disponivel.',
    dependencies: 'Valor nocional, nao valor arriscado. Depende da alavancagem do instrumento.',
    marketNotes: {
      FOREX: '0,6 lote em par major, coerente com conta de USD 10.000 e alavancagem 1:30.',
      CRYPTO:
        'Cripto a vista nao tem alavancagem: o nocional sai inteiro do saldo, entao o teto e muito menor que o de forex.',
    },
    min: 100,
    max: 10_000_000,
    step: 100,
  },
  {
    key: 'maxTotalExposureNotional',
    group: 'risco',
    scope: 'MARKET',
    label: 'Exposicao maxima do mercado',
    kind: 'number',
    unit: 'nocional na moeda da conta',
    suggestedByMarket: byMarket(120_000, 6_000),
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation: 'Soma maxima do nocional das posicoes abertas deste mercado.',
    effect: 'Teto baixo limita o numero efetivo de operacoes simultaneas no mercado.',
    dependencies: 'Avaliado junto com a margem livre e com o limite global de exposicao.',
    min: 100,
    max: 50_000_000,
    step: 100,
  },
  {
    key: 'maxTradesPerDay',
    group: 'risco',
    scope: 'MARKET',
    label: 'Operacoes por dia no mercado',
    kind: 'number',
    unit: 'operacoes',
    suggestedByMarket: byMarket(6, 8),
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation: 'Numero maximo de entradas deste mercado no dia operacional.',
    effect: 'Limita o custo acumulado de spread e o efeito de sequencias ruins.',
    dependencies: 'O dia operacional segue o fuso configurado no mercado.',
    min: 1,
    max: 200,
    step: 1,
  },
  {
    key: 'minMinutesBetweenEntries',
    group: 'risco',
    scope: 'MARKET',
    label: 'Intervalo minimo entre entradas',
    kind: 'number',
    unit: 'min',
    suggestedByMarket: byMarket(10, 5),
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation:
      'Tempo minimo apos a ultima entrada deste mercado. Evita rajada de ordens quando varias salas reagem ao mesmo evento.',
    effect: 'Intervalos longos descartam oportunidades proximas.',
    dependencies: 'Contado por mercado. Uma entrada em Forex nao atrasa uma entrada em Cripto.',
    min: 0,
    max: 1440,
    step: 1,
  },
  {
    key: 'pauseAfterConsecutiveLosses',
    group: 'risco',
    scope: 'MARKET',
    label: 'Pausa apos perdas consecutivas',
    kind: 'number',
    unit: 'perdas',
    suggestedByMarket: byMarket(3, 3),
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation: 'Numero de perdas seguidas neste mercado que aciona uma pausa automatica.',
    effect: 'Interrompe sequencias ruins; tambem pode interromper antes de uma recuperacao.',
    dependencies: 'Contador por mercado. Zera a cada operacao vencedora e a cada novo dia operacional.',
    min: 0,
    max: 20,
    step: 1,
  },
  {
    key: 'pauseMinutes',
    group: 'risco',
    scope: 'MARKET',
    label: 'Duracao da pausa',
    kind: 'number',
    unit: 'min',
    suggestedByMarket: byMarket(120, 120),
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation: 'Tempo de bloqueio apos a sequencia de perdas.',
    effect: 'Pausas longas podem consumir o restante do dia operacional.',
    dependencies: 'So tem efeito se a pausa por perdas estiver ativa.',
    min: 1,
    max: 1440,
    step: 5,
  },
  {
    key: 'dailyLossLimitPercent',
    group: 'risco',
    scope: 'MARKET',
    label: 'Stop loss diario do mercado',
    kind: 'percent',
    unit: '% da base do dia',
    suggestedByMarket: byMarket(2, 2),
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation:
      'Perda acumulada neste mercado que bloqueia novas entradas dele. Base do dia = patrimonio da conta na abertura, sem depositos e saques.',
    effect: 'Limites apertados encerram o mercado cedo; limites largos permitem perdas maiores.',
    dependencies:
      'Bloqueia apenas este mercado. O limite global, quando atingido, bloqueia os dois.',
    min: 0.1,
    max: 50,
    step: 0.1,
  },
  {
    key: 'dailyProfitTargetPercent',
    group: 'risco',
    scope: 'MARKET',
    label: 'Stop win diario do mercado',
    kind: 'percent',
    unit: '% da base do dia',
    suggestedByMarket: byMarket(3, 3),
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation: 'Ganho acumulado neste mercado que bloqueia novas entradas dele no dia.',
    effect: 'Preserva o resultado do dia e abre mao de continuidade em dias favoraveis.',
    dependencies: 'Mesma base de calculo do stop diario.',
    min: 0.1,
    max: 100,
    step: 0.1,
  },
  {
    key: 'onDailyLimitCancelPending',
    group: 'risco',
    scope: 'MARKET',
    label: 'Cancelar ordens pendentes no limite diario',
    kind: 'boolean',
    suggestedByMarket: byMarket(true, true),
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation: 'Ao atingir um limite diario deste mercado, cancela ordens ainda nao executadas.',
    effect: 'Evita entradas disparadas depois do bloqueio.',
    dependencies: 'Independente do encerramento de posicoes abertas.',
  },
  {
    key: 'onDailyLimitClosePositions',
    group: 'risco',
    scope: 'MARKET',
    label: 'Encerrar posicoes abertas no limite diario',
    kind: 'boolean',
    suggestedByMarket: byMarket(false, false),
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation: 'Ao atingir um limite diario, fecha as posicoes deste mercado que ainda estao abertas.',
    effect:
      'Ligado, realiza o resultado imediatamente ao preco disponivel. Desligado, mantem stop e alvo originais.',
    dependencies:
      'Encerramento a mercado nao garante preco: o preenchimento sai ao preco disponivel no momento.',
  },
  {
    key: 'tradingTimezone',
    group: 'risco',
    scope: 'MARKET',
    label: 'Fuso do dia operacional',
    kind: 'enum',
    suggestedByMarket: byMarket(DEFAULT_TIMEZONE, DEFAULT_TIMEZONE),
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation: 'Fuso que define a virada do dia e a leitura dos horarios permitidos.',
    effect: 'Mudar o fuso desloca a virada do dia e o calculo do resultado diario.',
    dependencies: 'A corretora ou exchange pode usar outro fuso de servidor.',
    options: [
      { value: 'America/Sao_Paulo', label: 'America/Sao_Paulo' },
      { value: 'UTC', label: 'UTC' },
      { value: 'Europe/London', label: 'Europe/London' },
      { value: 'America/New_York', label: 'America/New_York' },
    ],
  },
  {
    key: 'tradingWindows',
    group: 'risco',
    scope: 'MARKET',
    label: 'Horarios permitidos',
    kind: 'list',
    suggestedByMarket: byMarket(
      [{ start: '05:00', end: '18:00' }],
      [{ start: '00:00', end: '23:59' }],
    ),
    basis: 'PADRAO_INICIAL_SIMULACAO',
    basisByMarket: byMarket('PADRAO_INICIAL_SIMULACAO', 'LIMITE_TECNICO'),
    explanation: 'Faixas de horario em que novas entradas deste mercado sao aceitas.',
    effect: 'Faixas largas incluem horarios de spread alto e liquidez menor.',
    dependencies: 'Interpretado no fuso do dia operacional do mercado.',
    marketNotes: {
      FOREX: '05:00 as 18:00 em Sao Paulo cobre as sessoes de Londres e Nova York.',
      CRYPTO: 'Cripto negocia 24 horas, entao a janela cheia e o padrao tecnico do mercado.',
    },
  },
  {
    key: 'tradingDays',
    group: 'risco',
    scope: 'MARKET',
    label: 'Dias permitidos',
    kind: 'list',
    suggestedByMarket: byMarket([1, 2, 3, 4, 5], [1, 2, 3, 4, 5, 6, 7]),
    basis: 'LIMITE_TECNICO',
    explanation:
      'Forex spot nao negocia no fim de semana. Cripto negocia todos os dias.',
    effect: 'Habilitar fim de semana em Forex nao gera negocios: o mercado esta fechado.',
    dependencies: 'Restricao do mercado, nao preferencia do usuario.',
  },
  {
    key: 'martingaleEnabled',
    group: 'risco',
    scope: 'MARKET',
    label: 'Martingale',
    kind: 'boolean',
    suggestedByMarket: byMarket(false, false),
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation: 'Aumentar o volume apos perdas para tentar recuperar o prejuizo.',
    effect:
      'Eleva a exposicao justamente apos perdas e concentra o risco de ruina em poucas sequencias adversas.',
    dependencies: 'Desativado por padrao e mantido desativado nos cenarios de demonstracao.',
  },

  // ----- Execucao por mercado -----
  {
    key: 'maxSpreadPips',
    group: 'execucao',
    scope: 'MARKET',
    label: 'Spread maximo aceito',
    kind: 'number',
    unit: 'pips',
    suggestedByMarket: byMarket(2.5, 3),
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation: 'Bloqueia envio quando o spread do momento passa do limite.',
    effect: 'Limite baixo recusa mais ordens em noticias; limite alto aceita custo de entrada maior.',
    dependencies: 'Depende do spread informado pela conexao do mercado.',
    marketNotes: {
      FOREX: 'Spread tipico simulado dos majors fica entre 0,8 e 1,4 pip.',
      CRYPTO: '3 pips = 0,03% do preco. Spread tipico simulado fica entre 0,3 e 0,8 pip.',
    },
    min: 0.1,
    max: 100,
    step: 0.1,
  },
  {
    key: 'maxPriceDeviationPips',
    group: 'execucao',
    scope: 'MARKET',
    label: 'Desvio maximo do preco do sinal',
    kind: 'number',
    unit: 'pips',
    suggestedByMarket: byMarket(6, 30),
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation:
      'Distancia maxima entre o preco atual e o preco de referencia da oportunidade no momento do envio.',
    effect: 'Valores baixos descartam oportunidades que ja correram; altos aceitam entrada pior.',
    dependencies:
      'So se aplica quando a oportunidade tem preco de referencia. Nao e garantia de preenchimento nesse preco.',
    min: 0,
    max: 1000,
    step: 0.5,
  },
  {
    key: 'maxQuoteAgeSeconds',
    group: 'execucao',
    scope: 'MARKET',
    label: 'Idade maxima da cotacao',
    kind: 'number',
    unit: 's',
    suggestedByMarket: byMarket(20, 20),
    basis: 'LIMITE_TECNICO',
    explanation:
      'Se a ultima cotacao for mais antiga que isto, novas ordens sao bloqueadas por dado desatualizado.',
    effect: 'Valores altos permitem operar as cegas apos falha de conexao.',
    dependencies: 'Depende da frequencia de atualizacao do conector do mercado.',
    min: 1,
    max: 300,
    step: 1,
  },
  {
    key: 'maxExecutionsPerOpportunity',
    group: 'execucao',
    scope: 'MARKET',
    label: 'Execucoes por oportunidade',
    kind: 'number',
    unit: 'ordens',
    suggestedByMarket: byMarket(1, 1),
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation:
      'Quantas ordens uma mesma convergencia pode gerar. Atualizacoes da convergencia nao criam entrada nova enquanto o limite estiver atingido.',
    effect: 'Valores acima de 1 permitem acumular posicao na mesma convergencia.',
    dependencies:
      'A identidade e a chave do agrupamento, nao a versao. Reenvios reusam a mesma chave de ordem.',
    min: 1,
    max: 10,
    step: 1,
  },

  // ----- Limites globais -----
  {
    key: 'enabled',
    group: 'global',
    scope: 'GLOBAL',
    label: 'Limites globais ativos',
    kind: 'boolean',
    suggested: true,
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation:
      'Liga os limites que somam os dois mercados. Quando um limite global e atingido, os dois param.',
    effect:
      'Desligar deixa cada mercado sozinho com seus proprios limites, o que permite que a soma passe do que a conta suporta.',
    dependencies: 'Nenhum mercado pode ignorar um limite global ligado.',
  },
  {
    key: 'maxOpenPositionsTotal',
    group: 'global',
    scope: 'GLOBAL',
    label: 'Maximo de operacoes abertas somando os mercados',
    kind: 'number',
    unit: 'posicoes',
    suggested: 2,
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation: 'Teto de posicoes abertas contando Forex e Cripto juntos.',
    effect: 'Menor que a soma dos limites individuais, faz um mercado bloquear por causa do outro.',
    dependencies: 'Avaliado depois do limite individual de cada mercado.',
    min: 1,
    max: 50,
    step: 1,
  },
  {
    key: 'maxTotalExposureNotional',
    group: 'global',
    scope: 'GLOBAL',
    label: 'Exposicao maxima somando os mercados',
    kind: 'number',
    unit: 'nocional na moeda de referencia',
    suggested: 100_000,
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation:
      'Teto do nocional somado dos dois mercados, convertido para a moeda de referencia.',
    effect: 'Teto baixo faz uma posicao em um mercado consumir espaco do outro.',
    dependencies:
      'A conversao entre moedas usa taxa declarada. Com contas em moedas diferentes, o total consolidado sempre exibe a moeda e a taxa usada.',
    min: 100,
    max: 50_000_000,
    step: 100,
  },
  {
    key: 'dailyLossLimitPercent',
    group: 'global',
    scope: 'GLOBAL',
    label: 'Stop loss diario global',
    kind: 'percent',
    unit: '% da base do dia',
    suggested: 3,
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation:
      'Perda acumulada somando os dois mercados que bloqueia novas entradas em ambos.',
    effect: 'Encerra o dia inteiro, nao apenas o mercado que perdeu.',
    dependencies:
      'Base = soma do patrimonio das contas usadas na abertura do dia. Sugerido acima do limite individual de cada mercado, para que o individual atue primeiro.',
    min: 0.1,
    max: 50,
    step: 0.1,
  },
  {
    key: 'dailyProfitTargetPercent',
    group: 'global',
    scope: 'GLOBAL',
    label: 'Stop win diario global',
    kind: 'percent',
    unit: '% da base do dia',
    suggested: 5,
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation: 'Ganho acumulado somando os dois mercados que bloqueia novas entradas em ambos.',
    effect: 'Preserva o resultado consolidado do dia.',
    dependencies: 'Mesma base do stop loss global.',
    min: 0.1,
    max: 100,
    step: 0.1,
  },
  {
    key: 'referenceCurrency',
    group: 'global',
    scope: 'GLOBAL',
    label: 'Moeda de referencia',
    kind: 'enum',
    suggested: 'USD',
    basis: 'LIMITE_TECNICO',
    explanation:
      'Moeda usada para consolidar contas diferentes em um total unico.',
    effect: 'Todo total consolidado exibe esta moeda e a taxa de conversao usada.',
    dependencies:
      'No ambiente simulado, USDT e convertido a USD pela paridade 1,00 declarada. Em producao a taxa precisa vir de uma fonte identificada.',
    options: [
      { value: 'USD', label: 'USD' },
      { value: 'BRL', label: 'BRL' },
    ],
  },
];

export const descriptorByKey = new Map(settingDescriptors.map((d) => [`${d.scope}:${d.key}`, d]));

/** Sugestao efetiva de um descritor para o mercado informado. */
export function suggestedValue(descriptor: SettingDescriptor, marketId: MarketId): unknown {
  if (descriptor.scope === 'GLOBAL') return descriptor.suggested;
  return descriptor.suggestedByMarket?.[marketId];
}

export function basisFor(descriptor: SettingDescriptor, marketId: MarketId): SuggestionBasis {
  return descriptor.basisByMarket?.[marketId] ?? descriptor.basis;
}
