import { useState } from 'react';
import {
  MARKET_LABEL,
  api,
  type Meta,
  type MarketSlice,
  type Snapshot,
  type TelegramState,
} from '../api.ts';
import { TelegramResumo } from '../components/TelegramPanel.tsx';
import { OpportunityCard } from '../components/OpportunityCard.tsx';
import { ReferenceQuotesCard, SimulatedQuotesCard } from '../components/QuotesCard.tsx';
import { CryptoQuotesCard } from '../components/CryptoQuotesCard.tsx';
import {
  Badge,
  Card,
  Empty,
  MarketChip,
  Meter,
  SIDE_LABEL,
  clock,
  money,
  pct,
  signed,
} from '../components/ui.tsx';

export function Home({
  snapshot,
  market,
  meta,
  telegram,
  onGerenciarTelegram,
}: {
  snapshot: Snapshot;
  market: MarketSlice;
  meta: Meta | null;
  telegram: TelegramState | null;
  onGerenciarTelegram: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const marketId = market.marketId;
  const currency = market.account.currency;
  const live = market.opportunities.filter(
    (o: any) => o.status === 'PUBLISHED' || o.status === 'UPDATED',
  );
  const daily = market.daily;
  const risk = market.riskSettings;
  const closed = market.positions.filter((p: any) => p.status === 'CLOSED');
  const other = marketId === 'FOREX' ? 'CRYPTO' : 'FOREX';
  const otherMarket = snapshot.markets[other];

  const scenarios = (meta?.scenarios ?? []).filter(
    (s) => s.marketId === marketId || s.marketId === null,
  );

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
          <div className="eyebrow">Home · {MARKET_LABEL[marketId]}</div>
          <h1>Oportunidades convergentes de {MARKET_LABEL[marketId]}</h1>
        </div>
        <div className="row">
          {scenarios.slice(0, 3).map((s) => (
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
            <Card title={`Nenhuma convergencia ativa em ${MARKET_LABEL[marketId]}`}>
              <Empty>
                Assim que as fontes de {MARKET_LABEL[marketId]} concordarem dentro dos criterios
                deste mercado, a oportunidade aparece aqui com os motivos.
                {otherMarket.opportunities.some(
                  (o: any) => o.status === 'PUBLISHED' || o.status === 'UPDATED',
                )
                  ? ` Existe convergencia ativa em ${MARKET_LABEL[other]}: troque o mercado no seletor acima.`
                  : ''}
              </Empty>
            </Card>
          ) : (
            live.map((opportunity: any) => (
              <OpportunityCard
                key={opportunity.id}
                opportunity={opportunity}
                decision={snapshot.decisions[opportunity.id]}
                now={snapshot.now}
                mode={market.mode}
                currency={currency}
                awaiting={snapshot.awaitingConfirmation.includes(opportunity.id)}
                busy={busy === opportunity.id}
                onConfirm={() => void act(() => api.confirm(opportunity.id), opportunity.id)}
                onReject={() => void act(() => api.reject(opportunity.id), opportunity.id)}
              />
            ))
          )}

          <Card title={`Operacoes abertas em ${MARKET_LABEL[marketId]}`} tight>
            {market.openPositions.length === 0 ? (
              <Empty>Nenhuma posicao aberta neste mercado.</Empty>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Ativo</th>
                      <th>Direcao</th>
                      <th className="num">Quantidade</th>
                      <th className="num">Abertura</th>
                      <th className="num">Stop</th>
                      <th className="num">Alvo</th>
                      <th className="num">Resultado</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {market.openPositions.map((p: any) => (
                      <tr key={p.id}>
                        <td className="num">{p.symbol}</td>
                        <td>
                          <Badge tone={p.side === 'BUY' ? 'long' : 'short'}>{SIDE_LABEL[p.side]}</Badge>
                        </td>
                        <td className="num">
                          {p.quantity} {p.quantityLabel}
                        </td>
                        <td className="num">{p.openPrice}</td>
                        <td className="num">{p.stopLoss ?? '—'}</td>
                        <td className="num">{p.takeProfit ?? '—'}</td>
                        <td className={`num ${p.netPnl >= 0 ? 'gain' : 'loss'}`}>
                          {signed(p.netPnl, currency)}
                        </td>
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

          <Card
            title="Historico de decisoes"
            aside={<span className="tiny dim">{MARKET_LABEL[marketId]} e eventos globais</span>}
            tight
          >
            <div className="log">
              {market.events.slice(0, 14).map((event: any) => (
                <div key={event.id} className="log-row">
                  <span className="log-time">{clock(event.at)}</span>
                  <span className={`log-bar log-${event.severity}`} />
                  <span>
                    <span className="log-title">{event.title}</span>{' '}
                    {event.marketId ? (
                      <MarketChip marketId={event.marketId} />
                    ) : (
                      <Badge tone="watch">global</Badge>
                    )}
                    <br />
                    <span className="log-detail small">{event.detail}</span>
                  </span>
                </div>
              ))}
            </div>
          </Card>
        </div>

        <div className="stack">
          <TelegramResumo
            telegram={telegram}
            now={snapshot.now}
            onGerenciar={onGerenciarTelegram}
          />

          <Card title={`Limites de ${MARKET_LABEL[marketId]}`}>
            <div className="stack-sm">
              <div>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="small muted">Stop diario ({risk.dailyLossLimitPercent}%)</span>
                  <span className="small num">
                    {signed(daily.limitBasisPnl, currency)} / {money(daily.lossLimitValue, currency)}
                  </span>
                </div>
                <Meter value={Math.min(0, daily.limitBasisPnl)} max={daily.lossLimitValue} tone="var(--risk)" />
              </div>
              <div>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="small muted">Stop win ({risk.dailyProfitTargetPercent}%)</span>
                  <span className="small num">
                    {signed(daily.limitBasisPnl, currency)} / {money(daily.profitTargetValue, currency)}
                  </span>
                </div>
                <Meter value={Math.max(0, daily.limitBasisPnl)} max={daily.profitTargetValue} tone="var(--ok)" />
              </div>
              <div>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="small muted">Operacoes hoje</span>
                  <span className="small num">
                    {market.day.tradesToday} / {risk.maxTradesPerDay}
                  </span>
                </div>
                <Meter value={market.day.tradesToday} max={risk.maxTradesPerDay} tone="var(--market-accent)" />
              </div>
            </div>

            <dl className="param-note small" style={{ marginTop: 12 }}>
              <dt>Base</dt>
              <dd>
                {money(daily.baseEquity, currency)} na abertura do dia {market.day.dayKey}
              </dd>
              <dt>Fechado</dt>
              <dd className={daily.realizedNetPnl >= 0 ? 'gain' : 'loss'}>
                {signed(daily.realizedNetPnl, currency)}
              </dd>
              <dt>Aberto</dt>
              <dd className={daily.unrealizedPnl >= 0 ? 'gain' : 'loss'}>
                {signed(daily.unrealizedPnl, currency)}{' '}
                <span className="dim">(nao conta para os limites)</span>
              </dd>
              <dt>Custos</dt>
              <dd>{money(daily.costs, currency)}</dd>
            </dl>
          </Card>

          <Card title="Limites globais" aside={<Badge tone={snapshot.globalRisk.enabled ? 'ok' : 'neutral'}>
            {snapshot.globalRisk.enabled ? 'ativos' : 'desligados'}
          </Badge>}>
            <div className="notice scope-global small" style={{ marginBottom: 10 }}>
              Somam os dois mercados. Quando um limite global e atingido, os dois param.
            </div>
            <dl className="param-note small">
              <dt>Posicoes</dt>
              <dd className="num">
                {snapshot.consolidated.openPositions} / {snapshot.globalRisk.maxOpenPositionsTotal}
              </dd>
              <dt>Exposicao</dt>
              <dd className="num">
                {money(snapshot.consolidated.exposureInReference, snapshot.consolidated.referenceCurrency)}{' '}
                / {money(snapshot.globalRisk.maxTotalExposureNotional, snapshot.consolidated.referenceCurrency)}
              </dd>
              <dt>Dia</dt>
              <dd className={snapshot.globalDay.realizedNetPnl >= 0 ? 'gain' : 'loss'}>
                {signed(snapshot.globalDay.realizedNetPnl, snapshot.consolidated.referenceCurrency)}{' '}
                <span className="dim">
                  sobre base {money(snapshot.globalDay.baseEquity, snapshot.consolidated.referenceCurrency)}
                </span>
              </dd>
              <dt>Conversao</dt>
              <dd className="dim">{snapshot.consolidated.conversionNote}</dd>
              <dt>Contas</dt>
              <dd>
                {snapshot.consolidated.sharedAccount
                  ? 'Mesma conta para os dois mercados: margem reservada de forma coordenada.'
                  : 'Contas separadas por mercado, saldos exibidos individualmente.'}
              </dd>
            </dl>
          </Card>

          {market.referenceQuotes && (
            <ReferenceQuotesCard referenceQuotes={market.referenceQuotes} now={snapshot.now} />
          )}

          {market.cryptoQuotes && (
            <CryptoQuotesCard cryptoQuotes={market.cryptoQuotes} now={snapshot.now} />
          )}

          <SimulatedQuotesCard
            quotes={market.quotes}
            maxSpreadPips={risk.maxSpreadPips}
            marketId={marketId}
          />

          <Card title="Fechadas recentemente" tight>
            {closed.length === 0 ? (
              <Empty>Nenhuma operacao encerrada neste mercado.</Empty>
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
                    {closed.slice(-6).reverse().map((p: any) => (
                      <tr key={p.id}>
                        <td className="num">{p.symbol}</td>
                        <td className="small">{p.closeReason}</td>
                        <td className={`num ${p.netPnl >= 0 ? 'gain' : 'loss'}`}>
                          {signed(p.netPnl, currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title={`Resumo de ${MARKET_LABEL[other]}`}>
            <p className="small muted">
              O outro mercado continua rodando com configuracao, automacao e limites proprios.
            </p>
            <dl className="param-note small" style={{ marginTop: 8 }}>
              <dt>Automacao</dt>
              <dd>{otherMarket.automationEnabled ? 'ligada' : 'desligada'}</dd>
              <dt>Convergencias</dt>
              <dd className="num">
                {
                  otherMarket.opportunities.filter(
                    (o: any) => o.status === 'PUBLISHED' || o.status === 'UPDATED',
                  ).length
                }{' '}
                ativa(s)
              </dd>
              <dt>Abertas</dt>
              <dd className="num">{otherMarket.openPositions.length}</dd>
              <dt>Dia</dt>
              <dd className={otherMarket.daily.limitBasisPnl >= 0 ? 'gain' : 'loss'}>
                {signed(otherMarket.daily.limitBasisPnl, otherMarket.account.currency)}
              </dd>
            </dl>
          </Card>

          {market.opportunities.some((o: any) => o.status === 'EXECUTED') && (
            <Card title="Oportunidades executadas" tight>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Ativo</th>
                      <th className="num">Concordancia</th>
                      <th className="num">Execucoes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {market.opportunities
                      .filter((o: any) => o.status === 'EXECUTED')
                      .slice(0, 6)
                      .map((o: any) => (
                        <tr key={o.id}>
                          <td className="num">{o.symbol}</td>
                          <td className="num">{pct(o.agreementPercent, 0)}</td>
                          <td className="num">{o.executionCount}</td>
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
