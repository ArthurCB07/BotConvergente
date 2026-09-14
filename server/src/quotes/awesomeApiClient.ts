/**
 * Cliente da AwesomeAPI (economia.awesomeapi.com.br).
 *
 * Endpoint: GET /json/last/{pares}, pares separados por virgula no formato
 * CODE-CODEIN (ex.: EUR-USD,USD-JPY). A resposta vem como objeto cujas chaves sao
 * o par SEM hifen (EURUSD, USDJPY) e cujos valores tem TODOS os campos em texto.
 *
 * Autenticacao: cabecalho `x-api-key`. A chave e lida de AWESOMEAPI_KEY, fica
 * apenas no backend e nunca aparece em log, em resposta de rota nem no frontend.
 *
 * Observacao importante do provedor: um unico par invalido faz a requisicao
 * INTEIRA falhar com 404 `CoinNotExists`. Por isso o cliente isola o par problema
 * e repete a consulta sem ele, em vez de perder o lote.
 */

/** Campos crus, exatamente como o provedor entrega: tudo string. */
export interface AwesomeApiRawQuote {
  code: string;
  codein: string;
  name: string;
  high: string;
  low: string;
  varBid: string;
  pctChange: string;
  bid: string;
  ask: string;
  timestamp: string;
  create_date: string;
}

export type AwesomeApiErrorCode =
  | 'SEM_CHAVE'
  | 'TIMEOUT'
  | 'AUTENTICACAO'
  | 'LIMITE_EXCEDIDO'
  | 'PAR_INEXISTENTE'
  | 'PROVEDOR_INDISPONIVEL'
  | 'RESPOSTA_INVALIDA'
  | 'REDE';

export interface AwesomeApiError {
  code: AwesomeApiErrorCode;
  message: string;
  httpStatus: number | null;
  /** Espera pedida pelo provedor, quando informada no cabecalho Retry-After. */
  retryAfterSeconds: number | null;
  /** Pares que o provedor recusou, quando identificaveis. */
  unsupportedPairs: string[];
}

export type AwesomeApiResult =
  | {
      ok: true;
      quotes: Record<string, AwesomeApiRawQuote>;
      /** Pares descartados durante a tentativa por serem recusados pelo provedor. */
      droppedPairs: string[];
      httpStatus: number;
      requestCount: number;
    }
  | { ok: false; error: AwesomeApiError; requestCount: number };

export interface AwesomeApiClientOptions {
  apiKey: string | undefined;
  baseUrl?: string;
  timeoutMs?: number;
  /** Injetavel para teste. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = 'https://economia.awesomeapi.com.br';
const DEFAULT_TIMEOUT_MS = 10_000;

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  // Retry-After tambem pode vir como data HTTP.
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.max(0, Math.round((date - Date.now()) / 1000));
}

/** Extrai o par citado em `moeda nao encontrada XXX-YYY`. */
function extractUnsupportedPair(message: string): string | null {
  const match = message.match(/([A-Z0-9]{2,10}-[A-Z0-9]{2,10})/);
  return match?.[1] ?? null;
}

function isRawQuote(value: unknown): value is AwesomeApiRawQuote {
  if (typeof value !== 'object' || value === null) return false;
  const q = value as Record<string, unknown>;
  return typeof q.bid === 'string' && typeof q.ask === 'string' && typeof q.code === 'string';
}

export class AwesomeApiClient {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  /** Total de chamadas externas feitas por este processo. */
  private requests = 0;

  constructor(options: AwesomeApiClientOptions) {
    this.apiKey = options.apiKey?.trim() || undefined;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get configured(): boolean {
    return this.apiKey != null;
  }

  get requestCount(): number {
    return this.requests;
  }

  /**
   * Consulta os pares em UMA chamada. Se o provedor recusar um par especifico,
   * remove esse par e tenta de novo — no maximo uma repeticao, para nao virar
   * laco de tentativas.
   */
  async fetchLast(pairs: string[]): Promise<AwesomeApiResult> {
    if (!this.configured) {
      return {
        ok: false,
        requestCount: this.requests,
        error: {
          code: 'SEM_CHAVE',
          message:
            'AWESOMEAPI_KEY nao configurada. Defina a variavel de ambiente no backend para habilitar a cotacao de referencia.',
          httpStatus: null,
          retryAfterSeconds: null,
          unsupportedPairs: [],
        },
      };
    }
    if (pairs.length === 0) {
      return { ok: true, quotes: {}, droppedPairs: [], httpStatus: 200, requestCount: this.requests };
    }

    const dropped: string[] = [];
    let attemptPairs = [...pairs];

    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await this.request(attemptPairs);

      if (result.ok) {
        return { ...result, droppedPairs: dropped };
      }

      const bad = result.error.unsupportedPairs[0];
      const canRetryWithout = bad != null && attemptPairs.length > 1 && attempt === 0;
      if (!canRetryWithout) {
        return { ok: false, error: { ...result.error, unsupportedPairs: [...dropped, ...result.error.unsupportedPairs] }, requestCount: this.requests };
      }
      dropped.push(bad);
      attemptPairs = attemptPairs.filter((p) => p !== bad);
    }

    return {
      ok: false,
      requestCount: this.requests,
      error: {
        code: 'PAR_INEXISTENTE',
        message: `Pares recusados pelo provedor: ${dropped.join(', ')}.`,
        httpStatus: 404,
        retryAfterSeconds: null,
        unsupportedPairs: dropped,
      },
    };
  }

