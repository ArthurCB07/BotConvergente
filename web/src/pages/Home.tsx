import { useState } from 'react';
import { api, type Meta, type Snapshot } from '../api.ts';
import { OpportunityCard } from '../components/OpportunityCard.tsx';
import { Badge, Card, Empty, Meter, SIDE_LABEL, clock, money, pct, signed } from '../components/ui.tsx';

export function Home({ snapshot, meta }: { snapshot: Snapshot; meta: Meta | null }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const live = snapshot.opportunities.filter(
    (o: any) => o.status === 'PUBLISHED' || o.status === 'UPDATED',
  );
  const recent = snapshot.opportunities
    .filter((o: any) => o.status === 'EXECUTED' || o.status === 'EXPIRED' || o.status === 'REJECTED_BY_USER')
    .slice(0, 4);

  const daily = snapshot.daily;
  const risk = snapshot.riskSettings;
  const closedToday = snapshot.positions.filter((p: any) => p.status === 'CLOSED');

  const act = async (fn: () => Promise<any>, key: string) => {
    setBusy(key);
    setMessage(null);
    try {
      const result = await fn();
      if (result?.message) setMessage(result.message);
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <div className="eyebrow">Home</div>
          <h1>Oportunidades convergentes</h1>
        </div>
        <div className="row">
          {meta?.scenarios?.slice(0, 3).map((s) => (
            <button
              key={s.key}
              className="btn btn-sm"
              onClick={() => void act(() => api.runScenario(s.key), s.key)}
              title={s.description}
            >
              {s.name}
            </button>
          ))}
        </div>
      </header>

      {message && <div className="notice small">{message}</div>}

      <div className="grid grid-home">
        <div className="stack">
          {live.length === 0 ? (
            <Card title="Nenhuma convergencia ativa">
              <Empty>
                Assim que as fontes concordarem dentro dos criterios configurados, a oportunidade
                aparece aqui com os motivos. Use a tela Convergencias para ver o que faltou.
              </Empty>
            </Card>
          ) : (
            live.map((opportunity: any) => (
              <OpportunityCard
                key={opportunity.id}
                opportunity={opportunity}
                decision={snapshot.decisions[opportunity.id]}
                now={snapshot.now}
                mode={snapshot.mode}
                awaiting={snapshot.awaitingConfirmation.includes(opportunity.id)}
                busy={busy === opportunity.id}
                onConfirm={() => void act(() => api.confirm(opportunity.id), opportunity.id)}
                onReject={() => void act(() => api.reject(opportunity.id), opportunity.id)}
              />
            ))
          )}

          <Card title="Operacoes abertas" tight>
            {snapshot.openPositions.length === 0 ? (
              <Empty>Nenhuma posicao aberta na conta simulada.</Empty>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Ativo</th>
                      <th>Direcao</th>
                      <th className="num">Lotes</th>
                      <th className="num">Abertura</th>
                      <th className="num">Stop</th>
                      <th className="num">Alvo</th>
                      <th className="num">Resultado</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.openPositions.map((p: any) => (
                      <tr key={p.id}>
                        <td className="num">{p.symbol}</td>
                        <td>
                          <Badge tone={p.side === 'BUY' ? 'long' : 'short'}>{SIDE_LABEL[p.side]}</Badge>
                        </td>
                        <td className="num">{p.lots}</td>
                        <td className="num">{p.openPrice}</td>
                        <td className="num">{p.stopLoss ?? '—'}</td>
                        <td className="num">{p.takeProfit ?? '—'}</td>
                        <td className={`num ${p.netPnl >= 0 ? 'gain' : 'loss'}`}>{signed(p.netPnl)}</td>
                        <td className="num">
                          <button
                            className="btn btn-sm"
                            onClick={() => void act(() => api.closePosition(p.id), p.id)}
                          >
                            Encerrar
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title="Historico de decisoes" aside={<span className="tiny dim">ultimos eventos</span>} tight>
            <div className="log">
              {snapshot.events.slice(0, 14).map((event: any) => (
                <div key={event.id} className="log-row">
                  <span className="log-time">{clock(event.at)}</span>
                  <span className={`log-bar log-${event.severity}`} />
                  <span>
                    <span className="log-title">{event.title}</span>
                    <br />
                    <span className="log-detail small">{event.detail}</span>
                  </span>
                </div>
              ))}
            </div>
          </Card>
        </div>

        <div className="stack">
          <Card title="Limites do dia">
            <div className="stack-sm">
              <div>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="small muted">Stop diario ({risk.dailyLossLimitPercent}%)</span>
                  <span className="small num">
                    {signed(daily.limitBasisPnl)} / {money(daily.lossLimitValue)}
                  </span>
                </div>
                <Meter
                  value={Math.min(0, daily.limitBasisPnl)}
                  max={daily.lossLimitValue}
                  tone="var(--risk)"
                />
              </div>
              <div>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="small muted">Stop win ({risk.dailyProfitTargetPercent}%)</span>
                  <span className="small num">
                    {signed(daily.limitBasisPnl)} / {money(daily.profitTargetValue)}
                  </span>
                </div>
                <Meter value={Math.max(0, daily.limitBasisPnl)} max={daily.profitTargetValue} tone="var(--ok)" />
              </div>
              <div>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="small muted">Operacoes hoje</span>
                  <span className="small num">
                    {snapshot.day.tradesToday} / {risk.maxTradesPerDay}
                  </span>
                </div>
                <Meter value={snapshot.day.tradesToday} max={risk.maxTradesPerDay} tone="var(--watch)" />
              </div>
            </div>

            <dl className="param-note small" style={{ marginTop: 12 }}>
              <dt>Base</dt>
              <dd>{money(daily.baseEquity)} na abertura do dia {snapshot.day.dayKey}</dd>
              <dt>Fechado</dt>
              <dd className={daily.realizedNetPnl >= 0 ? 'gain' : 'loss'}>{signed(daily.realizedNetPnl)}</dd>
              <dt>Aberto</dt>
              <dd className={daily.unrealizedPnl >= 0 ? 'gain' : 'loss'}>
                {signed(daily.unrealizedPnl)} <span className="dim">(nao conta para os limites)</span>
              </dd>
              <dt>Custos</dt>
              <dd>{money(daily.costs)}</dd>
              <dt>Caixa</dt>
              <dd>
                {money(daily.cashFlows)} <span className="dim">depositos e saques, fora do resultado</span>
              </dd>
            </dl>
          </Card>

          <Card title="Cotacoes" tight>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Ativo</th>
                    <th className="num">Compra</th>
                    <th className="num">Venda</th>
                    <th className="num">Spread</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.quotes.map((q: any) => (
                    <tr key={q.symbol}>
                      <td className="num">{q.symbol}</td>
                      <td className="num">{q.ask}</td>
                      <td className="num">{q.bid}</td>
                      <td
                        className="num"
                        style={{ color: q.spreadPips > risk.maxSpreadPips ? 'var(--block)' : undefined }}
                      >
                        {q.spreadPips}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card title="Fechadas recentemente" tight>
            {closedToday.length === 0 ? (
              <Empty>Nenhuma operacao encerrada ainda.</Empty>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Ativo</th>
                      <th>Motivo</th>
                      <th className="num">Liquido</th>
                    </tr>
                  </thead>
                  <tbody>
                    {closedToday.slice(-6).reverse().map((p: any) => (
                      <tr key={p.id}>
                        <td className="num">{p.symbol}</td>
                        <td className="small">{p.closeReason}</td>
                        <td className={`num ${p.netPnl >= 0 ? 'gain' : 'loss'}`}>{signed(p.netPnl)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {recent.length > 0 && (
            <Card title="Oportunidades encerradas" tight>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Ativo</th>
                      <th>Situacao</th>
                      <th className="num">Concordancia</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recent.map((o: any) => (
                      <tr key={o.id}>
                        <td className="num">{o.symbol}</td>
                        <td className="small">{o.status}</td>
                        <td className="num">{pct(o.agreementPercent, 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
