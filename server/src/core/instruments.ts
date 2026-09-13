import type { Market, Venue } from './types.ts';

/**
 * Catalogo de instrumentos do MVP.
 *
 * Escopo: FOREX SPOT, pares major. Valores de contrato e pip seguem a convencao
 * padrao de forex de varejo (lote padrao = 100.000 unidades da moeda base).
 * `pipValuePerLotQuote` e o valor de 1 pip por lote padrao, expresso na moeda
 * de cotacao. Para pares terminados em USD isso equivale a USD 10 por pip.
 */
export interface Instrument {
  symbol: string;
  market: Market;
  venue: Venue;
  base: string;
  quote: string;
  /** Casas decimais do preco. */
  digits: number;
  /** Tamanho de 1 pip em unidades de preco. */
  pipSize: number;
  /** Unidades da moeda base em 1 lote padrao. */
  contractSize: number;
  /** Valor de 1 pip por lote padrao, na moeda de cotacao. */
  pipValuePerLotQuote: number;
  /** Alavancagem nominal usada para calcular margem na conta simulada. */
  leverage: number;
  /** Spread tipico simulado, em pips. Premissa de demonstracao. */
  typicalSpreadPips: number;
  /** Volatilidade diaria aproximada em pips. Premissa de demonstracao. */
  dailyVolatilityPips: number;
  referencePrice: number;
  lotStep: number;
  minLots: number;
  maxLots: number;
}

const list: Instrument[] = [
  {
    symbol: 'EURUSD',
    market: 'FX_SPOT',
    venue: 'REGULAR',
    base: 'EUR',
    quote: 'USD',
    digits: 5,
    pipSize: 0.0001,
    contractSize: 100_000,
    pipValuePerLotQuote: 10,
    leverage: 30,
    typicalSpreadPips: 0.8,
    dailyVolatilityPips: 60,
    referencePrice: 1.0850,
    lotStep: 0.01,
    minLots: 0.01,
    maxLots: 50,
  },
  {
    symbol: 'GBPUSD',
    market: 'FX_SPOT',
    venue: 'REGULAR',
    base: 'GBP',
    quote: 'USD',
    digits: 5,
    pipSize: 0.0001,
    contractSize: 100_000,
    pipValuePerLotQuote: 10,
    leverage: 30,
    typicalSpreadPips: 1.2,
    dailyVolatilityPips: 80,
    referencePrice: 1.2680,
    lotStep: 0.01,
    minLots: 0.01,
    maxLots: 50,
  },
  {
    symbol: 'USDJPY',
    market: 'FX_SPOT',
    venue: 'REGULAR',
    base: 'USD',
    quote: 'JPY',
    digits: 3,
    pipSize: 0.01,
    contractSize: 100_000,
    // 1 pip = 0,01 JPY x 100.000 = 1.000 JPY. Convertido a ~155 JPY/USD da ~6,45 USD.
    pipValuePerLotQuote: 6.45,
    leverage: 30,
    typicalSpreadPips: 1.0,
    dailyVolatilityPips: 70,
    referencePrice: 155.20,
    lotStep: 0.01,
    minLots: 0.01,
    maxLots: 50,
  },
  {
    symbol: 'AUDUSD',
    market: 'FX_SPOT',
    venue: 'REGULAR',
    base: 'AUD',
    quote: 'USD',
    digits: 5,
    pipSize: 0.0001,
    contractSize: 100_000,
    pipValuePerLotQuote: 10,
    leverage: 30,
    typicalSpreadPips: 1.0,
    dailyVolatilityPips: 55,
    referencePrice: 0.6540,
    lotStep: 0.01,
    minLots: 0.01,
    maxLots: 50,
  },
  {
    symbol: 'USDCHF',
    market: 'FX_SPOT',
    venue: 'REGULAR',
    base: 'USD',
    quote: 'CHF',
    digits: 5,
    pipSize: 0.0001,
    contractSize: 100_000,
    pipValuePerLotQuote: 11.2,
    leverage: 30,
    typicalSpreadPips: 1.4,
    dailyVolatilityPips: 50,
    referencePrice: 0.8890,
    lotStep: 0.01,
    minLots: 0.01,
    maxLots: 50,
  },
  {
    /**
     * Instrumento OTC proposital, para demonstrar que o motor NAO compara OTC com
     * mercado regular mesmo quando o nome do ativo e parecido.
     */
    symbol: 'EURUSD-OTC',
    market: 'FX_SPOT',
    venue: 'OTC',
    base: 'EUR',
    quote: 'USD',
    digits: 5,
    pipSize: 0.0001,
    contractSize: 100_000,
    pipValuePerLotQuote: 10,
    leverage: 30,
    typicalSpreadPips: 2.5,
    dailyVolatilityPips: 60,
    referencePrice: 1.0850,
    lotStep: 0.01,
    minLots: 0.01,
    maxLots: 10,
  },
];

const bySymbol = new Map(list.map((i) => [i.symbol, i]));

export const INSTRUMENTS = list;

export function getInstrument(symbol: string): Instrument | undefined {
  return bySymbol.get(symbol.toUpperCase());
}

export function requireInstrument(symbol: string): Instrument {
  const found = getInstrument(symbol);
  if (!found) throw new Error(`Instrumento nao suportado: ${symbol}`);
  return found;
}

export function priceToPips(instrument: Instrument, priceDelta: number): number {
  return priceDelta / instrument.pipSize;
}

export function pipsToPrice(instrument: Instrument, pips: number): number {
  return pips * instrument.pipSize;
}

export function roundPrice(instrument: Instrument, price: number): number {
  const f = 10 ** instrument.digits;
  return Math.round(price * f) / f;
}

export function roundLots(instrument: Instrument, lots: number): number {
  const steps = Math.floor(lots / instrument.lotStep + 1e-9);
  const rounded = steps * instrument.lotStep;
  return Math.round(rounded * 100) / 100;
}

/** Valor nocional da ordem, na moeda da conta (USD nesta simulacao). */
export function notionalValue(instrument: Instrument, lots: number, price: number): number {
  if (instrument.base === 'USD') return lots * instrument.contractSize;
  // Par XXX/USD: nocional em USD = lotes x contrato x preco.
  if (instrument.quote === 'USD') return lots * instrument.contractSize * price;
  // Fallback conservador para pares sem USD na cotacao.
  return lots * instrument.contractSize * price;
}

export function requiredMargin(instrument: Instrument, lots: number, price: number): number {
  return notionalValue(instrument, lots, price) / instrument.leverage;
}

/** Valor de 1 pip por lote, aproximado para a moeda da conta (USD). */
export function pipValueUsd(instrument: Instrument, lots: number): number {
  return instrument.pipValuePerLotQuote * lots;
}
