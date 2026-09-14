/**
 * Cliente REST publico da Binance Spot (market data).
 *
 * Base: https://data-api.binance.vision — endpoint somente de dados de mercado.
 * NAO exige chave de API, NAO consulta saldo e NAO envia ordem. Preco publico nao
 * e autorizacao para negociar e nao garante preco de execucao.
 *
 * O REST cobre carga inicial e recuperacao; a atualizacao continua vem do stream.
 */

export const BINANCE_REST_BASE = 'https://data-api.binance.vision';

export type BinanceErrorCode =
  | 'TIMEOUT'
  | 'REDE'
  | 'LIMITE_EXCEDIDO'
  | 'SIMBOLO_INVALIDO'
  | 'INDISPONIVEL'
  | 'RESPOSTA_INVALIDA';

export interface BinanceError {
  code: BinanceErrorCode;
  message: string;
  httpStatus: number | null;
  retryAfterSeconds: number | null;
}

export type BinanceResult<T> = { ok: true; data: T } | { ok: false; error: BinanceError };

/** Regras do simbolo, lidas de exchangeInfo. Nunca presumidas. */
export interface BinanceSymbolInfo {
  symbol: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
  baseAssetPrecision: number;
  quoteAssetPrecision: number;
  isSpotTradingAllowed: boolean;
  tickSize: number | null;
  stepSize: number | null;
  minNotional: number | null;
}

export interface BinanceBookTicker {
  symbol: string;
  bidPrice: string;
  bidQty: string;
  askPrice: string;
  askQty: string;
}

export interface BinanceTicker24h {
  symbol: string;
  priceChange: string;
  priceChangePercent: string;
  lastPrice: string;
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  volume: string;
  quoteVolume: string;
  openTime: number;
  closeTime: number;
}

export interface BinanceKline {
  openTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  closeTime: number;
}

export interface BinanceClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 10_000;

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

