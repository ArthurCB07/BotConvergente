import { useEffect, useRef, useState } from 'react';

export interface Snapshot {
  now: string;
  mode: 'OBSERVE' | 'SEMI_AUTO' | 'AUTO';
  automationPaused: boolean;
  account: any;
  broker: any;
  brokerCatalog: any[];
  quotes: any[];
  sources: any[];
  signals: any[];
  opportunities: any[];
  evaluations: any[];
  decisions: Record<string, any>;
  awaitingConfirmation: string[];
  orders: any[];
  positions: any[];
  openPositions: any[];
  events: any[];
  convergenceSettings: any;
  riskSettings: any;
  day: any;
  daily: any;
}

export interface Meta {
  instruments: any[];
  brokers: any[];
  descriptors: any[];
  scenarios: Array<{ key: string; name: string; description: string; expected: string }>;
  defaults: { convergence: any; risk: any };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? body.message ?? `Falha em ${path}`);
  }
  return response.json() as Promise<T>;
}

export const api = {
  state: () => request<Snapshot>('/api/state'),
  meta: () => request<Meta>('/api/meta'),
  setMode: (mode: string) => request('/api/mode', { method: 'POST', body: JSON.stringify({ mode }) }),
  pause: (paused: boolean) =>
    request('/api/automation/pause', { method: 'POST', body: JSON.stringify({ paused }) }),
  setConnected: (connected: boolean) =>
    request('/api/connection', { method: 'POST', body: JSON.stringify({ connected }) }),
  setFailure: (mode: string) =>
    request('/api/broker/failure', { method: 'POST', body: JSON.stringify({ mode }) }),
  cashflow: (amount: number) =>
    request('/api/account/cashflow', { method: 'POST', body: JSON.stringify({ amount }) }),
  saveConvergence: (patch: Record<string, unknown>) =>
    request('/api/settings/convergence', { method: 'PUT', body: JSON.stringify(patch) }),
  saveRisk: (patch: Record<string, unknown>) =>
    request('/api/settings/risk', { method: 'PUT', body: JSON.stringify(patch) }),
  resetSettings: (group?: string) =>
    request('/api/settings/reset', { method: 'POST', body: JSON.stringify({ group }) }),
  addSource: (body: Record<string, unknown>) =>
    request('/api/sources', { method: 'POST', body: JSON.stringify(body) }),
  patchSource: (id: string, patch: Record<string, unknown>) =>
    request(`/api/sources/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteSource: (id: string) => request(`/api/sources/${id}`, { method: 'DELETE' }),
  sendSignal: (body: Record<string, unknown>) =>
    request<{ ok: boolean; message: string }>('/api/signals', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  parse: (text: string) =>
    request<any>('/api/signals/parse', { method: 'POST', body: JSON.stringify({ text }) }),
  generator: () => request<{ running: boolean; config: any }>('/api/generator'),
  generatorStart: () => request('/api/generator/start', { method: 'POST' }),
  generatorStop: () => request('/api/generator/stop', { method: 'POST' }),
  generatorRound: () => request('/api/generator/round', { method: 'POST' }),
  generatorConfig: (patch: Record<string, unknown>) =>
    request('/api/generator/config', { method: 'PUT', body: JSON.stringify(patch) }),
  confirm: (id: string) =>
    request<{ ok: boolean; message: string }>(`/api/opportunities/${id}/confirm`, { method: 'POST' }),
  reject: (id: string) => request(`/api/opportunities/${id}/reject`, { method: 'POST' }),
  closePosition: (id: string) => request(`/api/positions/${id}/close`, { method: 'POST' }),
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

  return { snapshot, error, reload: () => api.state().then(setSnapshot) };
}

export function useMeta() {
  const [meta, setMeta] = useState<Meta | null>(null);
  useEffect(() => {
    void api.meta().then(setMeta).catch(() => setMeta(null));
  }, []);
  return meta;
}
