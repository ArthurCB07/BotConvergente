import type { ConvergenceSettings, OperationMode, RiskSettings } from './types.ts';

/**
 * Padroes iniciais de DEMONSTRACAO.
 *
 * Importante: sao valores escolhidos para o protocolo de teste do prototipo, com
 * conta simulada. NAO sao parametros validados com dados historicos e nao ha
 * qualquer evidencia de rentabilidade associada a eles.
 */

export const DEFAULT_TIMEZONE = 'America/Sao_Paulo';

export const defaultConvergenceSettings: ConvergenceSettings = {
  minAgreeingSources: 3,
  minAgreementPercent: 75,
  criteriaMode: 'BOTH',
  groupingWindowMinutes: 15,
  maxSignalAgeMinutes: 20,
  includedSourceIds: null,
  excludedSourceIds: [],
  opposingPolicy: 'COUNT_IN_DENOMINATOR',
  opposingBlockRatio: 0.34,
  entryTolerancePips: 8,
  requireCompatibleTimeframe: true,
  horizonRatioTolerance: 3,
  opportunityTtlMinutes: 10,
  useSourceWeights: false,
};

export const defaultRiskSettings: RiskSettings = {
  sizingMode: 'RISK_PERCENT',
  fixedLots: 0.05,
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

export const defaultMode: OperationMode = 'OBSERVE';

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
  group: 'convergencia' | 'risco' | 'execucao' | 'operacao' | 'corretora';
  label: string;
  kind: SettingKind;
  unit?: string;
  suggested: unknown;
  basis: SuggestionBasis;
  /** O que o parametro faz. */
  explanation: string;
  /** O que muda ao aumentar ou diminuir. */
  effect: string;
  /** De que outros parametros ou condicoes depende. */
  dependencies: string;
  min?: number;
  max?: number;
  step?: number;
  options?: Array<{ value: string; label: string }>;
}