function toNumber(value: string | undefined | null): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export class BinanceClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private requests = 0;

  constructor(options: BinanceClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? BINANCE_REST_BASE;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get requestCount(): number {
    return this.requests;
  }

  private async get<T>(path: string): Promise<BinanceResult<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    this.requests += 1;
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
      const text = await response.text();

      if (response.status === 429 || response.status === 418) {
        return {
          ok: false,
          error: {
            code: 'LIMITE_EXCEDIDO',
            message: retryAfter
              ? `Limite de requisicoes da Binance atingido. Aguardar ${retryAfter} s.`
              : 'Limite de requisicoes da Binance atingido.',
            httpStatus: response.status,
            retryAfterSeconds: retryAfter,
          },
        };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return {
          ok: false,
          error: {
            code: 'RESPOSTA_INVALIDA',
            message: `Resposta nao e JSON valido (HTTP ${response.status}).`,
            httpStatus: response.status,
            retryAfterSeconds: retryAfter,
          },
        };
      }

      // Erro declarado no corpo: { code: -1121, msg: 'Invalid symbol.' }
      const body = parsed as Record<string, unknown>;
      if (typeof body?.code === 'number' && typeof body?.msg === 'string') {
        const invalidSymbol = body.code === -1121 || body.code === -1100;
        return {
          ok: false,
          error: {
            code: invalidSymbol ? 'SIMBOLO_INVALIDO' : 'INDISPONIVEL',
            message: `Binance recusou a consulta: ${body.msg} (codigo ${body.code}).`,
            httpStatus: response.status,
            retryAfterSeconds: retryAfter,
          },
        };
      }

      if (!response.ok) {
        return {
          ok: false,
          error: {
            code: 'INDISPONIVEL',
            message: `Binance respondeu HTTP ${response.status}.`,
            httpStatus: response.status,
            retryAfterSeconds: retryAfter,
          },
        };
      }

      return { ok: true, data: parsed as T };
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      return {
        ok: false,
        error: {
          code: aborted ? 'TIMEOUT' : 'REDE',
          message: aborted
            ? `Binance nao respondeu em ${this.timeoutMs} ms.`
            : `Falha de rede ao consultar a Binance: ${(error as Error).message}`,
          httpStatus: null,
          retryAfterSeconds: null,
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private symbolsParam(symbols: string[]): string {
    return encodeURIComponent(JSON.stringify(symbols));
  }

  /**
   * Regras vigentes dos simbolos. E daqui que saem tick, passo de quantidade e
   * nocional minimo — nunca presumidos pelo codigo.
   */
  async exchangeInfo(symbols: string[]): Promise<BinanceResult<BinanceSymbolInfo[]>> {
    const result = await this.get<{ symbols: Array<Record<string, unknown>> }>(
      `/api/v3/exchangeInfo?symbols=${this.symbolsParam(symbols)}`,
    );
    if (!result.ok) return result;

    const list: BinanceSymbolInfo[] = (result.data.symbols ?? []).map((raw) => {
      const filters = (raw.filters ?? []) as Array<Record<string, string>>;
      const find = (type: string) => filters.find((f) => f.filterType === type);
      return {
        symbol: String(raw.symbol),
        status: String(raw.status),
        baseAsset: String(raw.baseAsset),
        quoteAsset: String(raw.quoteAsset),
        baseAssetPrecision: Number(raw.baseAssetPrecision ?? 8),
        quoteAssetPrecision: Number(raw.quoteAssetPrecision ?? 8),
        isSpotTradingAllowed: Boolean(raw.isSpotTradingAllowed),
        tickSize: toNumber(find('PRICE_FILTER')?.tickSize),
        stepSize: toNumber(find('LOT_SIZE')?.stepSize),
        minNotional: toNumber(find('NOTIONAL')?.minNotional ?? find('MIN_NOTIONAL')?.minNotional),
      };
    });
    return { ok: true, data: list };
  }

  /** Melhor bid e ask. O provedor NAO envia horario neste endpoint. */
  async bookTicker(symbols: string[]): Promise<BinanceResult<BinanceBookTicker[]>> {
    const result = await this.get<BinanceBookTicker | BinanceBookTicker[]>(
      `/api/v3/ticker/bookTicker?symbols=${this.symbolsParam(symbols)}`,
    );
    if (!result.ok) return result;
    return { ok: true, data: Array.isArray(result.data) ? result.data : [result.data] };
  }

  /** Estatisticas de 24 horas, com `closeTime` informado pelo provedor. */
  async ticker24h(symbols: string[]): Promise<BinanceResult<BinanceTicker24h[]>> {
    const result = await this.get<BinanceTicker24h | BinanceTicker24h[]>(
      `/api/v3/ticker/24hr?symbols=${this.symbolsParam(symbols)}`,
    );
    if (!result.ok) return result;
    return { ok: true, data: Array.isArray(result.data) ? result.data : [result.data] };
  }

  /** Ultimo preco negociado. */
  async tickerPrice(symbols: string[]): Promise<BinanceResult<Array<{ symbol: string; price: string }>>> {
    const result = await this.get<{ symbol: string; price: string } | Array<{ symbol: string; price: string }>>(
      `/api/v3/ticker/price?symbols=${this.symbolsParam(symbols)}`,
    );
    if (!result.ok) return result;
    return { ok: true, data: Array.isArray(result.data) ? result.data : [result.data] };
  }

  /** Candles. Usado apenas quando a interface pedir grafico. */
  async klines(symbol: string, interval = '1m', limit = 60): Promise<BinanceResult<BinanceKline[]>> {
    const result = await this.get<unknown[][]>(
      `/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`,
    );
    if (!result.ok) return result;
    const candles: BinanceKline[] = result.data.map((row) => ({
      openTime: Number(row[0]),
      open: String(row[1]),
      high: String(row[2]),
      low: String(row[3]),
      close: String(row[4]),
      volume: String(row[5]),
      closeTime: Number(row[6]),
    }));
    return { ok: true, data: candles };
  }
}
