import { useState } from 'react';
import {
  MARKETS,
  MARKET_LABEL,
  api,
  useMarketSelection,
  useMeta,
  useSnapshot,
  useTelegram,
  type MarketId,
} from './api.ts';
import { Badge, MODE_LABEL, clock, money, relative, signed } from './components/ui.tsx';
import { ThemeToggle } from './components/ThemeToggle.tsx';
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
  /*
   * O estado do Telegram vem de rota protegida e por isso fica fora de
   * `/api/state`. Recarrega junto com o instantaneo.
   */
  const telegram = useTelegram(snapshot?.now?.slice(0, 19));
  const [route, setRoute] = useState<Route>('home');
  const [marketId, setMarketId] = useMarketSelection();

  if (!snapshot) {
    return (
      <div className="page">
        <h1>Convergencia de Sinais</h1>
        <p className="muted">{error ?? 'Carregando o estado do backend...'}</p>
        {error && (
          <p className="small dim">
            Verifique se o backend esta no ar em <span className="num">http://localhost:8787</span>.
          </p>
        )}
      </div>
    );
  }

  const market = snapshot.markets[marketId];
  const live = market.opportunities.filter(
    (o: any) => o.status === 'PUBLISHED' || o.status === 'UPDATED',
  );
  const quoteAgeSeconds =
    (Date.parse(snapshot.now) - Date.parse(market.account.lastUpdateAt)) / 1000;
  const stale = quoteAgeSeconds > market.riskSettings.maxQuoteAgeSeconds;
  const daily = market.daily;
  const unclassified = snapshot.unclassifiedSources.length;

  const liveCountOf = (id: MarketId) =>
    snapshot.markets[id].opportunities.filter(
      (o: any) => o.status === 'PUBLISHED' || o.status === 'UPDATED',
    ).length;

  const nav: Array<{ key: Route; label: string; count?: number }> = [
    { key: 'home', label: 'Home' },
    { key: 'fontes', label: 'Fontes', count: market.sources.length },
    { key: 'convergencias', label: 'Convergencias', count: live.length },
    { key: 'operacoes', label: 'Operacoes', count: market.openPositions.length },
    { key: 'corretoras', label: 'Conexoes' },
    { key: 'configuracoes', label: 'Configuracoes' },
  ];

  return (
    <div className="app" data-market={marketId}>
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
          <ThemeToggle />

          <div className="eyebrow">Modo de {MARKET_LABEL[marketId]}</div>
          <div className="seg" role="group" aria-label={`Modo operacional de ${MARKET_LABEL[marketId]}`}>
            {(['OBSERVE', 'SEMI_AUTO', 'AUTO'] as const).map((m) => (
              <button
                key={m}
                aria-pressed={market.mode === m}
                onClick={() => void api.setMode(marketId, m)}
                style={{ flex: 1, fontSize: 11, padding: '5px 4px' }}
              >
                {m === 'OBSERVE' ? 'Observ.' : m === 'SEMI_AUTO' ? 'Semi' : 'Auto'}
              </button>
            ))}
          </div>

          <div className="eyebrow">Automacao por mercado</div>
          {MARKETS.map((id) => (
            <button
              key={id}
              className={snapshot.markets[id].automationEnabled ? 'btn btn-danger' : 'btn'}
              onClick={() => void api.setAutomation(id, !snapshot.markets[id].automationEnabled)}
              title={`Liga e desliga apenas a automacao de ${MARKET_LABEL[id]}`}
            >
              {MARKET_LABEL[id]}: {snapshot.markets[id].automationEnabled ? 'ligada' : 'desligada'}
            </button>
          ))}

          <button
            className={snapshot.globalPaused ? 'btn btn-primary' : 'btn btn-danger'}
            onClick={() => void api.setGlobalPaused(!snapshot.globalPaused)}
          >
            {snapshot.globalPaused ? 'Retomar tudo' : 'Pausar tudo'}
          </button>
          <p className="tiny dim">
            Pausar interrompe novas entradas automaticas nos dois mercados. Posicoes abertas seguem
            com stop e alvo.
          </p>
        </div>
      </aside>

      <main className="main">
        <div className="sim-banner">
          <span>CONTAS SIMULADAS — dados sinteticos, nenhuma corretora ou exchange real conectada</span>
          <span>Resultados nao tem valor preditivo</span>
        </div>

        <div className="market-switch">
          <span className="eyebrow">Mercado</span>
          <div className="market-seg" role="group" aria-label="Mercado">
            {MARKETS.map((id) => (
              <button
                key={id}
                data-market={id}
                aria-pressed={marketId === id}
                onClick={() => setMarketId(id)}
              >
                {MARKET_LABEL[id]}
                <span className="nav-count">{liveCountOf(id)}</span>
              </button>
            ))}
          </div>

          <span className="small dim">
            Fontes, oportunidades, configuracoes e operacoes abaixo sao apenas de{' '}
            {MARKET_LABEL[marketId]}.
          </span>

          <div className="row" style={{ marginLeft: 'auto', gap: 8 }}>
            {MARKETS.map((id) => (
              <Badge key={id} tone={snapshot.markets[id].automationEnabled ? 'ok' : 'neutral'}>
                {MARKET_LABEL[id]} {snapshot.markets[id].automationEnabled ? 'auto ON' : 'auto OFF'}
              </Badge>
            ))}
            {snapshot.globalPaused && <Badge tone="block">pausa global</Badge>}
            {snapshot.globalDay.dailyLimitHit && (
              <Badge tone="risk">
                limite global {snapshot.globalDay.dailyLimitHit === 'LOSS' ? 'de perda' : 'de ganho'}
              </Badge>
            )}
          </div>
        </div>

        <div className="strip">
          <div className="strip-cell">
            <span className="eyebrow">Patrimonio {MARKET_LABEL[marketId]}</span>
            <span className="figure-sm">{money(market.account.equity, market.account.currency)}</span>
          </div>
          <div className="strip-cell">
            <span className="eyebrow">Margem livre</span>
            <span className="figure-sm">
              {money(market.account.freeMargin, market.account.currency)}
            </span>
          </div>
          <div className="strip-cell">
            <span className="eyebrow">Resultado do dia</span>
            <span
              className={`figure-sm ${daily.limitBasisPnl >= 0 ? 'gain' : 'loss'}`}
              title="Somente operacoes fechadas deste mercado, ja com custos."
            >
              {signed(daily.limitBasisPnl, market.account.currency)}
            </span>
          </div>
          <div className="strip-cell">
            <span className="eyebrow">Consolidado</span>
            <span
              className="figure-sm"
              title={snapshot.consolidated.conversionNote}
            >
              {money(snapshot.consolidated.equityInReference, snapshot.consolidated.referenceCurrency)}
            </span>
          </div>
          <div className="strip-cell">
            <span className="eyebrow">Conta</span>
            <Badge tone="watch">{market.account.accountType}</Badge>
            <span className="tiny dim num">{market.account.accountId}</span>
          </div>
          <div className="strip-cell">
            <span className="eyebrow">Conexao</span>
            <Badge tone={market.account.connected ? (stale ? 'block' : 'ok') : 'risk'}>
              <span className="dot" />
              {market.account.connected ? (stale ? 'dados atrasados' : 'ativa') : 'sem conexao'}
            </Badge>
          </div>
          <div className="strip-cell">
            <span className="eyebrow">Ultima atualizacao</span>
            <span className="small num">
              {clock(market.account.lastUpdateAt)} · {relative(market.account.lastUpdateAt, snapshot.now)}
            </span>
          </div>
          <div className="strip-cell">
            <span className="eyebrow">Modo</span>
            <Badge tone={market.mode === 'AUTO' ? 'ok' : market.mode === 'SEMI_AUTO' ? 'watch' : 'neutral'}>
              {MODE_LABEL[market.mode]}
            </Badge>
          </div>
          <div className="strip-actions">
            {!market.automationEnabled && <Badge tone="block">automacao deste mercado desligada</Badge>}
            {market.day.dailyLimitHit && (
              <Badge tone="risk">
                {market.day.dailyLimitHit === 'LOSS' ? 'Stop diario atingido' : 'Stop win atingido'}
              </Badge>
            )}
          </div>
        </div>

        {unclassified > 0 && (
          <div style={{ padding: '10px 22px 0' }}>
            <div className="notice notice-warn small">
              <strong>
                {unclassified} fonte(s) sem mercado classificado.
              </strong>{' '}
              Registros preservados, porem sem voto em nenhum mercado ate a classificacao. Ajuste na
              tela Fontes.
            </div>
          </div>
        )}

        {route === 'home' && (
          <Home
            snapshot={snapshot}
            market={market}
            meta={meta}
            telegram={telegram.telegram}
            onGerenciarTelegram={() => setRoute('fontes')}
          />
        )}
        {route === 'fontes' && (
          <Fontes snapshot={snapshot} market={market} meta={meta} telegram={telegram} />
        )}
        {route === 'convergencias' && <Convergencias market={market} />}
        {route === 'operacoes' && <Operacoes market={market} />}
        {route === 'corretoras' && <Corretoras snapshot={snapshot} market={market} />}
        {route === 'configuracoes' && (
          <Configuracoes snapshot={snapshot} market={market} meta={meta} />
        )}
      </main>
    </div>
  );
}
