import { instrumentsOfMarket } from '../core/instruments.ts';
import type { Clock } from '../core/time.ts';
import { systemClock } from '../core/time.ts';
import {
  BinanceClient,
  BINANCE_REST_BASE,
  type BinanceError,
  type BinanceSymbolInfo,
} from './binanceClient.ts';
import { BinanceStream, BINANCE_STREAM_BASE, type StreamState, type WebSocketLike } from './binanceStream.ts';

/**
 * Servico de cotacao de mercado de CRIPTO — Binance Spot, dados publicos.
 *
 * Uma instancia por processo: uma conexao de stream, um cache, todas as telas
 * lendo do mesmo lugar. REST cobre a carga inicial e a recuperacao; o stream cobre
 * a atualizacao continua.
 *
 * O que isto e: preco publico de mercado a vista da Binance, para exibicao e
 * conferencia.
 * O que isto NAO e: acesso a conta, saldo ou envio de ordem. Preco publico nao e
 * autorizacao para negociar e nao garante o preco de execucao.
 *
 * Somente SPOT. Perpetuos e futuros ficam de fora e aparecem como incompativeis
 * com esta integracao — um sinal de futuros nunca e lido como a vista.
 */

export const CRYPTO_SOURCE_LABEL = 'Binance · Spot';

/** Cotacao normalizada de um par a vista. */
export interface CryptoQuote {
  /** Simbolo interno, igual ao da Binance para os pares a vista. */
  symbol: string;
  exchange: 'Binance';
  marketType: 'Spot';
  sourceLabel: string;
  baseAsset: string;
  quoteAsset: string;
  /** Par legivel, com a moeda de cotacao explicita. USDT nunca vira USD. */
  pairLabel: string;

  /** Ultimo negocio. */
  lastPrice: number | null;
  /** Horario do negocio informado pelo provedor. `null` quando nao vem. */
  lastTradeAt: string | null;
  lastTradeReceivedAt: string | null;

  /** Melhor oferta de compra e de venda. */
  bid: number | null;
  bidQty: number | null;
  ask: number | null;
  askQty: number | null;
  /**
   * O stream e o REST de bookTicker NAO trazem horario. Guardamos apenas o momento
   * do recebimento e o identificador de atualizacao — nenhum horario e inventado.
   */
  bookEventAt: null;
  bookReceivedAt: string | null;
  bookUpdateId: number | null;

  /** Estatisticas de 24 horas, do REST. */
  priceChange: number | null;
  priceChangePercent: number | null;
  high24h: number | null;
  low24h: number | null;
  volume24h: number | null;
  quoteVolume24h: number | null;
  /** `closeTime` informado pelo provedor. */
  stats24hAt: string | null;
  stats24hReceivedAt: string | null;

  /** Regras do simbolo, lidas de exchangeInfo. */
  status: string;
  tickSize: number | null;
  stepSize: number | null;
  minNotional: number | null;

  ageSeconds: number | null;
  stale: boolean;
  staleReason: string | null;
}

export type CryptoQuotesState =
  | 'CARREGANDO'
  | 'OK'
  | 'RECONECTANDO'
  | 'DESATUALIZADA'
  | 'INDISPONIVEL';

export interface CryptoQuotesStatus {
  state: CryptoQuotesState;
  message: string;
  source: 'BINANCE_SPOT';
  sourceLabel: string;
  restBase: string;
  streamBase: string;
  streamState: StreamState;
  streamDetail: string;
  symbols: string[];
  /** Pares validados em exchangeInfo e disponiveis para selecao. */
  availableSymbols: Array<{ symbol: string; status: string; baseAsset: string; quoteAsset: string }>;
  /** Instrumentos de cripto do projeto fora do escopo desta integracao. */
  incompatibleSymbols: Array<{ symbol: string; reason: string }>;
  lastMessageAt: string | null;
  lastRestAt: string | null;
  lastOpenedAt: string | null;
  reconnects: number;
  messagesReceived: number;
  restRequests: number;
  staleAfterSeconds: number;
  error: { code: string; message: string; retryAfterSeconds: number | null } | null;
  disclaimer: string;
}

export interface CryptoQuotesSnapshot {
  status: CryptoQuotesStatus;
  quotes: CryptoQuote[];
}

