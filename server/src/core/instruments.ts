import type { MarketId, ProductType, Venue } from './types.ts';

/**
 * Catalogo de instrumentos dos dois mercados.
 *
 * Duas unidades de preco, com papeis distintos:
 *
 *  - `tickSize`: menor incremento de preco. Serve para ARREDONDAR.
 *  - `pipSize`:  unidade de DISTANCIA usada em stops, alvos e tolerancias.
 *
 * Em forex o pip e a convencao de mercado (0,0001 nos majors). Em cripto nao
 * existe pip, entao adotamos 1 pip = 0,01% do preco de referencia do instrumento.
 * Com isso "20 pips" significa a mesma distancia relativa em BTC e em SOL, e o
 * mesmo motor de risco serve os dois mercados sem numero magico por ativo.
 *
 * Os precos de referencia sao pontos de partida ARBITRARIOS do simulador. Nao sao
 * cotacao de mercado e nao devem ser lidos como tal.
 */
export interface Instrument {
  symbol: string;
  marketId: MarketId;
  productType: ProductType;
  venue: Venue;
  base: string;
  quote: string;
  /** Moeda em que o resultado e liquidado. */
  settlement: string;
  /** Rotulo do contrato, quando derivativo. */
  contractType: 'SPOT' | 'PERPETUAL' | null;
  /** Casas decimais do preco. */
  digits: number;
  /** Menor incremento de preco. */
  tickSize: number;
  /**
   * Unidade de distancia para stop, alvo e tolerancia, no preco de referencia do
   * catalogo. Para instrumentos com `pipBasis: 'PERCENT'` este e apenas o valor de
   * partida: use `pipSizeFor(instrument, preco)` para obter a unidade vigente.
   */
  pipSize: number;
  /**
   * Como a unidade de distancia e definida.
   *  - ABSOLUTE: valor fixo em unidades de preco (convencao de forex).
   *  - PERCENT: fracao do preco corrente. Em cripto adotamos 0,01%, para que
   *    "150 pips" signifique 1,5% tanto em BTC a 76.000 quanto em SOL a 100.
   */
  pipBasis: 'ABSOLUTE' | 'PERCENT';
  /** Fracao do preco que vale 1 pip, quando `pipBasis === 'PERCENT'`. */
  pipPercent?: number;
  /** Unidades da moeda base em 1 unidade de quantidade. */
  contractSize: number;
  /**
   * Valor de 1 pip por unidade de quantidade, na moeda da conta. Quando ausente,
   * vale `pipSize * contractSize` — correto para pares cotados na moeda da conta.
   */
  pipValueOverride?: number;
  /** Alavancagem nominal usada para calcular margem. 1 = precisa do valor cheio. */
  leverage: number;
  /** Spread tipico simulado, em pips. Premissa de demonstracao. */
  typicalSpreadPips: number;
  /** Volatilidade diaria aproximada em pips. Premissa de demonstracao. */
  dailyVolatilityPips: number;
  referencePrice: number;
  quantityStep: number;
  minQuantity: number;
  maxQuantity: number;
  /** Valor nocional minimo aceito pela venue. */
  minNotional: number;
  quantityLabel: string;
  /** Negocia 24 horas por dia, 7 dias por semana. */
  tradesAllWeek: boolean;
  /**
   * Par correspondente no provedor de cotacao de referencia (AwesomeAPI), no
   * formato CODE-CODEIN. `null` quando o provedor nao cobre o instrumento — caso
   * do EURUSD-OTC, que e sintetico deste projeto, e de cripto, cuja integracao
   * ainda nao foi feita. Nunca substituir por um par "parecido": turismo e PTAX
   * NAO sao equivalentes a forex.
   */
  externalPair: string | null;
  /** Exchange ou provedor de origem do preco, quando aplicavel. */
  exchange: string | null;
  /** Simbolo no provedor de cripto (Binance Spot). */
  externalSymbol: string | null;
}

