import { useState } from 'react';
import { api, useMeta, useSnapshot } from './api.ts';
import { Badge, MODE_LABEL, clock, relative, signed } from './components/ui.tsx';
import { Home } from './pages/Home.tsx';
import { Fontes } from './pages/Fontes.tsx';
import { Convergencias } from './pages/Convergencias.tsx';
import { Operacoes } from './pages/Operacoes.tsx';
import { Corretoras } from './pages/Corretoras.tsx';
import { Configuracoes } from './pages/Configuracoes.tsx';

type Route = 'home' | 'fontes' | 'convergencias' | 'operacoes' | 'corretoras' | 'configuracoes';

export default function App() {
  const { snapshot, error } = useSnapshot();
  const meta = useMeta();
  const [route, setRoute] = useState<Route>('home');

  if (!snapshot) {
    return (
      <div className="page">
        <h1>Convergencia de Sinais</h1>
        <p className="muted">
          {error ?? 'Carregando o estado do backend...'}
        </p>
        {error && (
          <p className="small dim">
            Verifique se o backend esta no ar em <span className="num">http://localhost:8787</span>.
          </p>
        )}
      </div>
    );
  }

  const live = snapshot.opportunities.filter(
    (o: any) => o.status === 'PUBLISHED' || o.status === 'UPDATED',
  );
  const quoteAgeSeconds =
    (Date.parse(snapshot.now) - Date.parse(snapshot.account.lastUpdateAt)) / 1000;
  const stale = quoteAgeSeconds > snapshot.riskSettings.maxQuoteAgeSeconds;
  const daily = snapshot.daily;

  const nav: Array<{ key: Route; label: string; count?: number }> = [
    { key: 'home', label: 'Home' },
    { key: 'fontes', label: 'Fontes', count: snapshot.sources.length },
    { key: 'convergencias', label: 'Convergencias', count: live.length },
    { key: 'operacoes', label: 'Operacoes', count: snapshot.openPositions.length },
    { key: 'corretoras', label: 'Corretoras' },
    { key: 'configuracoes', label: 'Configuracoes' },
  ];

  return (
    <div className="app">
      <aside className="rail">
        <div className="brand">
          <div className="eyebrow">Mesa de apuracao</div>
          <div className="brand-name">Convergencia de Sinais</div>
        </div>

        <nav className="nav">
          {nav.map((item) => (
            <button
              key={item.key}
              className="nav-item"
              aria-current={route === item.key}
              onClick={() => setRoute(item.key)}
            >
              <span>{item.label}</span>
              {item.count != null && <span className="nav-count">{item.count}</span>}
            </button>
          ))}
        </nav>

        <div className="stack-sm" style={{ marginTop: 'auto' }}>
          <div className="eyebrow">Modo operacional</div>
          <div className="seg" role="group" aria-label="Modo operacional">
            {(['OBSERVE', 'SEMI_AUTO', 'AUTO'] as const).map((m) => (
              <button
                key={m}
                aria-pressed={snapshot.mode === m}
                onClick={() => void api.setMode(m)}
                style={{ flex: 1, fontSize: 11, padding: '5px 4px' }}
              >
                {m === 'OBSERVE' ? 'Observ.' : m === 'SEMI_AUTO' ? 'Semi' : 'Auto'}
              </button>
            ))}
          </div>
          <button
            className={snapshot.automationPaused ? 'btn btn-primary' : 'btn btn-danger'}
            onClick={() => void api.pause(!snapshot.automationPaused)}
          >
            {snapshot.automationPaused ? 'Retomar automacao' : 'Pausar automacao'}
          </button>
          <p className="tiny dim">
            Pausar interrompe novos envios. Posicoes abertas seguem com stop e alvo.
          </p>
        </div>
      </aside>

      <main className="main">
        <div className="sim-banner">
          <span>CONTA SIMULADA — dados sinteticos, nenhuma corretora real conectada</span>
          <span>Resultados nao tem valor preditivo</span>
        </div>

        <div className="strip">
          <div className="strip-cell">
            <span className="eyebrow">Patrimonio</span>
            <span className="figure-sm">{signed(snapshot.account.equity).replace('+', '')}</span>
          </div>
          <div className="strip-cell">
            <span className="eyebrow">Saldo</span>
            <span className="figure-sm">{signed(snapshot.account.balance).replace('+', '')}</span>
          </div>
          <div className="strip-cell">
            <span className="eyebrow">Margem livre</span>
            <span className="figure-sm">{signed(snapshot.account.freeMargin).replace('+', '')}</span>
          </div>
          <div className="strip-cell">
            <span className="eyebrow">Resultado do dia</span>
            <span
              className={`figure-sm ${daily.limitBasisPnl >= 0 ? 'gain' : 'loss'}`}
              title="Somente operacoes fechadas, ja com custos. Depositos e saques ficam de fora."
            >
              {signed(daily.limitBasisPnl)}
            </span>
          </div>
          <div className="strip-cell">
            <span className="eyebrow">Conta</span>
            <Badge tone="watch">{snapshot.account.accountType}</Badge>
          </div>
          <div className="strip-cell">
            <span className="eyebrow">Conexao</span>
            <Badge tone={snapshot.account.connected ? (stale ? 'block' : 'ok') : 'risk'}>
              <span className="dot" />
              {snapshot.account.connected ? (stale ? 'dados atrasados' : 'ativa') : 'sem conexao'}
            </Badge>
          </div>
          <div className="strip-cell">
            <span className="eyebrow">Ultima atualizacao</span>
            <span className="small num">
              {clock(snapshot.account.lastUpdateAt)} · {relative(snapshot.account.lastUpdateAt, snapshot.now)}
            </span>
          </div>
          <div className="strip-cell">
            <span className="eyebrow">Modo</span>
            <Badge tone={snapshot.mode === 'AUTO' ? 'ok' : snapshot.mode === 'SEMI_AUTO' ? 'watch' : 'neutral'}>
              {MODE_LABEL[snapshot.mode]}
            </Badge>
          </div>
          <div className="strip-actions">
            {snapshot.automationPaused && <Badge tone="block">Automacao pausada</Badge>}
            {snapshot.day.dailyLimitHit && (
              <Badge tone="risk">
                {snapshot.day.dailyLimitHit === 'LOSS' ? 'Stop diario atingido' : 'Stop win atingido'}
              </Badge>
            )}
          </div>
        </div>

        {route === 'home' && <Home snapshot={snapshot} meta={meta} />}
        {route === 'fontes' && <Fontes snapshot={snapshot} meta={meta} />}
        {route === 'convergencias' && <Convergencias snapshot={snapshot} />}
        {route === 'operacoes' && <Operacoes snapshot={snapshot} />}
        {route === 'corretoras' && <Corretoras snapshot={snapshot} />}
        {route === 'configuracoes' && <Configuracoes snapshot={snapshot} meta={meta} />}
      </main>
    </div>
  );
}
