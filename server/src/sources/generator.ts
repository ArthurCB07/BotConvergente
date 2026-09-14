import { getInstrument, instrumentsOfMarket, pipsToPrice, roundPrice } from '../core/instruments.ts';
import { id } from '../core/ids.ts';
import type { Engine } from '../engine/engine.ts';
import type { MarketId, Side } from '../core/types.ts';
import { MARKET_IDS } from '../core/types.ts';

/**
 * Gerador de sinais para o prototipo.
 *
 * Produz mensagens com a mesma forma das que viriam de uma sala real: texto livre
 * mais campos normalizados. Cada rodada acontece dentro de UM mercado, usando
 * apenas as fontes cadastradas para ele. Nao imita o comportamento estatistico de
 * nenhum provedor real.
 */

function pick<T>(items: T[], rnd: () => number): T {
  const index = Math.floor(rnd() * items.length);
  return items[Math.min(index, items.length - 1)] as T;
}

export interface GeneratorConfig {
  intervalSeconds: number;
  agreementProbability: number;
  dissentProbability: number;
  /** Mercados em que o gerador atua. */
  markets: MarketId[];
}

export const defaultGeneratorConfig: GeneratorConfig = {
  intervalSeconds: 45,
  agreementProbability: 0.55,
  dissentProbability: 0.25,
  markets: ['FOREX', 'CRYPTO'],
};

export class SignalGenerator {
  private timer: NodeJS.Timeout | null = null;
  private engine: Engine;
  config: GeneratorConfig;

  constructor(engine: Engine, config: GeneratorConfig = defaultGeneratorConfig) {
    this.engine = engine;
    this.config = { ...config, markets: [...config.markets] };
  }

