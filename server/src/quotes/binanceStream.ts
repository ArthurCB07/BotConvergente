import type { Clock } from '../core/time.ts';
import { systemClock } from '../core/time.ts';

/**
 * Conexao unica com os streams publicos da Binance Spot.
 *
 * Base: wss://data-stream.binance.vision:443 — somente dados de mercado, sem chave.
 *
 * UMA conexao por processo, com todos os simbolos em um stream combinado. As telas
 * recebem as atualizacoes pelo fluxo de eventos do proprio backend: nenhum
 * componente da interface abre conexao externa.
 *
 * Sobre o keepalive: o protocolo WebSocket responde ping com pong automaticamente
 * na implementacao nativa do Node, entao nao ha pong manual a enviar. O que este
 * gerenciador acrescenta e um CAO DE GUARDA por ausencia de dados — se nenhuma
 * mensagem chega dentro da janela, a conexao e considerada morta e refeita. Isso
 * cobre tambem o caso de conexao aberta porem silenciosa, que um ping sozinho nao
 * detecta. Alem disso a conexao e renovada de tempos em tempos, bem antes do
 * limite de vida documentado pelo provedor.
 */

export const BINANCE_STREAM_BASE = 'wss://data-stream.binance.vision:443';

export type StreamState = 'PARADO' | 'CONECTANDO' | 'ABERTO' | 'RECONECTANDO';

export interface BinanceStreamMessage {
  stream: string;
  data: Record<string, unknown>;
  receivedAt: string;
}

export interface BinanceStreamOptions {
  baseUrl?: string;
  clock?: Clock;
  /** Sem mensagem por este tempo, a conexao e refeita. */
  watchdogSeconds?: number;
  /** Renovacao preventiva, bem antes do limite de vida do provedor. */
  renewAfterMinutes?: number;
  maxBackoffSeconds?: number;
  onMessage: (message: BinanceStreamMessage) => void;
  onStateChange?: (state: StreamState, detail: string) => void;
  /** Injetavel para teste. */
  socketFactory?: (url: string) => WebSocketLike;
}

/** Superficie minima usada, para permitir um duble em teste. */
export interface WebSocketLike {
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

const DEFAULT_WATCHDOG_SECONDS = 30;
const DEFAULT_RENEW_MINUTES = 12 * 60;
const DEFAULT_MAX_BACKOFF_SECONDS = 60;

export class BinanceStream {
  private readonly baseUrl: string;
  private readonly clock: Clock;
  private readonly watchdogSeconds: number;
  private readonly renewAfterMinutes: number;
  private readonly maxBackoffSeconds: number;
  private readonly onMessage: (message: BinanceStreamMessage) => void;
  private readonly onStateChange?: (state: StreamState, detail: string) => void;
  private readonly socketFactory: (url: string) => WebSocketLike;

  private socket: WebSocketLike | null = null;
  private streams: string[] = [];
  private started = false;
  private attempt = 0;

  private reconnectTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private renewTimer: NodeJS.Timeout | null = null;

  state: StreamState = 'PARADO';
  lastMessageAt: string | null = null;
  lastOpenedAt: string | null = null;
  lastCloseReason: string | null = null;
  reconnects = 0;
  messagesReceived = 0;

  constructor(options: BinanceStreamOptions) {
    this.baseUrl = options.baseUrl ?? BINANCE_STREAM_BASE;
    this.clock = options.clock ?? systemClock;
    this.watchdogSeconds = options.watchdogSeconds ?? DEFAULT_WATCHDOG_SECONDS;
    this.renewAfterMinutes = options.renewAfterMinutes ?? DEFAULT_RENEW_MINUTES;
    this.maxBackoffSeconds = options.maxBackoffSeconds ?? DEFAULT_MAX_BACKOFF_SECONDS;
    this.onMessage = options.onMessage;
    this.onStateChange = options.onStateChange;
    this.socketFactory =
      options.socketFactory ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
  }

  private setState(state: StreamState, detail: string): void {
    if (this.state === state) return;
    this.state = state;
    this.onStateChange?.(state, detail);
  }

  /** Liga (ou religa) a conexao com a lista de streams informada. */
  start(streams: string[]): void {
    this.streams = [...streams];
    this.started = true;
    this.attempt = 0;
    this.open();
  }