export const settingDescriptors: SettingDescriptor[] = [
  // ----- Operacao -----
  {
    key: 'mode',
    group: 'operacao',
    label: 'Modo operacional',
    kind: 'enum',
    suggested: 'OBSERVE',
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation:
      'Observacao apenas publica oportunidades. Semiautomatico pede confirmacao por ordem. Autonomo envia ordens elegiveis sozinho.',
    effect:
      'Subir o nivel aumenta a quantidade de ordens enviadas sem intervencao e reduz o tempo entre o sinal e a execucao.',
    dependencies:
      'Semiautomatico e Autonomo exigem corretora conectada. Nenhum modo ignora os limites de risco.',
    options: [
      { value: 'OBSERVE', label: 'Observacao' },
      { value: 'SEMI_AUTO', label: 'Semiautomatico' },
      { value: 'AUTO', label: 'Autonomo' },
    ],
  },

  // ----- Convergencia -----
  {
    key: 'minAgreeingSources',
    group: 'convergencia',
    label: 'Minimo de fontes concordantes',
    kind: 'number',
    unit: 'fontes',
    suggested: 3,
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation:
      'Quantidade minima de grupos de independencia distintos que precisam concordar com a mesma direcao.',
    effect:
      'Valores maiores reduzem o numero de oportunidades publicadas e exigem mais confirmacao. Valores menores publicam mais e com menos corroboracao.',
    dependencies:
      'Conta grupos de independencia, nao fontes brutas. Fontes agrupadas somam um voto so. Usado quando o criterio e Quantidade ou Ambos.',
    min: 1,
    max: 20,
    step: 1,
  },
  {
    key: 'minAgreementPercent',
    group: 'convergencia',
    label: 'Percentual minimo de concordancia',
    kind: 'percent',
    unit: '%',
    suggested: 75,
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation:
      'Percentual de concordancia entre as fontes participantes. Denominador = grupos de independencia com sinal valido e comparavel na janela.',
    effect:
      'Valores maiores filtram cenarios com divergencia. Valores menores aceitam convergencias mais disputadas.',
    dependencies:
      'Depende da politica de sinais contrarios, que define se o divergente entra no denominador. Nao representa probabilidade de acerto.',
    min: 1,
    max: 100,
    step: 1,
  },
  {
    key: 'criteriaMode',
    group: 'convergencia',
    label: 'Criterio de corte',
    kind: 'enum',
    suggested: 'BOTH',
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
    label: 'Janela de agrupamento',
    kind: 'number',
    unit: 'min',
    suggested: 15,
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation:
      'Intervalo dentro do qual sinais do mesmo instrumento sao comparados entre si. Premissa: salas de forex intradia costumam divulgar entradas com poucos minutos de diferenca.',
    effect:
      'Janelas maiores agrupam mais fontes, porem misturam contextos de preco diferentes. Janelas menores exigem sincronia entre as salas.',
    dependencies:
      'Trabalha junto com a tolerancia de preco de entrada e com a idade maxima do sinal.',
    min: 1,
    max: 240,
    step: 1,
  },
  {
    key: 'maxSignalAgeMinutes',
    group: 'convergencia',
    label: 'Idade maxima do sinal',
    kind: 'number',
    unit: 'min',
    suggested: 20,
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
    label: 'Tratamento de sinais contrarios',
    kind: 'enum',
    suggested: 'COUNT_IN_DENOMINATOR',
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
    label: 'Proporcao de contrarios que bloqueia',
    kind: 'percent',
    unit: '%',
    suggested: 34,
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation:
      'Proporcao de fontes contrarias sobre participantes acima da qual a convergencia e bloqueada.',
    effect: 'Valores baixos bloqueiam com pouca divergencia.',
    dependencies: 'So tem efeito quando a politica de contrarios e "Bloquear acima de uma proporcao".',
    min: 1,
    max: 100,
    step: 1,
  },
  {
    key: 'entryTolerancePips',
    group: 'convergencia',
    label: 'Tolerancia entre precos de entrada',
    kind: 'number',
    unit: 'pips',
    suggested: 8,
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation:
      'Distancia maxima entre o preco de entrada de um sinal e o preco de referencia do agrupamento. Premissa: 8 pips em pares major cobre variacao normal de alguns minutos sem juntar entradas de contextos distintos.',
    effect:
      'Tolerancias maiores agrupam sinais com precos distantes e inflam a concordancia. Menores exigem entradas quase iguais.',
    dependencies:
      'Aplica-se apenas a sinais com preco informado. Sinais a mercado, sem preco, nao sao reprovados por este criterio.',
    min: 0,
    max: 200,
    step: 1,
  },
  {
    key: 'requireCompatibleTimeframe',
    group: 'convergencia',
    label: 'Exigir timeframe compativel',
    kind: 'boolean',
    suggested: true,
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation:
      'Impede somar o voto de uma sala de 1 minuto com o de uma sala de swing de varios dias.',
    effect: 'Desligar aumenta a contagem de votos e mistura horizontes diferentes.',
    dependencies: 'Usa a tolerancia de razao de horizonte.',
  },
  {
    key: 'horizonRatioTolerance',
    group: 'convergencia',
    label: 'Tolerancia de razao entre horizontes',
    kind: 'number',
    unit: 'x',
    suggested: 3,
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
    label: 'Validade da oportunidade',
    kind: 'number',
    unit: 'min',
    suggested: 10,
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
    label: 'Usar pesos por fonte',
    kind: 'boolean',
    suggested: false,
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation:
      'Quando desligado, todas as fontes valem 1. O peso ponderado continua sendo exibido apenas como informacao.',
    effect:
      'Ligar faz o percentual usar a soma dos pesos. Pesos derivados de desempenho exigem amostra grande e validacao fora da amostra; sem isso, tendem a refletir ruido.',
    dependencies: 'Peso individual configuravel na tela Fontes.',
  },

  // ----- Risco -----
  {
    key: 'sizingMode',
    group: 'risco',
    label: 'Dimensionamento da entrada',
    kind: 'enum',
    suggested: 'RISK_PERCENT',
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation:
      'Lote fixo usa sempre o mesmo volume. Risco percentual calcula o volume a partir da distancia ate o stop.',
    effect:
      'Risco percentual mantem a perda potencial estavel quando a distancia do stop muda; lote fixo nao.',
    dependencies: 'Risco percentual exige stop definido, do sinal ou do padrao configurado.',
    options: [
      { value: 'RISK_PERCENT', label: 'Percentual de risco por operacao' },
      { value: 'FIXED_LOTS', label: 'Lote fixo' },
    ],
  },
  {
    key: 'riskPercentPerTrade',
    group: 'risco',
    label: 'Risco por operacao',
    kind: 'percent',
    unit: '% do patrimonio',
    suggested: 0.5,
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation:
      'Percentual do patrimonio que a distancia ate o stop representa. Este e o valor arriscado, diferente do valor nocional da ordem.',
    effect:
      'Aumentar amplia ganho e perda na mesma proporcao e acelera o consumo do limite diario.',
    dependencies:
      'Usado apenas no modo de risco percentual. Nao garante a perda exata: gaps e deslizamento podem ultrapassar o stop.',
    min: 0.05,
    max: 10,
    step: 0.05,
  },
  {
    key: 'fixedLots',
    group: 'risco',
    label: 'Lote fixo',
    kind: 'number',
    unit: 'lotes',
    suggested: 0.05,
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation:
      'Volume usado quando o dimensionamento e por lote fixo. 0,05 lote em par major vale cerca de USD 0,50 por pip.',
    effect: 'Volume maior aumenta nocional, margem exigida e resultado por pip.',
    dependencies: 'Limitado pelo lote minimo e maximo do instrumento e pela margem livre.',
    min: 0.01,
    max: 50,
    step: 0.01,
  },
  {
    key: 'defaultStopPips',
    group: 'risco',
    label: 'Stop loss padrao',
    kind: 'number',
    unit: 'pips',
    suggested: 20,
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation:
      'Distancia usada quando o sinal nao traz stop. Premissa: 20 pips fica dentro da faixa intradia tipica de pares major, cuja variacao diaria simulada e de 50 a 80 pips.',
    effect: 'Stops curtos sao atingidos com mais frequencia; stops longos aumentam a perda por operacao.',
    dependencies: 'No modo de risco percentual, define o volume calculado.',
    min: 1,
    max: 500,
    step: 1,
  },
  {
    key: 'defaultTakeProfitPips',
    group: 'risco',
    label: 'Take profit padrao',
    kind: 'number',
    unit: 'pips',
    suggested: 30,
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation: 'Alvo usado quando o sinal nao traz alvo. Relacao 1,5 para 1 com o stop padrao.',
    effect: 'Alvos distantes reduzem a taxa de acerto e aumentam o retorno por acerto.',
    dependencies: 'Ignorado quando o sinal traz alvo e o uso de stops do sinal esta ligado.',
    min: 1,
    max: 1000,
    step: 1,
  },
  {
    key: 'useSignalStops',
    group: 'risco',
    label: 'Priorizar stop e alvo do sinal',
    kind: 'boolean',
    suggested: true,
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation: 'Quando o sinal traz stop e alvo, usa os valores dele em vez dos padroes.',
    effect: 'Desligar padroniza todas as operacoes com a mesma distancia.',
    dependencies: 'Se os sinais concordantes trouxerem stops diferentes, usa-se a mediana.',
  },
  {
    key: 'maxOpenPositions',
    group: 'risco',
    label: 'Maximo de operacoes abertas',
    kind: 'number',
    unit: 'posicoes',
    suggested: 1,
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation: 'Quantas posicoes podem estar abertas ao mesmo tempo.',
    effect:
      'Mais posicoes simultaneas aumentam a exposicao agregada, principalmente entre pares correlacionados como EURUSD e GBPUSD.',
    dependencies: 'Tambem limitado pelos tetos de exposicao por ativo e total.',
    min: 1,
    max: 20,
    step: 1,
  },
  {
    key: 'maxExposurePerSymbolNotional',
    group: 'risco',
    label: 'Exposicao maxima por ativo',
    kind: 'number',
    unit: 'USD nocional',
    suggested: 60_000,
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation:
      'Soma maxima do valor nocional aberto em um mesmo instrumento. Premissa: 0,6 lote em par major, coerente com a conta simulada de USD 10.000 e alavancagem 1:30.',
    effect: 'Tetos baixos rejeitam ordens grandes mesmo com margem livre disponivel.',
    dependencies: 'Valor nocional, nao valor arriscado. Depende da alavancagem do instrumento.',
    min: 1000,
    max: 10_000_000,
    step: 1000,
  },
  {
    key: 'maxTotalExposureNotional',
    group: 'risco',
    label: 'Exposicao maxima total',
    kind: 'number',
    unit: 'USD nocional',
    suggested: 120_000,
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation: 'Soma maxima do nocional de todas as posicoes abertas.',
    effect: 'Teto baixo limita o numero efetivo de operacoes simultaneas.',
    dependencies: 'Avaliado junto com a margem livre da conta.',
    min: 1000,
    max: 50_000_000,
    step: 1000,
  },
  {
    key: 'maxTradesPerDay',
    group: 'risco',
    label: 'Operacoes por dia',
    kind: 'number',
    unit: 'operacoes',
    suggested: 6,
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation: 'Numero maximo de entradas no dia operacional.',
    effect: 'Limita o custo acumulado de spread e o efeito de sequencias ruins.',
    dependencies: 'O dia operacional segue o fuso configurado.',
    min: 1,
    max: 200,
    step: 1,
  },
  {
    key: 'minMinutesBetweenEntries',
    group: 'risco',
    label: 'Intervalo minimo entre entradas',
    kind: 'number',
    unit: 'min',
    suggested: 10,
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation:
      'Tempo minimo apos a ultima entrada. Evita rajada de ordens quando varias salas reagem ao mesmo evento.',
    effect: 'Intervalos longos descartam oportunidades proximas.',
    dependencies: 'Independente da janela de agrupamento da convergencia.',
    min: 0,
    max: 1440,
    step: 1,
  },
  {
    key: 'pauseAfterConsecutiveLosses',
    group: 'risco',
    label: 'Pausa apos perdas consecutivas',
    kind: 'number',
    unit: 'perdas',
    suggested: 3,
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation: 'Numero de perdas seguidas que aciona uma pausa automatica.',
    effect: 'Interrompe sequencias ruins; tambem pode interromper antes de uma recuperacao.',
    dependencies: 'Contador zera a cada operacao vencedora e a cada novo dia operacional.',
    min: 0,
    max: 20,
    step: 1,
  },
  {
    key: 'pauseMinutes',
    group: 'risco',
    label: 'Duracao da pausa',
    kind: 'number',
    unit: 'min',
    suggested: 120,
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
    label: 'Stop loss diario',
    kind: 'percent',
    unit: '% da base do dia',
    suggested: 2,
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation:
      'Perda acumulada que bloqueia novas entradas. Base do dia = patrimonio na abertura do dia operacional, sem depositos e saques.',
    effect: 'Limites apertados encerram o dia cedo; limites largos permitem perdas maiores.',
    dependencies:
      'Com 0,5% de risco por operacao, 2% corresponde a cerca de 4 perdas cheias. Stops nao garantem preco exato de execucao.',
    min: 0.1,
    max: 50,
    step: 0.1,
  },
  {
    key: 'dailyProfitTargetPercent',
    group: 'risco',
    label: 'Stop win diario',
    kind: 'percent',
    unit: '% da base do dia',
    suggested: 3,
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation: 'Ganho acumulado que bloqueia novas entradas no dia.',
    effect: 'Preserva o resultado do dia e abre mao de continuidade em dias favoraveis.',
    dependencies: 'Mesma base de calculo do stop diario.',
    min: 0.1,
    max: 100,
    step: 0.1,
  },
  {
    key: 'onDailyLimitCancelPending',
    group: 'risco',
    label: 'Cancelar ordens pendentes no limite diario',
    kind: 'boolean',
    suggested: true,
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation: 'Ao atingir um limite diario, cancela ordens ainda nao executadas.',
    effect: 'Evita entradas disparadas depois do bloqueio.',
    dependencies: 'Independente do encerramento de posicoes abertas.',
  },
  {
    key: 'onDailyLimitClosePositions',
    group: 'risco',
    label: 'Encerrar posicoes abertas no limite diario',
    kind: 'boolean',
    suggested: false,
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation: 'Ao atingir um limite diario, fecha as posicoes que ainda estao abertas.',
    effect:
      'Ligado, realiza o resultado imediatamente ao preco disponivel. Desligado, mantem stop e alvo originais.',
    dependencies:
      'Encerramento a mercado nao garante preco: o preenchimento sai ao preco disponivel no momento.',
  },
  {
    key: 'tradingTimezone',
    group: 'risco',
    label: 'Fuso do dia operacional',
    kind: 'enum',
    suggested: DEFAULT_TIMEZONE,
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation: 'Fuso que define a virada do dia e a leitura dos horarios permitidos.',
    effect: 'Mudar o fuso desloca a virada do dia e o calculo do resultado diario.',
    dependencies: 'A corretora pode usar outro fuso de servidor; a reconciliacao considera ambos.',
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
    label: 'Horarios permitidos',
    kind: 'list',
    suggested: [{ start: '05:00', end: '18:00' }],
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation:
      'Faixas de horario em que novas entradas sao aceitas. Premissa: 05:00 as 18:00 em Sao Paulo cobre as sessoes de Londres e Nova York, onde a liquidez de pares major e maior.',
    effect: 'Faixas largas incluem horarios de spread alto, como a virada asiatica.',
    dependencies: 'Interpretado no fuso do dia operacional.',
  },
  {
    key: 'tradingDays',
    group: 'risco',
    label: 'Dias permitidos',
    kind: 'list',
    suggested: [1, 2, 3, 4, 5],
    basis: 'LIMITE_TECNICO',
    explanation: 'Forex spot nao negocia no fim de semana; sabado e domingo ficam desligados.',
    effect: 'Habilitar fim de semana nao gera negocios: o mercado esta fechado.',
    dependencies: 'Restricao do mercado escolhido, nao uma preferencia.',
  },
  {
    key: 'maxSpreadPips',
    group: 'execucao',
    label: 'Spread maximo aceito',
    kind: 'number',
    unit: 'pips',
    suggested: 2.5,
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation:
      'Bloqueia envio quando o spread do momento passa do limite. Premissa: spread tipico simulado dos majors fica entre 0,8 e 1,4 pip.',
    effect: 'Limite baixo recusa mais ordens em noticias; limite alto aceita custo de entrada maior.',
    dependencies: 'Depende do spread informado pela corretora conectada.',
    min: 0.1,
    max: 50,
    step: 0.1,
  },
  {
    key: 'maxPriceDeviationPips',
    group: 'execucao',
    label: 'Desvio maximo do preco do sinal',
    kind: 'number',
    unit: 'pips',
    suggested: 6,
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation:
      'Distancia maxima entre o preco atual e o preco de referencia da oportunidade no momento do envio.',
    effect: 'Valores baixos descartam oportunidades que ja correram; altos aceitam entrada pior.',
    dependencies:
      'So se aplica quando a oportunidade tem preco de referencia. Nao e garantia de preenchimento nesse preco.',
    min: 0,
    max: 200,
    step: 0.5,
  },
  {
    key: 'maxQuoteAgeSeconds',
    group: 'execucao',
    label: 'Idade maxima da cotacao',
    kind: 'number',
    unit: 's',
    suggested: 20,
    basis: 'LIMITE_TECNICO',
    explanation:
      'Se a ultima cotacao for mais antiga que isto, novas ordens sao bloqueadas por dado desatualizado.',
    effect: 'Valores altos permitem operar as cegas apos falha de conexao.',
    dependencies: 'Depende da frequencia de atualizacao do conector da corretora.',
    min: 1,
    max: 300,
    step: 1,
  },
  {
    key: 'maxExecutionsPerOpportunity',
    group: 'execucao',
    label: 'Execucoes por oportunidade',
    kind: 'number',
    unit: 'ordens',
    suggested: 1,
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation:
      'Quantas ordens uma mesma convergencia pode gerar. Atualizacoes da convergencia nao criam entrada nova enquanto o limite estiver atingido.',
    effect: 'Valores acima de 1 permitem acumular posicao na mesma convergencia.',
    dependencies: 'A identidade e a chave do agrupamento, nao a versao. Reenvios reusam a mesma chave de ordem.',
    min: 1,
    max: 10,
    step: 1,
  },
  {
    key: 'martingaleEnabled',
    group: 'risco',
    label: 'Martingale',
    kind: 'boolean',
    suggested: false,
    basis: 'PADRAO_INICIAL_SIMULACAO',
    explanation: 'Aumentar o volume apos perdas para tentar recuperar o prejuizo.',
    effect:
      'Eleva a exposicao justamente apos perdas e concentra o risco de ruina em poucas sequencias adversas.',
    dependencies: 'Desativado por padrao e mantido desativado nos cenarios de demonstracao.',
  },
];

export const descriptorByKey = new Map(settingDescriptors.map((d) => [d.key, d]));
