import { useEffect, useRef, useState } from 'react';

export type MarketId = 'FOREX' | 'CRYPTO';

export const MARKETS: MarketId[] = ['FOREX', 'CRYPTO'];

export const MARKET_LABEL: Record<MarketId, string> = {
  FOREX: 'Forex',
  CRYPTO: 'Cripto',
};

export const PRODUCT_LABEL: Record<string, string> = {
  FX_SPOT: 'Forex a vista',
  CRYPTO_SPOT: 'Cripto a vista',
  CRYPTO_PERP: 'Cripto perpetuo',
};

/** Recorte do estado de um mercado. */
export interface MarketSlice {
  marketId: MarketId;
  mode: 'OBSERVE' | 'SEMI_AUTO' | 'AUTO';
  automationEnabled: boolean;
  accountId: string;
  account: any;
  convergenceSettings: any;
  riskSettings: any;
  instruments: any[];
  quotes: any[];
  /** Cotacao de referencia externa. Presente so em Forex; `null` em Cripto. */
  referenceQuotes: {
    status: Record<string, any>;
    quotes: any[];
  } | null;
  /** Cotacao publica de mercado. Presente so em Cripto; `null` em Forex. */
  cryptoQuotes: {
    status: Record<string, any>;
    quotes: any[];
  } | null;
  sources: any[];
  signals: any[];
  opportunities: any[];
  evaluations: any[];
  orders: any[];
  positions: any[];
  openPositions: any[];
  events: any[];
  day: any;
  daily: any;
}

export interface Snapshot {
  now: string;
  persistence: { enabled: boolean; path: string | null };
  globalPaused: boolean;
  globalRisk: any;
  globalDay: any;
  consolidated: {
    accounts: any[];
    sharedAccount: boolean;
    equityInReference: number;
    exposureInReference: number;
    openPositions: number;
    referenceCurrency: string;
    conversionNote: string;
  };
  brokerCatalog: any[];
  availableAccounts: any[];
  sources: any[];
  unclassifiedSources: any[];
  decisions: Record<string, any>;
  awaitingConfirmation: string[];
  events: any[];
  markets: Record<MarketId, MarketSlice>;
}

export interface Meta {
  markets: Array<{ id: MarketId; label: string }>;
  instruments: any[];
  instrumentsByMarket: Record<MarketId, any[]>;
  brokers: any[];
  descriptors: any[];
  scenarios: Array<{
    key: string;
    name: string;
    marketId: MarketId | null;
    description: string;
    expected: string;
  }>;
  defaults: { convergence: Record<MarketId, any>; risk: Record<MarketId, any>; global: any };
}

const TOKEN_KEY = 'painel.token';

/**
 * Token opcional do painel. As rotas de configuracao e autenticacao do Telegram
 * passam a exigi-lo quando `DASHBOARD_TOKEN` esta definido no backend. Fica
 * apenas neste navegador e nunca e enviado para outro lugar.
 */
export function getDashboardToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setDashboardToken(value: string): void {
  try {
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Armazenamento bloqueado: o token vale so ate recarregar a pagina.
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getDashboardToken();
  const response = await fetch(path, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'x-dashboard-token': token } : {}),
    },
    ...init,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = new Error(body.error ?? body.message ?? `Falha em ${path}`);
    (error as Error & { tokenRequired?: boolean }).tokenRequired = Boolean(body.tokenRequired);
    throw error;
  }
  return response.json() as Promise<T>;
}

const put = (path: string, body: unknown) =>
  request(path, { method: 'PUT', body: JSON.stringify(body) });
const post = (path: string, body?: unknown) =>
  request(path, { method: 'POST', body: JSON.stringify(body ?? {}) });