  stop(): void {
    this.started = false;
    this.clearTimers();
    this.closeSocket('parada solicitada');
    this.setState('PARADO', 'Stream parado.');
  }

  private clearTimers(): void {
    for (const timer of [this.reconnectTimer, this.watchdogTimer, this.renewTimer]) {
      if (timer) clearTimeout(timer);
    }
    this.reconnectTimer = null;
    this.watchdogTimer = null;
    this.renewTimer = null;
  }

  private closeSocket(reason: string): void {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      socket.close(1000, reason.slice(0, 120));
    } catch {
      // Fechar uma conexao ja morta nao e erro que importe aqui.
    }
  }

  private url(): string {
    return `${this.baseUrl}/stream?streams=${this.streams.join('/')}`;
  }

  private open(): void {
    if (!this.started || this.streams.length === 0) return;
    this.clearTimers();
    this.closeSocket('reabrindo');
    this.setState(this.attempt === 0 ? 'CONECTANDO' : 'RECONECTANDO', `Abrindo ${this.streams.length} stream(s).`);

    let socket: WebSocketLike;
    try {
      socket = this.socketFactory(this.url());
    } catch (error) {
      this.scheduleReconnect(`Falha ao abrir a conexao: ${(error as Error).message}`);
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
      this.lastOpenedAt = this.clock.nowIso();
      this.setState('ABERTO', `Conectado a ${this.streams.length} stream(s) publicos.`);
      this.armWatchdog();
      this.armRenewal();
    };

    socket.onmessage = (event) => {
      this.messagesReceived += 1;
      this.lastMessageAt = this.clock.nowIso();
      this.armWatchdog();
      try {
        const payload = JSON.parse(String(event.data)) as {
          stream?: string;
          data?: Record<string, unknown>;
        };
        if (payload.stream && payload.data) {
          this.onMessage({
            stream: payload.stream,
            data: payload.data,
            receivedAt: this.lastMessageAt,
          });
        }
      } catch {
        // Mensagem ilegivel nao derruba a conexao; o cao de guarda cuida do resto.
      }
    };

    socket.onerror = () => {
      // O fechamento vem logo em seguida; a reconexao e tratada la.
      this.lastCloseReason = 'Erro na conexao com o stream.';
    };

    socket.onclose = (event) => {
      this.lastCloseReason = `Conexao encerrada (codigo ${event?.code ?? 'desconhecido'}).`;
      if (!this.started) return;
      this.scheduleReconnect(this.lastCloseReason);
    };
  }

  /** Sem dado dentro da janela, a conexao e considerada morta. */
  private armWatchdog(): void {
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    this.watchdogTimer = setTimeout(() => {
      if (!this.started) return;
      this.reconnects += 1;
      this.scheduleReconnect(
        `Sem mensagem por ${this.watchdogSeconds} s. Conexao aberta porem silenciosa: refazendo.`,
        true,
      );
    }, this.watchdogSeconds * 1000);
  }

  /** Renovacao preventiva, para nao ser cortado no meio do fluxo. */
  private armRenewal(): void {
    if (this.renewTimer) clearTimeout(this.renewTimer);
    this.renewTimer = setTimeout(
      () => {
        if (!this.started) return;
        this.reconnects += 1;
        this.setState('RECONECTANDO', 'Renovacao preventiva da conexao.');
        this.attempt = 0;
        this.open();
      },
      this.renewAfterMinutes * 60 * 1000,
    );
  }

  private scheduleReconnect(detail: string, immediate = false): void {
    this.clearTimers();
    this.closeSocket('reconectando');
    if (!this.started) return;
    if (!immediate) this.reconnects += 1;

    this.attempt += 1;
    // Recuo exponencial com ruido, para nao sincronizar tentativas.
    const base = Math.min(this.maxBackoffSeconds, 2 ** Math.min(this.attempt, 6));
    const waitSeconds = immediate ? 0 : base * (0.7 + Math.random() * 0.6);
    this.setState('RECONECTANDO', `${detail} Nova tentativa em ${waitSeconds.toFixed(1)} s.`);
    this.reconnectTimer = setTimeout(() => this.open(), Math.round(waitSeconds * 1000));
  }
}
