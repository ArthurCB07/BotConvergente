import { instrumentsOfMarket } from '../core/instruments.ts';
import type { Clock } from '../core/time.ts';
import { systemClock } from '../core/time.ts';
import { AwesomeApiClient, type AwesomeApiError, type AwesomeApiRawQuote } from './awesomeApiClient.ts';

/**
 * Servico de cotacao de REFERENCIA para Forex.
 *
 * Uma unica instancia no processo mantem o cache, e todas as telas e abas leem
 * dele. Nenhum componente do frontend dispara consulta externa: o instantaneo ja
 * viaja pelo fluxo de eventos que a interface consome.
 *
 * O que isto e: preco de referencia de mercado, para exibicao e conferencia.
 * O que isto NAO e: preco executavel de corretora. Nao ha saldo, nao ha ordem, e
 * esta integracao sozinha nao habilita operacao real — a conexao de execucao
 * continua tendo de validar preco e condicoes por conta propria.
 */

export const QUOTE_SOURCE_LABEL = 'Cotacao de referencia · AwesomeAPI';

/** Cotacao normalizada. Numeros ja convertidos, horarios separados. */
export interface ReferenceQuote {
  /** Simbolo interno do projeto (EURUSD). */
  symbol: string;
  /** Par no formato do provedor (EUR-USD). */
  pair: string;
  name: string;
  bid: number | null;
  ask: number | null;
  high: number | null;
  low: number | null;
  /** Variacao absoluta no dia, conforme o provedor. */
  varBid: number | null;
  /** Variacao percentual no dia, conforme o provedor. */
  pctChange: number | null;
  /** Horario da NEGOCIACAO informado pelo provedor. */
  quotedAt: string;
  /** Horario local do provedor (UTC-3), como veio. */
  quotedAtProviderLocal: string;
  /** Horario em que ESTE sistema recebeu a resposta. Nunca confundir com o de cima. */
  fetchedAt: string;
  source: 'AwesomeAPI';
  sourceLabel: string;
  /** Idade da cotacao, em segundos, no momento da leitura. */
  ageSeconds: number;
  stale: boolean;
  staleReason: string | null;
}

export type QuotesState =
  | 'NAO_CONFIGURADA'
  | 'CARREGANDO'
  | 'OK'
  | 'MERCADO_FECHADO'
  | 'DESATUALIZADA'
  | 'ERRO';

export interface QuotesStatus {
  configured: boolean;
  state: QuotesState;
  /** Frase pronta para a interface. */
  message: string;
  source: 'AwesomeAPI';
  sourceLabel: string;
  refreshSeconds: number;
  staleAfterSeconds: number;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  nextAttemptAt: string | null;
  consecutiveFailures: number;
  error: { code: string; message: string; retryAfterSeconds: number | null } | null;
  /** Instrumentos do projeto que o provedor nao cobre. */
  unsupportedSymbols: string[];
  marketOpen: boolean;
  requestsThisProcess: number;
  /** Projecao de consumo mensal no intervalo atual, para caber no plano. */
  estimatedMonthlyRequests: number;
  /** Texto curto sobre o que estes precos sao e nao sao. */
  disclaimer: string;
}

export interface ReferenceQuotesSnapshot {
  status: QuotesStatus;
  quotes: ReferenceQuote[];
}

export interface ReferenceQuotesOptions {
  apiKey: string | undefined;
  refreshSeconds?: number;
  /** Apos quanto tempo sem preco novo a cotacao e marcada como desatualizada. */
  staleAfterSeconds?: number;
  timeoutMs?: number;
  clock?: Clock;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Chamado quando chega um conjunto novo de cotacoes. */
  onUpdate?: (snapshot: ReferenceQuotesSnapshot) => void;
}

const DEFAULT_REFRESH_SECONDS = 60;
const MAX_BACKOFF_SECONDS = 15 * 60;

/**
 * Carencia apos a abertura semanal. Medido contra o provedor real: na retomada de
 * domingo os pares voltam em cadencia propria e alguns seguem no fechamento de
 * sexta por dezenas de minutos. Sem esta carencia, a abertura marcaria preco
 * correto como desatualizado.
 */
const MARKET_OPEN_GRACE_MINUTES = 60;

function toNumber(value: string | undefined): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Forex a vista nao negocia no fim de semana. Aproximacao deliberada: aberto de
 * domingo 21:00 UTC a sexta 21:00 UTC, ignorando horario de verao. Serve para nao
 * chamar de "desatualizada" a cotacao de fechamento de sexta durante o fim de
 * semana — que e o preco correto naquele momento.
 */
export function isForexMarketOpen(nowIso: string): boolean {
  const now = new Date(nowIso);
  const weekday = now.getUTCDay(); // 0 = domingo
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const CLOSE = 21 * 60;
  if (weekday === 6) return false;
  if (weekday === 0) return minutes >= CLOSE;
  if (weekday === 5) return minutes < CLOSE;
  return true;
}

/**
 * Minutos desde a abertura de domingo, ou `null` quando a semana ja esta em curso
 * ou o mercado esta fechado.
 */