export const api = {
  state: () => request<Snapshot>('/api/state'),
  meta: () => request<Meta>('/api/meta'),

  // Por mercado
  setMode: (marketId: MarketId, mode: string) => post(`/api/markets/${marketId}/mode`, { mode }),
  setAutomation: (marketId: MarketId, enabled: boolean) =>
    post(`/api/markets/${marketId}/automation`, { enabled }),
  setAccount: (marketId: MarketId, accountId: string) =>
    post(`/api/markets/${marketId}/account`, { accountId }),
  saveConvergence: (marketId: MarketId, patch: Record<string, unknown>) =>
    put(`/api/markets/${marketId}/settings/convergence`, patch),
  saveRisk: (marketId: MarketId, patch: Record<string, unknown>) =>
    put(`/api/markets/${marketId}/settings/risk`, patch),
  resetMarketSettings: (marketId: MarketId, group?: string) =>
    post(`/api/markets/${marketId}/settings/reset`, { group }),

  // Globais
  setGlobalPaused: (paused: boolean) => post('/api/global/pause', { paused }),
  saveGlobalRisk: (patch: Record<string, unknown>) => put('/api/global/risk', patch),
  resetGlobalRisk: () => post('/api/global/reset'),

  // Contas
  setConnected: (accountId: string, connected: boolean) =>
    post(`/api/accounts/${accountId}/connection`, { connected }),
  setFailure: (accountId: string, mode: string) => post(`/api/accounts/${accountId}/failure`, { mode }),
  cashflow: (accountId: string, amount: number) =>
    post(`/api/accounts/${accountId}/cashflow`, { amount }),

  // Fontes e sinais
  addSource: (body: Record<string, unknown>) => post('/api/sources', body),
  patchSource: (id: string, patch: Record<string, unknown>) =>
    request(`/api/sources/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteSource: (id: string) => request(`/api/sources/${id}`, { method: 'DELETE' }),
  sendSignal: (body: Record<string, unknown>) =>
    request<{ ok: boolean; message: string }>('/api/signals', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  parse: (text: string) => request<any>('/api/signals/parse', { method: 'POST', body: JSON.stringify({ text }) }),

  // Gerador
  generator: () => request<{ running: boolean; config: any }>('/api/generator'),
  generatorStart: () => post('/api/generator/start'),
  generatorStop: () => post('/api/generator/stop'),
  generatorRound: (marketId?: MarketId) => post('/api/generator/round', { marketId }),
  generatorConfig: (patch: Record<string, unknown>) => put('/api/generator/config', patch),

  // Operacoes
  confirm: (id: string) =>
    request<{ ok: boolean; message: string }>(`/api/opportunities/${id}/confirm`, { method: 'POST' }),
  reject: (id: string) => post(`/api/opportunities/${id}/reject`),
  closePosition: (id: string) => post(`/api/positions/${id}/close`),

  // Cotacao de referencia
  quotes: () => request<any>('/api/quotes/forex'),
  refreshQuotes: () => post('/api/quotes/forex/refresh'),

  // Cotacao de cripto (Binance Spot, dados publicos)
  cryptoQuotes: () => request<any>('/api/quotes/crypto'),
  refreshCryptoQuotes: () => post('/api/quotes/crypto/refresh'),
  setCryptoSymbols: (symbols: string[]) =>
    post('/api/quotes/crypto/symbols', { symbols }),

  // Telegram (MTProto, conta do usuario)
  telegram: () => request<TelegramState>('/api/telegram/state'),
  telegramLogin: (phone: string) =>
    request<TelegramActionResult>('/api/telegram/login', {
      method: 'POST',
      body: JSON.stringify({ phone }),
    }),
  /* O codigo e a senha existem apenas nesta chamada: nada e guardado no navegador. */
  telegramCode: (code: string) =>
    request<TelegramActionResult>('/api/telegram/code', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),
  telegramPassword: (password: string) =>
    request<TelegramActionResult>('/api/telegram/password', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
  telegramResend: () =>
    request<TelegramActionResult>('/api/telegram/resend', { method: 'POST', body: '{}' }),
  telegramReconnect: () =>
    request<TelegramActionResult>('/api/telegram/reconnect', { method: 'POST', body: '{}' }),
  telegramLogout: () =>
    request<TelegramActionResult>('/api/telegram/logout', { method: 'POST', body: '{}' }),
  telegramDialogs: (force = false) =>
    request<{ dialogs: TelegramDialog[]; fetchedAt: string | null }>(
      `/api/telegram/dialogs${force ? '?force=1' : ''}`,
    ),
  telegramConfigureRoom: (body: Record<string, unknown>) =>
    request<TelegramActionResult>('/api/telegram/rooms', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  telegramSetMonitoring: (peerId: string, monitoring: boolean) =>
    request<TelegramActionResult>(
      `/api/telegram/rooms/${encodeURIComponent(peerId)}/monitoring`,
      { method: 'POST', body: JSON.stringify({ monitoring }) },
    ),
  telegramRemoveRoom: (peerId: string) =>
    request<TelegramActionResult>(`/api/telegram/rooms/${encodeURIComponent(peerId)}`, {
      method: 'DELETE',
    }),
  telegramActivity: (limit = 120, peerId?: string) =>
    request<{ activity: TelegramActivity[] }>(
      `/api/telegram/activity?limit=${limit}${peerId ? `&peerId=${encodeURIComponent(peerId)}` : ''}`,
    ),

  // Banco e cenarios
  db: () => request<any>('/api/db'),
  resetDb: () => post('/api/db/reset', { confirm: 'APAGAR' }),
  runScenario: (key: string) =>
    request<{ ok: boolean; expected: string }>(`/api/scenarios/${key}`, { method: 'POST' }),
};

/** Estado do servidor com atualizacao por fluxo de eventos. */
export function useSnapshot() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    let alive = true;

    const load = async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const next = await api.state();
        if (alive) {
          setSnapshot(next);
          setError(null);
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      } finally {
        inFlight.current = false;
      }
    };

    void load();
    const source = new EventSource('/api/stream');
    let scheduled = false;
    source.onmessage = () => {
      // Agrupa rajadas de eventos em uma leitura por quadro.
      if (scheduled) return;
      scheduled = true;
      setTimeout(() => {
        scheduled = false;
        void load();
      }, 250);
    };
    source.onerror = () => setError('Fluxo de atualizacoes interrompido. Tentando reconectar.');

    return () => {
      alive = false;
      source.close();
    };
  }, []);

  return { snapshot, error };
}

export function useMeta() {
  const [meta, setMeta] = useState<Meta | null>(null);
  useEffect(() => {
    void api.meta().then(setMeta).catch(() => setMeta(null));
  }, []);
  return meta;
}

const MARKET_KEY = 'painel.mercado';

/**
 * Mercado selecionado. Fica no navegador para sobreviver a navegacao entre abas e
 * a um recarregamento; nao vai para o backend.
 */
export function useMarketSelection(): [MarketId, (marketId: MarketId) => void] {
  const [marketId, setMarketId] = useState<MarketId>(() => {
    try {
      const stored = localStorage.getItem(MARKET_KEY);
      if (stored === 'FOREX' || stored === 'CRYPTO') return stored;
    } catch {
      // Armazenamento bloqueado: cai no padrao.
    }
    return 'FOREX';
  });

  const select = (next: MarketId) => {
    setMarketId(next);
    try {
      localStorage.setItem(MARKET_KEY, next);
    } catch {
      // A escolha vale so para esta sessao.
    }
  };

  return [marketId, select];
}


// --- Telegram ---------------------------------------------------------------

export type TelegramAuthState =
  | 'SEM_CREDENCIAIS'
  | 'DESCONECTADO'
  | 'CONECTANDO'
  | 'AGUARDANDO_CODIGO'
  | 'AGUARDANDO_SENHA'
  | 'CONECTADO'
  | 'ERRO';

export type ParseProfile = 'GENERICO' | 'FOREX_CLASSICO' | 'CRIPTO_CLASSICO' | 'SOMENTE_MANUAL';

export type RoomKind = 'GRUPO' | 'CANAL' | 'PRIVADO' | 'DESCONHECIDO';

export interface TelegramDialog {
  peerId: string;
  title: string;
  username: string | null;
  kind: RoomKind;
  participants: number | null;
  configured: boolean;
  monitoring: boolean;
}

export interface TelegramRoom {
  peerId: string;
  title: string;
  displayName: string;
  username: string | null;
  kind: RoomKind;
  markets: MarketId[];
  monitoring: boolean;
  profile: ParseProfile;
  participatesInConvergence: boolean;
  independenceGroupId: string;
  topicIds: number[];
  sourceId: string | null;
  state: 'MONITORANDO' | 'PAUSADA' | 'ACESSO_PERDIDO' | 'ERRO_INTERPRETACAO' | 'NAO_SELECIONADA';
  stateDetail: string | null;
  lastMessageAt: string | null;
  lastValidSignalAt: string | null;
  lastMessageId: number | null;
  validSignals: number;
  ignoredMessages: number;
  createdAt: string;
}

export interface TelegramActivity {
  id: string;
  at: string;
  kind: string;
  severity: 'INFO' | 'WARN' | 'BLOCK' | 'SUCCESS';
  peerId: string | null;
  roomName: string | null;
  marketId: MarketId | null;
  title: string;
  detail: string;
  /** Texto recebido, preservado como veio. */
  originalText: string | null;
  messageId: number | null;
  messageVersion: number;
  publishedAt: string | null;
  receivedAt: string;
  /** Campos lidos da mensagem, para conferir lado a lado com o original. */
  parsed: Record<string, any> | null;
  signalId: string | null;
}

export interface TelegramState {
  /** As duas variaveis de ambiente existem. NAO significa conta conectada. */
  configured: boolean;
  state: TelegramAuthState;
  account: {
    userId: string;
    firstName: string | null;
    lastName: string | null;
    username: string | null;
    phoneMasked: string | null;
    connectedAt: string;
  } | null;
  pending: {
    phoneMasked: string;
    delivery: {
      method: string;
      label: string;
      length: number | null;
      timeoutSeconds: number | null;
      nextMethod: string | null;
    };
  } | null;
  error: { code: string; message: string; waitSeconds: number | null } | null;
  rooms: TelegramRoom[];
  monitoredCount: number;
  configuredCount: number;
  lastMessageAt: string | null;
  lastSignalAt: string | null;
  lastConnectionLossAt: string | null;
  dialogs: TelegramDialog[];
  dialogsFetchedAt: string | null;
  activity: TelegramActivity[];
  setupHint: string | null;
  profiles: Array<{ id: ParseProfile; label: string; description: string }>;
  tokenRequired: boolean;
}

export interface TelegramActionResult {
  ok: boolean;
  message: string;
  needsPassword?: boolean;
  delivery?: {
    method: string;
    label: string;
    length: number | null;
    timeoutSeconds: number | null;
    nextMethod: string | null;
  };
  room?: TelegramRoom;
}

export const PARSE_PROFILE_LABEL: Record<ParseProfile, string> = {
  GENERICO: 'Generico',
  FOREX_CLASSICO: 'Forex classico',
  CRIPTO_CLASSICO: 'Cripto classico',
  SOMENTE_MANUAL: 'Somente registro',
};

export const ROOM_STATE_LABEL: Record<TelegramRoom['state'], string> = {
  MONITORANDO: 'Monitorando',
  PAUSADA: 'Pausada',
  ACESSO_PERDIDO: 'Sem acesso a sala',
  ERRO_INTERPRETACAO: 'Ultima mensagem nao interpretada',
  NAO_SELECIONADA: 'Nao selecionada',
};

/**
 * Estado do Telegram. Fica fora de `/api/state` de proposito: e rota protegida,
 * com guarda propria. Recarrega sempre que o backend anuncia mudanca de estado.
 */
export function useTelegram(refreshKey: string | undefined) {
  const [telegram, setTelegram] = useState<TelegramState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsToken, setNeedsToken] = useState(false);
  const [manualReload, setManualReload] = useState(0);

  useEffect(() => {
    let alive = true;
    void api
      .telegram()
      .then((next) => {
        if (!alive) return;
        setTelegram(next);
        setError(null);
        setNeedsToken(false);
      })
      .catch((e: Error & { tokenRequired?: boolean }) => {
        if (!alive) return;
        setNeedsToken(Boolean(e.tokenRequired));
        setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [refreshKey, manualReload]);

  return { telegram, error, needsToken, reload: () => setManualReload((n) => n + 1) };
}