  private async request(
    pairs: string[],
  ): Promise<
    | { ok: true; quotes: Record<string, AwesomeApiRawQuote>; httpStatus: number; requestCount: number }
    | { ok: false; error: AwesomeApiError }
  > {
    const url = `${this.baseUrl}/json/last/${pairs.join(',')}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    this.requests += 1;

    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        // A chave vai apenas neste cabecalho. Nunca na URL, nunca em log.
        headers: { 'x-api-key': this.apiKey as string, accept: 'application/json' },
        signal: controller.signal,
      });

      const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
      const text = await response.text();

      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          error: {
            code: 'AUTENTICACAO',
            message:
              'Provedor recusou a credencial (HTTP ' +
              response.status +
              '). Confira o valor de AWESOMEAPI_KEY no ambiente do backend.',
            httpStatus: response.status,
            retryAfterSeconds: retryAfter,
            unsupportedPairs: [],
          },
        };
      }

      if (response.status === 429) {
        return {
          ok: false,
          error: {
            code: 'LIMITE_EXCEDIDO',
            message: retryAfter
              ? `Limite de requisicoes atingido. O provedor pediu para aguardar ${retryAfter} s.`
              : 'Limite de requisicoes atingido no provedor.',
            httpStatus: 429,
            retryAfterSeconds: retryAfter,
            unsupportedPairs: [],
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
            message: `Resposta do provedor nao e JSON valido (HTTP ${response.status}).`,
            httpStatus: response.status,
            retryAfterSeconds: retryAfter,
            unsupportedPairs: [],
          },
        };
      }

      // Erro declarado no corpo: { status, code: 'CoinNotExists', message }
      const body = parsed as Record<string, unknown>;
      if (typeof body?.code === 'string' && typeof body?.message === 'string' && body.status != null) {
        const pair = extractUnsupportedPair(body.message);
        const notFound = body.code === 'CoinNotExists' || response.status === 404;
        return {
          ok: false,
          error: {
            code: notFound ? 'PAR_INEXISTENTE' : 'PROVEDOR_INDISPONIVEL',
            message: body.message,
            httpStatus: response.status,
            retryAfterSeconds: retryAfter,
            unsupportedPairs: pair ? [pair] : [],
          },
        };
      }

      if (!response.ok) {
        return {
          ok: false,
          error: {
            code: 'PROVEDOR_INDISPONIVEL',
            message: `Provedor respondeu HTTP ${response.status}.`,
            httpStatus: response.status,
            retryAfterSeconds: retryAfter,
            unsupportedPairs: [],
          },
        };
      }

      const quotes: Record<string, AwesomeApiRawQuote> = {};
      for (const [key, value] of Object.entries(body)) {
        if (isRawQuote(value)) quotes[key] = value;
      }
      if (Object.keys(quotes).length === 0) {
        return {
          ok: false,
          error: {
            code: 'RESPOSTA_INVALIDA',
            message: 'Provedor respondeu sem nenhuma cotacao reconhecivel.',
            httpStatus: response.status,
            retryAfterSeconds: retryAfter,
            unsupportedPairs: [],
          },
        };
      }

      return { ok: true, quotes, httpStatus: response.status, requestCount: this.requests };
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      return {
        ok: false,
        error: {
          code: aborted ? 'TIMEOUT' : 'REDE',
          message: aborted
            ? `Provedor nao respondeu em ${this.timeoutMs} ms.`
            : `Falha de rede ao consultar o provedor: ${(error as Error).message}`,
          httpStatus: null,
          retryAfterSeconds: null,
          unsupportedPairs: [],
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