export function minutesSinceWeeklyOpen(nowIso: string): number | null {
  const now = new Date(nowIso);
  if (now.getUTCDay() !== 0) return null;
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const OPEN = 21 * 60;
  return minutes >= OPEN ? minutes - OPEN : null;
}

export class ReferenceQuotesService {
  private readonly client: AwesomeApiClient;
  private readonly clock: Clock;
  private readonly onUpdate?: (snapshot: ReferenceQuotesSnapshot) => void;

  readonly refreshSeconds: number;
  readonly staleAfterSeconds: number;

  /** Cache compartilhado por todas as telas e sessoes deste processo. */
  private cache = new Map<string, ReferenceQuote>();
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;

  private lastAttemptAt: string | null = null;
  private lastSuccessAt: string | null = null;
  private nextAttemptAt: string | null = null;
  private consecutiveFailures = 0;
  private lastError: AwesomeApiError | null = null;
  private unsupported = new Set<string>();

  constructor(options: ReferenceQuotesOptions) {
    this.clock = options.clock ?? systemClock;
    this.refreshSeconds = Math.max(15, options.refreshSeconds ?? DEFAULT_REFRESH_SECONDS);
    /*
     * Limiar generoso de proposito. Cada par tem cadencia propria no provedor: um
     * major pode passar varios minutos sem negocio novo sem que haja falha alguma.
     * O limiar existe para detectar provedor parado, nao par quieto.
     */
    this.staleAfterSeconds =
      options.staleAfterSeconds ?? Math.max(15 * 60, this.refreshSeconds * 10);
    this.onUpdate = options.onUpdate;
    this.client = new AwesomeApiClient({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
    });

    // Instrumentos do projeto que nao tem par correspondente no provedor.
    for (const instrument of instrumentsOfMarket('FOREX')) {
      if (!instrument.externalPair) this.unsupported.add(instrument.symbol);
    }
  }

  get configured(): boolean {
    return this.client.configured;
  }

  /** Pares a consultar: instrumentos de Forex com par mapeado e ainda aceitos. */
  private pairsToRequest(): Array<{ symbol: string; pair: string }> {
    return instrumentsOfMarket('FOREX')
      .filter((i) => i.externalPair != null && !this.unsupported.has(i.symbol))
      .map((i) => ({ symbol: i.symbol, pair: i.externalPair as string }));
  }