const forex: Instrument[] = [
  {
    symbol: 'EURUSD',
    marketId: 'FOREX',
    productType: 'FX_SPOT',
    venue: 'REGULAR',
    base: 'EUR',
    quote: 'USD',
    settlement: 'USD',
    contractType: 'SPOT',
    digits: 5,
    tickSize: 0.00001,
    pipSize: 0.0001,
    pipBasis: 'ABSOLUTE',
    contractSize: 100_000,
    leverage: 30,
    typicalSpreadPips: 0.8,
    dailyVolatilityPips: 60,
    referencePrice: 1.085,
    quantityStep: 0.01,
    minQuantity: 0.01,
    maxQuantity: 50,
    minNotional: 0,
    quantityLabel: 'lote',
    tradesAllWeek: false,
    externalPair: 'EUR-USD',
    exchange: null,
    externalSymbol: null,
  },
  {
    symbol: 'GBPUSD',
    marketId: 'FOREX',
    productType: 'FX_SPOT',
    venue: 'REGULAR',
    base: 'GBP',
    quote: 'USD',
    settlement: 'USD',
    contractType: 'SPOT',
    digits: 5,
    tickSize: 0.00001,
    pipSize: 0.0001,
    pipBasis: 'ABSOLUTE',
    contractSize: 100_000,
    leverage: 30,
    typicalSpreadPips: 1.2,
    dailyVolatilityPips: 80,
    referencePrice: 1.268,
    quantityStep: 0.01,
    minQuantity: 0.01,
    maxQuantity: 50,
    minNotional: 0,
    quantityLabel: 'lote',
    tradesAllWeek: false,
    externalPair: 'GBP-USD',
    exchange: null,
    externalSymbol: null,
  },
  {
    symbol: 'USDJPY',
    marketId: 'FOREX',
    productType: 'FX_SPOT',
    venue: 'REGULAR',
    base: 'USD',
    quote: 'JPY',
    settlement: 'USD',
    contractType: 'SPOT',
    digits: 3,
    tickSize: 0.001,
    pipSize: 0.01,
    pipBasis: 'ABSOLUTE',
    contractSize: 100_000,
    // 1 pip = 0,01 JPY x 100.000 = 1.000 JPY. A ~155 JPY/USD da ~6,45 USD.
    pipValueOverride: 6.45,
    leverage: 30,
    typicalSpreadPips: 1.0,
    dailyVolatilityPips: 70,
    referencePrice: 155.2,
    quantityStep: 0.01,
    minQuantity: 0.01,
    maxQuantity: 50,
    minNotional: 0,
    quantityLabel: 'lote',
    tradesAllWeek: false,
    externalPair: 'USD-JPY',
    exchange: null,
    externalSymbol: null,
  },
  {
    symbol: 'AUDUSD',
    marketId: 'FOREX',
    productType: 'FX_SPOT',
    venue: 'REGULAR',
    base: 'AUD',
    quote: 'USD',
    settlement: 'USD',
    contractType: 'SPOT',
    digits: 5,
    tickSize: 0.00001,
    pipSize: 0.0001,
    pipBasis: 'ABSOLUTE',
    contractSize: 100_000,
    leverage: 30,
    typicalSpreadPips: 1.0,
    dailyVolatilityPips: 55,
    referencePrice: 0.654,
    quantityStep: 0.01,
    minQuantity: 0.01,
    maxQuantity: 50,
    minNotional: 0,
    quantityLabel: 'lote',
    tradesAllWeek: false,
    externalPair: 'AUD-USD',
    exchange: null,
    externalSymbol: null,
  },
  {
    symbol: 'USDCHF',
    marketId: 'FOREX',
    productType: 'FX_SPOT',
    venue: 'REGULAR',
    base: 'USD',
    quote: 'CHF',
    settlement: 'USD',
    contractType: 'SPOT',
    digits: 5,
    tickSize: 0.00001,
    pipSize: 0.0001,
    pipBasis: 'ABSOLUTE',
    contractSize: 100_000,
    pipValueOverride: 11.2,
    leverage: 30,
    typicalSpreadPips: 1.4,
    dailyVolatilityPips: 50,
    referencePrice: 0.889,
    quantityStep: 0.01,
    minQuantity: 0.01,
    maxQuantity: 50,
    minNotional: 0,
    quantityLabel: 'lote',
    tradesAllWeek: false,
    externalPair: 'USD-CHF',
    exchange: null,
    externalSymbol: null,
  },
  {
    /**
     * Instrumento OTC proposital, para demonstrar que o motor NAO compara OTC com
     * mercado regular mesmo quando o nome do ativo e parecido.
     */
    symbol: 'EURUSD-OTC',
    marketId: 'FOREX',
    productType: 'FX_SPOT',
    venue: 'OTC',
    base: 'EUR',
    quote: 'USD',
    settlement: 'USD',
    contractType: 'SPOT',
    digits: 5,
    tickSize: 0.00001,
    pipSize: 0.0001,
    pipBasis: 'ABSOLUTE',
    contractSize: 100_000,
    leverage: 30,
    typicalSpreadPips: 2.5,
    dailyVolatilityPips: 60,
    referencePrice: 1.085,
    quantityStep: 0.01,
    minQuantity: 0.01,
    maxQuantity: 10,
    minNotional: 0,
    quantityLabel: 'lote',
    tradesAllWeek: false,
    externalPair: null,
    exchange: null,
    externalSymbol: null,
  },
];