  get running(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.roundAll(), this.config.intervalSeconds * 1000);
    this.engine.log(
      'SCENARIO_RUN',
      'INFO',
      null,
      'Gerador de sinais iniciado',
      `Uma rodada a cada ${this.config.intervalSeconds} s em ${this.config.markets.join(' e ')}.`,
    );
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.engine.log(
      'SCENARIO_RUN',
      'INFO',
      null,
      'Gerador de sinais parado',
      'Nenhuma mensagem sintetica sera criada.',
    );
  }

  setConfig(patch: Partial<GeneratorConfig>): void {
    const wasRunning = this.running;
    this.stop();
    this.config = { ...this.config, ...patch };
    if (wasRunning) this.start();
  }

  roundAll(): void {
    for (const marketId of MARKET_IDS) {
      if (this.config.markets.includes(marketId)) this.round(marketId);
    }
  }

  /** Uma rodada em um mercado: escolhe instrumento e distribui sinais entre as fontes. */
  round(marketId: MarketId): void {
    const rnd = Math.random;
    const generatorSources = this.engine.sources.filter(
      (s) => s.kind === 'GENERATOR' && s.enabled && s.markets.includes(marketId),
    );
    if (generatorSources.length === 0) return;

    const pool = instrumentsOfMarket(marketId).filter((i) => i.venue === 'REGULAR');
    if (pool.length === 0) return;
    const instrument = pick(pool, rnd);

    const broker = this.engine.brokerFor(marketId);
    const quote = broker.getQuote(instrument.symbol);
    const mid = quote ? (quote.bid + quote.ask) / 2 : instrument.referencePrice;

    const agreeing = rnd() < this.config.agreementProbability;
    const baseSide: Side = rnd() < 0.5 ? 'BUY' : 'SELL';
    const timeframe = pick([5, 15, 15, 30, 60], rnd);

    const participants = agreeing ? generatorSources : generatorSources.filter(() => rnd() < 0.5);

    for (const source of participants) {
      const dissent = agreeing && rnd() < this.config.dissentProbability;
      const side: Side = agreeing
        ? dissent
          ? baseSide === 'BUY'
            ? 'SELL'
            : 'BUY'
          : baseSide
        : rnd() < 0.5
          ? 'BUY'
          : 'SELL';
      // Dispersao proporcional a tolerancia do mercado.
      const spread = this.engine.markets[marketId].convergence.entryTolerancePips;
      const jitterPips = (rnd() - 0.5) * spread;
      const entry = roundPrice(instrument, mid + pipsToPrice(instrument, jitterPips, mid));
      const stopPips = this.engine.markets[marketId].risk.defaultStopPips * (0.75 + rnd() * 0.5);
      const tpPips = stopPips * (1.2 + rnd());
      const stopLoss = roundPrice(
        instrument,
        side === 'BUY'
          ? entry - pipsToPrice(instrument, stopPips, mid)
          : entry + pipsToPrice(instrument, stopPips, mid),
      );
      const takeProfit = roundPrice(
        instrument,
        side === 'BUY'
          ? entry + pipsToPrice(instrument, tpPips, mid)
          : entry - pipsToPrice(instrument, tpPips, mid),
      );

      const text =
        `${side === 'BUY' ? 'COMPRA' : 'VENDA'} ${instrument.symbol} M${timeframe} ` +
        `entrada: ${entry} SL: ${stopLoss} TP: ${takeProfit}`;

      this.engine.ingestSignal({
        sourceId: source.id,
        raw: { text, externalMessageId: id('msg') },
        parsedBy: 'GENERATOR',
        marketId,
        symbol: instrument.symbol,
        venue: instrument.venue,
        side,
        emittedAt: this.engine.clock.nowIso(),
        timeframeMinutes: timeframe,
        horizonMinutes: timeframe * 4,
        entryType: 'LIMIT',
        entryPrice: entry,
        stopLoss,
        takeProfit,
      });
    }
  }

  /** Rodada dirigida, usada pelos cenarios de demonstracao. */
  emit(params: {
    sourceId: string;
    symbol: string;
    side: Side;
    entryOffsetPips?: number;
    timeframeMinutes?: number;
    horizonMinutes?: number;
    externalMessageId?: string;
    validUntilMinutes?: number;
    withStops?: boolean;
  }): { ok: boolean; message: string; signalId?: string } {
    const instrument = getInstrument(params.symbol);
    if (!instrument) return { ok: false, message: 'Instrumento desconhecido.' };
    const marketId = instrument.marketId;
    const broker = this.engine.brokerFor(marketId);
    const quote = broker.getQuote(instrument.symbol);
    const mid = quote ? (quote.bid + quote.ask) / 2 : instrument.referencePrice;
    const entry = roundPrice(instrument, mid + pipsToPrice(instrument, params.entryOffsetPips ?? 0, mid));
    const timeframe = params.timeframeMinutes ?? 15;
    const risk = this.engine.markets[marketId].risk;
    const stopPips = risk.defaultStopPips;
    const tpPips = risk.defaultTakeProfitPips;
    const withStops = params.withStops ?? true;
    const stopLoss = withStops
      ? roundPrice(
          instrument,
          params.side === 'BUY'
            ? entry - pipsToPrice(instrument, stopPips, mid)
            : entry + pipsToPrice(instrument, stopPips, mid),
        )
      : null;
    const takeProfit = withStops
      ? roundPrice(
          instrument,
          params.side === 'BUY'
            ? entry + pipsToPrice(instrument, tpPips, mid)
            : entry - pipsToPrice(instrument, tpPips, mid),
        )
      : null;

    return this.engine.ingestSignal({
      sourceId: params.sourceId,
      raw: {
        text: `${params.side === 'BUY' ? 'COMPRA' : 'VENDA'} ${instrument.symbol} M${timeframe} entrada: ${entry}${stopLoss ? ` SL: ${stopLoss}` : ''}${takeProfit ? ` TP: ${takeProfit}` : ''}`,
        externalMessageId: params.externalMessageId ?? id('msg'),
      },
      parsedBy: 'GENERATOR',
      marketId,
      symbol: instrument.symbol,
      venue: instrument.venue,
      side: params.side,
      emittedAt: this.engine.clock.nowIso(),
      timeframeMinutes: timeframe,
      horizonMinutes: params.horizonMinutes ?? timeframe * 4,
      validUntil: params.validUntilMinutes
        ? new Date(
            Date.parse(this.engine.clock.nowIso()) + params.validUntilMinutes * 60_000,
          ).toISOString()
        : null,
      entryType: 'LIMIT',
      entryPrice: entry,
      stopLoss,
      takeProfit,
    });
  }
}