export interface CryptoQuotesOptions {
  restBase?: string;
  streamBase?: string;
  /** Intervalo do refresco REST das estatisticas de 24 h. */
  statsRefreshSeconds?: number;
  /** Sem dado novo por este tempo, a cotacao e marcada como desatualizada. */
  staleAfterSeconds?: number;
  clock?: Clock;
  fetchImpl?: typeof fetch;
  socketFactory?: (url: string) => WebSocketLike;
  watchdogSeconds?: number;
  onUpdate?: () => void;
}

const DEFAULT_STATS_REFRESH_SECONDS = 60;
const DEFAULT_STALE_AFTER_SECONDS = 90;

function toNumber(value: string | number | undefined | null): number | null {
  if (value == null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoFromMillis(value: unknown): string | null {
  const millis = Number(value);
  if (!Number.isFinite(millis) || millis <= 0) return null;
  return new Date(millis).toISOString();
}

/** Estado acumulado de um par, antes de virar `CryptoQuote`. */
interface QuoteState {
  info: BinanceSymbolInfo | null;
  lastPrice: number | null;
  lastTradeAt: string | null;
  lastTradeReceivedAt: string | null;
  bid: number | null;
  bidQty: number | null;
  ask: number | null;
  askQty: number | null;
  bookReceivedAt: string | null;
  bookUpdateId: number | null;
  priceChange: number | null;
  priceChangePercent: number | null;
  high24h: number | null;
  low24h: number | null;
  volume24h: number | null;
  quoteVolume24h: number | null;
  stats24hAt: string | null;
  stats24hReceivedAt: string | null;
}

function emptyState(): QuoteState {
  return {
    info: null,
    lastPrice: null,
    lastTradeAt: null,
    lastTradeReceivedAt: null,
    bid: null,
    bidQty: null,
    ask: null,
    askQty: null,
    bookReceivedAt: null,
    bookUpdateId: null,
    priceChange: null,
    priceChangePercent: null,
    high24h: null,
    low24h: null,
    volume24h: null,
    quoteVolume24h: null,
    stats24hAt: null,
    stats24hReceivedAt: null,
  };
}

export class CryptoQuotesService {
  private readonly client: BinanceClient;
  private readonly clock: Clock;
  private readonly restBase: string;
  private readonly streamBase: string;
  private readonly statsRefreshSeconds: number;
  private readonly onUpdate?: () => void;
  readonly staleAfterSeconds: number;

  private stream: BinanceStream;
  private states = new Map<string, QuoteState>();
  private available: BinanceSymbolInfo[] = [];
  private symbols: string[] = [];
  private statsTimer: NodeJS.Timeout | null = null;
  private started = false;
  private lastRestAt: string | null = null;
  private lastError: BinanceError | null = null;
  private streamDetail = 'Stream ainda nao iniciado.';
  private statsInFlight: Promise<void> | null = null;

  constructor(options: CryptoQuotesOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.restBase = options.restBase ?? BINANCE_REST_BASE;
    this.streamBase = options.streamBase ?? BINANCE_STREAM_BASE;
    this.statsRefreshSeconds = Math.max(10, options.statsRefreshSeconds ?? DEFAULT_STATS_REFRESH_SECONDS);
    this.staleAfterSeconds = options.staleAfterSeconds ?? DEFAULT_STALE_AFTER_SECONDS;
    this.onUpdate = options.onUpdate;
    this.client = new BinanceClient({ baseUrl: this.restBase, fetchImpl: options.fetchImpl });

    // Pares padrao: os instrumentos de cripto a vista com simbolo mapeado.
    this.symbols = instrumentsOfMarket('CRYPTO')
      .filter((i) => i.exchange === 'BINANCE_SPOT' && i.externalSymbol)
      .map((i) => i.externalSymbol as string);

    this.stream = new BinanceStream({
      baseUrl: this.streamBase,
      clock: this.clock,
      watchdogSeconds: options.watchdogSeconds,
      socketFactory: options.socketFactory,
      onMessage: (message) => this.handleStreamMessage(message.stream, message.data, message.receivedAt),
      onStateChange: (state, detail) => {
        this.streamDetail = detail;
        // Perdeu o stream: o REST assume a recuperacao ate a conexao voltar.
        if (state === 'RECONECTANDO') void this.refreshFromRest();
        this.onUpdate?.();
      },
    });
  }

  get selectedSymbols(): string[] {
    return [...this.symbols];
  }

  /** Instrumentos de cripto do projeto que esta integracao nao cobre. */
  private incompatible(): Array<{ symbol: string; reason: string }> {
    return instrumentsOfMarket('CRYPTO')
      .filter((i) => i.exchange !== 'BINANCE_SPOT' || !i.externalSymbol)
      .map((i) => ({
        symbol: i.symbol,
        reason:
          i.productType === 'CRYPTO_PERP'
            ? 'Contrato perpetuo. Esta integracao cobre apenas o mercado a vista da Binance; um sinal de futuros nunca e lido como a vista.'
            : 'Sem par correspondente no mercado a vista da Binance.',
      }));
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.validateSymbols();
    await this.refreshFromRest();
    this.openStream();
    this.statsTimer = setInterval(() => void this.refreshFromRest(), this.statsRefreshSeconds * 1000);
  }

  stop(): void {
    this.started = false;
    this.stream.stop();
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
  }

  private openStream(): void {
    // bookTicker traz melhor bid/ask; trade traz o ultimo negocio com horario.
    const streams = this.symbols.flatMap((symbol) => {
      const lower = symbol.toLowerCase();
      return [`${lower}@bookTicker`, `${lower}@trade`];
    });
    this.stream.start(streams);
  }

  /** Confere os pares em exchangeInfo antes de usar. Nada e presumido. */
  private async validateSymbols(): Promise<void> {
    const result = await this.client.exchangeInfo(this.symbols);
    this.lastRestAt = this.clock.nowIso();
    if (!result.ok) {
      this.lastError = result.error;
      return;
    }
    this.available = result.data;
    const negociaveis = new Set(
      result.data.filter((s) => s.status === 'TRADING' && s.isSpotTradingAllowed).map((s) => s.symbol),
    );
    for (const info of result.data) {
      const state = this.states.get(info.symbol) ?? emptyState();
      state.info = info;
      this.states.set(info.symbol, state);
    }
    this.symbols = this.symbols.filter((s) => negociaveis.has(s));
    this.lastError = null;
  }

  /**
   * Troca os pares acompanhados. Aceita apenas o que exchangeInfo confirmar como
   * negociavel a vista.
   */
  async setSymbols(symbols: string[]): Promise<{ ok: boolean; message: string; accepted: string[] }> {
    const wanted = [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))];
    if (wanted.length === 0) return { ok: false, message: 'Informe ao menos um par.', accepted: [] };

    const result = await this.client.exchangeInfo(wanted);
    this.lastRestAt = this.clock.nowIso();
    if (!result.ok) {
      this.lastError = result.error;
      return { ok: false, message: result.error.message, accepted: [] };
    }

    const negociaveis = result.data.filter((s) => s.status === 'TRADING' && s.isSpotTradingAllowed);
    const accepted = negociaveis.map((s) => s.symbol);
    const rejected = wanted.filter((s) => !accepted.includes(s));
    if (accepted.length === 0) {
      return {
        ok: false,
        message: `Nenhum par valido para o mercado a vista: ${rejected.join(', ')}.`,
        accepted: [],
      };
    }

    this.symbols = accepted;
    this.available = result.data;
    for (const info of negociaveis) {
      const state = this.states.get(info.symbol) ?? emptyState();
      state.info = info;
      this.states.set(info.symbol, state);
    }
    for (const symbol of [...this.states.keys()]) {
      if (!accepted.includes(symbol)) this.states.delete(symbol);
    }

    await this.refreshFromRest();
    if (this.started) this.openStream();
    this.onUpdate?.();
    return {
      ok: true,
      accepted,
      message:
        rejected.length > 0
          ? `Acompanhando ${accepted.join(', ')}. Recusados pelo provedor: ${rejected.join(', ')}.`
          : `Acompanhando ${accepted.join(', ')}.`,
    };
  }

  /**
   * Carga inicial e recuperacao por REST. Chamadas concorrentes compartilham a
   * mesma requisicao, para nao multiplicar consumo do limite publico.
   */
  async refreshFromRest(): Promise<void> {
    if (!this.started || this.symbols.length === 0) return;
    if (this.statsInFlight) return this.statsInFlight;
    this.statsInFlight = this.doRefreshFromRest().finally(() => {
      this.statsInFlight = null;
    });
    return this.statsInFlight;
  }

  private async doRefreshFromRest(): Promise<void> {
    const now = this.clock.nowIso();
    const [book, stats] = await Promise.all([
      this.client.bookTicker(this.symbols),
      this.client.ticker24h(this.symbols),
    ]);
    this.lastRestAt = now;

    if (!book.ok) {
      this.lastError = book.error;
    } else {
      for (const entry of book.data) {
        const state = this.states.get(entry.symbol) ?? emptyState();
        state.bid = toNumber(entry.bidPrice);
        state.bidQty = toNumber(entry.bidQty);
        state.ask = toNumber(entry.askPrice);
        state.askQty = toNumber(entry.askQty);
        state.bookReceivedAt = now;
        this.states.set(entry.symbol, state);
      }
    }

    if (!stats.ok) {
      this.lastError = stats.error;
    } else {
      for (const entry of stats.data) {
        const state = this.states.get(entry.symbol) ?? emptyState();
        state.priceChange = toNumber(entry.priceChange);
        state.priceChangePercent = toNumber(entry.priceChangePercent);
        state.high24h = toNumber(entry.highPrice);
        state.low24h = toNumber(entry.lowPrice);
        state.volume24h = toNumber(entry.volume);
        state.quoteVolume24h = toNumber(entry.quoteVolume);
        state.stats24hAt = isoFromMillis(entry.closeTime);
        state.stats24hReceivedAt = now;
        // O ultimo preco do REST so entra quando o stream ainda nao trouxe negocio.
        if (state.lastPrice == null) state.lastPrice = toNumber(entry.lastPrice);
        this.states.set(entry.symbol, state);
      }
    }

    if (book.ok && stats.ok) this.lastError = null;
    this.onUpdate?.();
  }

  private handleStreamMessage(
    stream: string,
    data: Record<string, unknown>,
    receivedAt: string,
  ): void {
    const [rawSymbol, kind] = stream.split('@');
    if (!rawSymbol || !kind) return;
    const symbol = rawSymbol.toUpperCase();
    const state = this.states.get(symbol) ?? emptyState();

    if (kind === 'bookTicker') {
      state.bid = toNumber(data.b as string);
      state.bidQty = toNumber(data.B as string);
      state.ask = toNumber(data.a as string);
      state.askQty = toNumber(data.A as string);
      state.bookUpdateId = toNumber(data.u as number);
      // Este stream nao envia horario de evento. Guardamos so o recebimento.
      state.bookReceivedAt = receivedAt;
    } else if (kind === 'trade') {
      state.lastPrice = toNumber(data.p as string);
      // `T` e o horario do negocio; `E`, o do evento. Preferimos o do negocio.
      state.lastTradeAt = isoFromMillis(data.T ?? data.E);
      state.lastTradeReceivedAt = receivedAt;
    } else {
      return;
    }

    this.states.set(symbol, state);
    this.onUpdate?.();
  }

  /** Candles do par, direto do REST publico. Usado quando a interface pede grafico. */
  async klines(symbol: string, interval = '1m', limit = 60) {
    const key = symbol.toUpperCase();
    if (!this.symbols.includes(key)) {
      return { ok: false as const, error: { code: 'SIMBOLO_INVALIDO' as const, message: `Par ${key} nao esta entre os acompanhados.`, httpStatus: null, retryAfterSeconds: null } };
    }
    return this.client.klines(key, interval, Math.min(Math.max(limit, 1), 500));
  }

  /** Preco medio entre melhor compra e melhor venda, quando houver livro. */
  midPrice(symbol: string): number | null {
    const state = this.states.get(symbol.toUpperCase());
    if (!state) return null;
    if (state.bid != null && state.ask != null) return (state.bid + state.ask) / 2;
    return state.lastPrice;
  }

  get(symbol: string): CryptoQuote | null {
    const key = symbol.toUpperCase();
    const state = this.states.get(key);
    if (!state) return null;
    return this.toQuote(key, state, this.clock.nowIso());
  }

  private toQuote(symbol: string, state: QuoteState, nowIso: string): CryptoQuote {
    const info = state.info;
    const freshest = [state.lastTradeReceivedAt, state.bookReceivedAt]
      .filter((v): v is string => v != null)
      .sort()
      .at(-1);
    const ageSeconds = freshest
      ? Math.max(0, Math.round((Date.parse(nowIso) - Date.parse(freshest)) / 1000))
      : null;

    let stale = false;
    let staleReason: string | null = null;
    if (ageSeconds == null) {
      stale = true;
      staleReason = 'Nenhum dado recebido ainda para este par.';
    } else if (ageSeconds > this.staleAfterSeconds) {
      stale = true;
      staleReason = `Sem atualizacao ha ${ageSeconds} s, acima do limite de ${this.staleAfterSeconds} s. Cripto negocia 24 horas, entao silencio prolongado indica falha de conexao.`;
    } else if (this.stream.state === 'RECONECTANDO') {
      stale = true;
      staleReason = 'Stream reconectando. Exibindo o ultimo preco conhecido.';
    }

    return {
      symbol,
      exchange: 'Binance',
      marketType: 'Spot',
      sourceLabel: CRYPTO_SOURCE_LABEL,
      baseAsset: info?.baseAsset ?? symbol.replace(/USDT$/, ''),
      quoteAsset: info?.quoteAsset ?? 'USDT',
      pairLabel: `${info?.baseAsset ?? symbol.replace(/USDT$/, '')}/${info?.quoteAsset ?? 'USDT'}`,

      lastPrice: state.lastPrice,
      lastTradeAt: state.lastTradeAt,
      lastTradeReceivedAt: state.lastTradeReceivedAt,

      bid: state.bid,
      bidQty: state.bidQty,
      ask: state.ask,
      askQty: state.askQty,
      bookEventAt: null,
      bookReceivedAt: state.bookReceivedAt,
      bookUpdateId: state.bookUpdateId,

      priceChange: state.priceChange,
      priceChangePercent: state.priceChangePercent,
      high24h: state.high24h,
      low24h: state.low24h,
      volume24h: state.volume24h,
      quoteVolume24h: state.quoteVolume24h,
      stats24hAt: state.stats24hAt,
      stats24hReceivedAt: state.stats24hReceivedAt,

      status: info?.status ?? 'DESCONHECIDO',
      tickSize: info?.tickSize ?? null,
      stepSize: info?.stepSize ?? null,
      minNotional: info?.minNotional ?? null,

      ageSeconds,
      stale,
      staleReason,
    };
  }

  snapshot(): CryptoQuotesSnapshot {
    const now = this.clock.nowIso();
    const quotes = this.symbols
      .map((symbol) => {
        const state = this.states.get(symbol);
        return state ? this.toQuote(symbol, state, now) : null;
      })
      .filter((q): q is CryptoQuote => q != null);

    let state: CryptoQuotesState;
    let message: string;

    if (quotes.length === 0) {
      if (this.lastError) {
        state = 'INDISPONIVEL';
        message = this.lastError.message;
      } else {
        state = 'CARREGANDO';
        message = 'Carregando os primeiros precos publicos da Binance Spot.';
      }
    } else if (this.stream.state === 'RECONECTANDO' || this.stream.state === 'CONECTANDO') {
      state = 'RECONECTANDO';
      message = `Exibindo o ultimo preco conhecido. ${this.streamDetail}`;
    } else if (quotes.some((q) => q.stale)) {
      state = 'DESATUALIZADA';
      message = this.lastError
        ? `Exibindo o ultimo preco conhecido. ${this.lastError.message}`
        : 'Exibindo o ultimo preco conhecido: o stream parou de entregar dados.';
    } else {
      state = 'OK';
      message = 'Preco publico em tempo real, via stream da Binance Spot.';
    }

    return {
      status: {
        state,
        message,
        source: 'BINANCE_SPOT',
        sourceLabel: CRYPTO_SOURCE_LABEL,
        restBase: this.restBase,
        streamBase: this.streamBase,
        streamState: this.stream.state,
        streamDetail: this.streamDetail,
        symbols: [...this.symbols],
        availableSymbols: this.available.map((s) => ({
          symbol: s.symbol,
          status: s.status,
          baseAsset: s.baseAsset,
          quoteAsset: s.quoteAsset,
        })),
        incompatibleSymbols: this.incompatible(),
        lastMessageAt: this.stream.lastMessageAt,
        lastRestAt: this.lastRestAt,
        lastOpenedAt: this.stream.lastOpenedAt,
        reconnects: this.stream.reconnects,
        messagesReceived: this.stream.messagesReceived,
        restRequests: this.client.requestCount,
        staleAfterSeconds: this.staleAfterSeconds,
        error: this.lastError
          ? {
              code: this.lastError.code,
              message: this.lastError.message,
              retryAfterSeconds: this.lastError.retryAfterSeconds,
            }
          : null,
        disclaimer:
          'Preco publico do mercado a vista da Binance, para exibicao e conferencia. Nao ha acesso a conta, saldo ou envio de ordem, e preco publico nao garante o preco de execucao.',
      },
      quotes,
    };
  }
}