/**
 * Cripto. Precos de referencia sao pontos de partida arbitrarios do simulador.
 * `pipSize` = 0,01% do preco de referencia, conforme a convencao explicada acima.
 */
const crypto: Instrument[] = [
  {
    symbol: 'BTCUSDT',
    marketId: 'CRYPTO',
    productType: 'CRYPTO_SPOT',
    venue: 'REGULAR',
    base: 'BTC',
    quote: 'USDT',
    settlement: 'USDT',
    contractType: 'SPOT',
    digits: 2,
    tickSize: 0.01,
    pipSize: 7.25,
    pipBasis: 'PERCENT',
    pipPercent: 0.0001,
    contractSize: 1,
    leverage: 1,
    typicalSpreadPips: 0.4,
    dailyVolatilityPips: 320,
    referencePrice: 72_500,
    quantityStep: 0.0001,
    minQuantity: 0.0001,
    maxQuantity: 50,
    minNotional: 10,
    quantityLabel: 'BTC',
    tradesAllWeek: true,
    externalPair: null,
    exchange: 'BINANCE_SPOT',
    externalSymbol: 'BTCUSDT',
  },
  {
    symbol: 'ETHUSDT',
    marketId: 'CRYPTO',
    productType: 'CRYPTO_SPOT',
    venue: 'REGULAR',
    base: 'ETH',
    quote: 'USDT',
    settlement: 'USDT',
    contractType: 'SPOT',
    digits: 2,
    tickSize: 0.01,
    pipSize: 0.385,
    pipBasis: 'PERCENT',
    pipPercent: 0.0001,
    contractSize: 1,
    leverage: 1,
    typicalSpreadPips: 0.5,
    dailyVolatilityPips: 380,
    referencePrice: 3_850,
    quantityStep: 0.001,
    minQuantity: 0.001,
    maxQuantity: 500,
    minNotional: 10,
    quantityLabel: 'ETH',
    tradesAllWeek: true,
    externalPair: null,
    exchange: 'BINANCE_SPOT',
    externalSymbol: 'ETHUSDT',
  },
  {
    symbol: 'SOLUSDT',
    marketId: 'CRYPTO',
    productType: 'CRYPTO_SPOT',
    venue: 'REGULAR',
    base: 'SOL',
    quote: 'USDT',
    settlement: 'USDT',
    contractType: 'SPOT',
    digits: 3,
    tickSize: 0.001,
    pipSize: 0.0172,
    pipBasis: 'PERCENT',
    pipPercent: 0.0001,
    contractSize: 1,
    leverage: 1,
    typicalSpreadPips: 0.8,
    dailyVolatilityPips: 520,
    referencePrice: 172,
    quantityStep: 0.01,
    minQuantity: 0.01,
    maxQuantity: 20_000,
    minNotional: 10,
    quantityLabel: 'SOL',
    tradesAllWeek: true,
    externalPair: null,
    exchange: 'BINANCE_SPOT',
    externalSymbol: 'SOLUSDT',
  },
  {
    /**
     * Perpetuo. Mesmo par do a vista, produto diferente: alavancado, liquidado em
     * margem. O motor jamais junta os votos de BTCUSDT com os de BTCUSDT-PERP.
     */
    symbol: 'BTCUSDT-PERP',
    marketId: 'CRYPTO',
    productType: 'CRYPTO_PERP',
    venue: 'REGULAR',
    base: 'BTC',
    quote: 'USDT',
    settlement: 'USDT',
    contractType: 'PERPETUAL',
    digits: 1,
    tickSize: 0.1,
    pipSize: 7.25,
    pipBasis: 'PERCENT',
    pipPercent: 0.0001,
    contractSize: 1,
    leverage: 5,
    typicalSpreadPips: 0.3,
    dailyVolatilityPips: 340,
    referencePrice: 72_520,
    quantityStep: 0.001,
    minQuantity: 0.001,
    maxQuantity: 100,
    minNotional: 10,
    quantityLabel: 'contrato',
    tradesAllWeek: true,
    externalPair: null,
    exchange: null,
    externalSymbol: null,
  },
  {
    symbol: 'ETHUSDT-PERP',
    marketId: 'CRYPTO',
    productType: 'CRYPTO_PERP',
    venue: 'REGULAR',
    base: 'ETH',
    quote: 'USDT',
    settlement: 'USDT',
    contractType: 'PERPETUAL',
    digits: 2,
    tickSize: 0.01,
    pipSize: 0.385,
    pipBasis: 'PERCENT',
    pipPercent: 0.0001,
    contractSize: 1,
    leverage: 5,
    typicalSpreadPips: 0.4,
    dailyVolatilityPips: 400,
    referencePrice: 3_852,
    quantityStep: 0.01,
    minQuantity: 0.01,
    maxQuantity: 1_000,
    minNotional: 10,
    quantityLabel: 'contrato',
    tradesAllWeek: true,
    externalPair: null,
    exchange: null,
    externalSymbol: null,
  },
];

