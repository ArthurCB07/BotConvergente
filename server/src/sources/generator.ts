import { INSTRUMENTS, getInstrument, pipsToPrice, roundPrice } from '../core/instruments.ts';
import { id } from '../core/ids.ts';
import type { Engine } from '../engine/engine.ts';
import type { Side } from '../core/types.ts';

/**
 * Gerador de sinais para o prototipo.
 *
 * Produz mensagens com a mesma forma das que viriam de uma sala real: texto livre
 * mais campos normalizados. Serve para exercitar o motor; nao imita o comportamento
 * estatistico de nenhum provedor real.
 */

const REGULAR = INSTRUMENTS.filter((i) => i.venue === 'REGULAR');

function pick<T>(items: T[], rnd: () => number): T {
  const index = Math.floor(rnd() * items.length);
  return items[Math.min(index, items.length - 1)] as T;
}

export interface GeneratorConfig {
  /** Intervalo medio entre rodadas de sinais, em segundos. */
  intervalSeconds: number;
  /** Probabilidade de uma rodada gerar concordancia entre varias fontes. */
  agreementProbability: number;
  /** Probabilidade de uma fonte discordar dentro de uma rodada concordante. */
  dissentProbability: number;
}

export const defaultGeneratorConfig: GeneratorConfig = {
  intervalSeconds: 45,
  agreementProbability: 0.55,
  dissentProbability: 0.25,
};

export class SignalGenerator {
  private timer: NodeJS.Timeout | null = null;
  private engine: Engine;
  config: GeneratorConfig;

  constructor(engine: Engine, config: GeneratorConfig = defaultGeneratorConfig) {
    this.engine = engine;
    this.config = { ...config };
  }

  get running(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.round(), this.config.intervalSeconds * 1000);
    this.engine.log('SCENARIO_RUN', 'INFO', 'Gerador de sinais iniciado', `Uma rodada a cada ${this.config.intervalSeconds} s.`);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.engine.log('SCENARIO_RUN', 'INFO', 'Gerador de sinais parado', 'Nenhuma mensagem sintetica sera criada.');
  }

  setConfig(patch: Partial<GeneratorConfig>): void {
    const wasRunning = this.running;
    this.stop();
    this.config = { ...this.config, ...patch };
    if (wasRunning) this.start();
  }

  /** Uma rodada: escolhe instrumento e distribui sinais entre as fontes geradoras. */
  round(): void {
    const rnd = Math.random;
    const generatorSources = this.engine.sources.filter((s) => s.kind === 'GENERATOR' && s.enabled);
    if (generatorSources.length === 0) return;

    const instrument = pick(REGULAR, rnd);
    const quote = this.engine.broker.getQuote(instrument.symbol);
    const mid = quote ? (quote.bid + quote.ask) / 2 : instrument.referencePrice;

    const agreeing = rnd() < this.config.agreementProbability;
    const baseSide: Side = rnd() < 0.5 ? 'BUY' : 'SELL';
    const timeframe = pick([5, 15, 15, 30, 60], rnd);

    const participants = agreeing
      ? generatorSources
      : generatorSources.filter(() => rnd() < 0.5);

    for (const source of participants) {
      const dissent = agreeing && rnd() < this.config.dissentProbability;
      const side: Side = agreeing ? (dissent ? (baseSide === 'BUY' ? 'SELL' : 'BUY') : baseSide) : rnd() < 0.5 ? 'BUY' : 'SELL';
      const jitterPips = (rnd() - 0.5) * 8;
      const entry = roundPrice(instrument, mid + pipsToPrice(instrument, jitterPips));
      const stopPips = 15 + Math.floor(rnd() * 20);
      const tpPips = stopPips * (1.2 + rnd());
      const stopLoss = roundPrice(
        instrument,
        side === 'BUY' ? entry - pipsToPrice(instrument, stopPips) : entry + pipsToPrice(instrument, stopPips),
      );
      const takeProfit = roundPrice(
        instrument,
        side === 'BUY' ? entry + pipsToPrice(instrument, tpPips) : entry - pipsToPrice(instrument, tpPips),
      );

      const text =
        `${side === 'BUY' ? 'COMPRA' : 'VENDA'} ${instrument.symbol} M${timeframe} ` +
        `entrada: ${entry} SL: ${stopLoss} TP: ${takeProfit}`;

      this.engine.ingestSignal({
        sourceId: source.id,
        raw: { text, externalMessageId: id('msg') },
        parsedBy: 'GENERATOR',
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
    const quote = this.engine.broker.getQuote(instrument.symbol);
    const mid = quote ? (quote.bid + quote.ask) / 2 : instrument.referencePrice;
    const entry = roundPrice(instrument, mid + pipsToPrice(instrument, params.entryOffsetPips ?? 0));
    const timeframe = params.timeframeMinutes ?? 15;
    const stopPips = 20;
    const tpPips = 30;
    const withStops = params.withStops ?? true;
    const stopLoss = withStops
      ? roundPrice(
          instrument,
          params.side === 'BUY'
            ? entry - pipsToPrice(instrument, stopPips)
            : entry + pipsToPrice(instrument, stopPips),
        )
      : null;
    const takeProfit = withStops
      ? roundPrice(
          instrument,
          params.side === 'BUY'
            ? entry + pipsToPrice(instrument, tpPips)
            : entry - pipsToPrice(instrument, tpPips),
        )
      : null;

    return this.engine.ingestSignal({
      sourceId: params.sourceId,
      raw: {
        text: `${params.side === 'BUY' ? 'COMPRA' : 'VENDA'} ${instrument.symbol} M${timeframe} entrada: ${entry}${stopLoss ? ` SL: ${stopLoss}` : ''}${takeProfit ? ` TP: ${takeProfit}` : ''}`,
        externalMessageId: params.externalMessageId ?? id('msg'),
      },
      parsedBy: 'GENERATOR',
      symbol: instrument.symbol,
      venue: instrument.venue,
      side: params.side,
      emittedAt: this.engine.clock.nowIso(),
      timeframeMinutes: timeframe,
      horizonMinutes: params.horizonMinutes ?? timeframe * 4,
      validUntil: params.validUntilMinutes
        ? new Date(Date.parse(this.engine.clock.nowIso()) + params.validUntilMinutes * 60_000).toISOString()
        : null,
      entryType: 'LIMIT',
      entryPrice: entry,
      stopLoss,
      takeProfit,
    });
  }
}