  start(): void {
    if (this.timer) return;
    if (!this.configured) return;
    void this.refresh();
    this.timer = setInterval(() => {
      const now = Date.parse(this.clock.nowIso());
      // Respeita a espera pedida pelo provedor e o recuo apos falhas.
      if (this.nextAttemptAt && Date.parse(this.nextAttemptAt) > now) return;
      void this.refresh();
    }, 1000);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Consulta o provedor. Chamadas concorrentes compartilham a mesma promessa: duas
   * telas abertas nunca viram duas requisicoes externas.
   */
  async refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.doRefresh().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private scheduleNext(seconds: number): void {
    this.nextAttemptAt = new Date(Date.parse(this.clock.nowIso()) + seconds * 1000).toISOString();
  }

  private async doRefresh(): Promise<void> {
    const pairs = this.pairsToRequest();
    this.lastAttemptAt = this.clock.nowIso();

    const result = await this.client.fetchLast(pairs.map((p) => p.pair));

    if (!result.ok) {
      this.consecutiveFailures += 1;
      this.lastError = result.error;
      for (const pair of result.error.unsupportedPairs) {
        const match = pairs.find((p) => p.pair === pair);
        if (match) this.unsupported.add(match.symbol);
      }
      // Recuo exponencial, respeitando o tempo pedido pelo provedor quando houver.
      const backoff = Math.min(
        MAX_BACKOFF_SECONDS,
        this.refreshSeconds * 2 ** Math.min(this.consecutiveFailures, 5),
      );
      this.scheduleNext(Math.max(backoff, result.error.retryAfterSeconds ?? 0));
      this.onUpdate?.(this.snapshot());
      return;
    }

    const fetchedAt = this.clock.nowIso();
    for (const { symbol, pair } of pairs) {
      const key = pair.replace('-', '');
      const raw = result.quotes[key];
      if (!raw) continue;
      this.cache.set(symbol, this.normalize(symbol, pair, raw, fetchedAt));
    }
    for (const pair of result.droppedPairs) {
      const match = pairs.find((p) => p.pair === pair);
      if (match) this.unsupported.add(match.symbol);
    }

    this.consecutiveFailures = 0;
    this.lastError = null;
    this.lastSuccessAt = fetchedAt;
    this.scheduleNext(this.refreshSeconds);
    this.onUpdate?.(this.snapshot());
  }

  private normalize(
    symbol: string,
    pair: string,
    raw: AwesomeApiRawQuote,
    fetchedAt: string,
  ): ReferenceQuote {
    const seconds = Number(raw.timestamp);
    const quotedAt = Number.isFinite(seconds)
      ? new Date(seconds * 1000).toISOString()
      : fetchedAt;
    return {
      symbol,
      pair,
      name: raw.name,
      bid: toNumber(raw.bid),
      ask: toNumber(raw.ask),
      high: toNumber(raw.high),
      low: toNumber(raw.low),
      varBid: toNumber(raw.varBid),
      pctChange: toNumber(raw.pctChange),
      quotedAt,
      quotedAtProviderLocal: raw.create_date,
      fetchedAt,
      source: 'AwesomeAPI',
      sourceLabel: QUOTE_SOURCE_LABEL,
      ageSeconds: 0,
      stale: false,
      staleReason: null,
    };
  }

  /** Cotacao de um instrumento, ja com idade e estado recalculados. */
  get(symbol: string): ReferenceQuote | null {
    const cached = this.cache.get(symbol);
    if (!cached) return null;
    return this.withFreshness(cached, this.clock.nowIso());
  }

  private withFreshness(quote: ReferenceQuote, nowIso: string): ReferenceQuote {
    const ageSeconds = Math.max(0, (Date.parse(nowIso) - Date.parse(quote.quotedAt)) / 1000);
    const open = isForexMarketOpen(nowIso);
    const sinceOpen = minutesSinceWeeklyOpen(nowIso);
    const inOpeningGrace = sinceOpen != null && sinceOpen < MARKET_OPEN_GRACE_MINUTES;
    let stale = false;
    let staleReason: string | null = null;

    if (!open) {
      staleReason =
        'Mercado de forex fechado. Este e o ultimo preco negociado antes do fechamento, nao um preco desatualizado por falha.';
    } else if (inOpeningGrace && ageSeconds > this.staleAfterSeconds) {
      staleReason = `Mercado reaberto ha ${sinceOpen} min. Os pares voltam em cadencia propria; ate la vale o ultimo preco negociado.`;
    } else if (ageSeconds > this.staleAfterSeconds) {
      stale = true;
      staleReason = `Sem preco novo ha ${Math.round(ageSeconds / 60)} min, acima do limite de ${Math.round(
        this.staleAfterSeconds / 60,
      )} min com o mercado aberto.`;
    } else if (this.lastError) {
      stale = true;
      staleReason = `Ultima consulta falhou (${this.lastError.code}). Exibindo a ultima cotacao conhecida.`;
    }

    return { ...quote, ageSeconds: Math.round(ageSeconds), stale, staleReason };
  }

  snapshot(): ReferenceQuotesSnapshot {
    const now = this.clock.nowIso();
    const quotes = [...this.cache.values()]
      .map((q) => this.withFreshness(q, now))
      .sort((a, b) => a.symbol.localeCompare(b.symbol));

    const marketOpen = isForexMarketOpen(now);
    let state: QuotesState;
    let message: string;

    if (!this.configured) {
      state = 'NAO_CONFIGURADA';
      message =
        'Integracao nao configurada. Defina AWESOMEAPI_KEY no ambiente do backend (arquivo .env na raiz do projeto ou variavel de ambiente) e reinicie o servidor.';
    } else if (quotes.length === 0 && this.lastError) {
      state = 'ERRO';
      message = this.lastError.message;
    } else if (quotes.length === 0) {
      state = 'CARREGANDO';
      message = 'Buscando a primeira cotacao no provedor.';
    } else if (quotes.some((q) => q.stale)) {
      state = 'DESATUALIZADA';
      message = this.lastError
        ? `Exibindo a ultima cotacao conhecida. ${this.lastError.message}`
        : 'Exibindo a ultima cotacao conhecida: o provedor nao entregou preco novo dentro do limite.';
    } else if (!marketOpen) {
      state = 'MERCADO_FECHADO';
      message =
        'Mercado de forex fechado. Precos exibidos sao os do ultimo fechamento, conforme o provedor.';
    } else {
      state = 'OK';
      message = 'Cotacao de referencia atualizada.';
    }

    const estimatedMonthlyRequests = Math.round((30 * 24 * 3600) / this.refreshSeconds);

    return {
      status: {
        configured: this.configured,
        state,
        message,
        source: 'AwesomeAPI',
        sourceLabel: QUOTE_SOURCE_LABEL,
        refreshSeconds: this.refreshSeconds,
        staleAfterSeconds: this.staleAfterSeconds,
        lastAttemptAt: this.lastAttemptAt,
        lastSuccessAt: this.lastSuccessAt,
        nextAttemptAt: this.nextAttemptAt,
        consecutiveFailures: this.consecutiveFailures,
        error: this.lastError
          ? {
              code: this.lastError.code,
              message: this.lastError.message,
              retryAfterSeconds: this.lastError.retryAfterSeconds,
            }
          : null,
        unsupportedSymbols: [...this.unsupported].sort(),
        marketOpen,
        requestsThisProcess: this.client.requestCount,
        estimatedMonthlyRequests,
        disclaimer:
          'Preco de referencia de mercado, para exibicao e conferencia. Nao e preco executavel de corretora: nao ha saldo nem envio de ordem por esta integracao, e ela sozinha nao habilita operacao real.',
      },
      quotes,
    };
  }
}