const list: Instrument[] = [...forex, ...crypto];

const bySymbol = new Map(list.map((i) => [i.symbol, i]));

export const INSTRUMENTS = list;

export function instrumentsOfMarket(marketId: MarketId): Instrument[] {
  return list.filter((i) => i.marketId === marketId);
}

export function getInstrument(symbol: string): Instrument | undefined {
  return bySymbol.get(symbol.toUpperCase());
}

export function requireInstrument(symbol: string): Instrument {
  const found = getInstrument(symbol);
  if (!found) throw new Error(`Instrumento nao suportado: ${symbol}`);
  return found;
}

/**
 * Unidade de distancia vigente do instrumento.
 *
 * Em forex e um valor fixo. Em cripto e uma fracao do preco, entao depende do
 * preco no momento: sem isto, "150 pips" derivado de um preco de catalogo antigo
 * passaria a significar outra distancia relativa assim que o mercado andasse.
 */
export function pipSizeFor(instrument: Instrument, price?: number | null): number {
  if (instrument.pipBasis === 'ABSOLUTE') return instrument.pipSize;
  const base = price != null && Number.isFinite(price) && price > 0 ? price : instrument.referencePrice;
  return base * (instrument.pipPercent ?? 0.0001);
}

export function priceToPips(instrument: Instrument, priceDelta: number, price?: number | null): number {
  return priceDelta / pipSizeFor(instrument, price);
}

export function pipsToPrice(instrument: Instrument, pips: number, price?: number | null): number {
  return pips * pipSizeFor(instrument, price);
}

export function roundPrice(instrument: Instrument, price: number): number {
  const steps = Math.round(price / instrument.tickSize);
  const rounded = steps * instrument.tickSize;
  const factor = 10 ** instrument.digits;
  return Math.round(rounded * factor) / factor;
}

export function roundQuantity(instrument: Instrument, quantity: number): number {
  const steps = Math.floor(quantity / instrument.quantityStep + 1e-9);
  const rounded = steps * instrument.quantityStep;
  // Casas decimais suficientes para o passo do instrumento.
  const decimals = Math.max(0, Math.ceil(-Math.log10(instrument.quantityStep)));
  const factor = 10 ** decimals;
  return Math.round(rounded * factor) / factor;
}

/** Valor nocional da posicao, na moeda de liquidacao. */
export function notionalValue(instrument: Instrument, quantity: number, price: number): number {
  // Par com a moeda da conta na base (USDJPY, USDCHF): o nocional ja esta em USD.
  if (instrument.base === 'USD' && instrument.quote !== 'USD') {
    return quantity * instrument.contractSize;
  }
  return quantity * instrument.contractSize * price;
}

export function requiredMargin(instrument: Instrument, quantity: number, price: number): number {
  return notionalValue(instrument, quantity, price) / instrument.leverage;
}

/**
 * Valor de 1 pip para a quantidade informada, na moeda de liquidacao.
 *
 * `price` importa nos instrumentos com pip percentual: em cripto o valor do pip
 * acompanha o preco corrente.
 */
export function pipValue(instrument: Instrument, quantity: number, price?: number | null): number {
  const perUnit =
    instrument.pipValueOverride ?? pipSizeFor(instrument, price) * instrument.contractSize;
  return perUnit * quantity;
}
