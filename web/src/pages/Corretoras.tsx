import { MARKETS, MARKET_LABEL, api, type MarketId, type MarketSlice, type Snapshot } from '../api.ts';
import { Badge, Card, MarketChip, money } from '../components/ui.tsx';

const STATUS: Record<string, { tone: 'ok' | 'block' | 'watch' | 'risk' | 'neutral'; label: string }> = {
  CONNECTED: { tone: 'ok', label: 'conectada' },
  DISCONNECTED: { tone: 'block', label: 'desconectada' },
  NOT_IMPLEMENTED: { tone: 'neutral', label: 'nao implementada' },
  ERROR: { tone: 'risk', label: 'erro' },
};

function Yes({ value }: { value: boolean }) {
  return <span style={{ color: value ? 'var(--ok)' : 'var(--ink-3)' }}>{value ? 'sim' : 'nao'}</span>;
}

export function Corretoras({ snapshot, market }: { snapshot: Snapshot; market: MarketSlice }) {
  const marketId = market.marketId;
  const compatible = snapshot.availableAccounts.filter((a: any) => a.markets.includes(marketId));

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <div className="eyebrow">Conexoes · {MARKET_LABEL[marketId]}</div>
          <h1>Contas e integracoes por mercado</h1>
        </div>
        <div className="row">
          <MarketChip marketId={marketId} />
          <select
            onChange={(e) => void api.setFailure(market.accountId, e.target.value)}
            defaultValue="NONE"
            style={{ width: 190 }}
          >
            <option value="NONE">Sem falha injetada</option>
            <option value="TIMEOUT">Timeout nas ordens</option>
            <option value="REJECT">Rejeicao nas ordens</option>
            <option value="DISCONNECTED">Desconectada</option>
          </select>
        </div>
      </header>

      <div className="notice small">
        <strong>Nenhuma conexao real esta ativa.</strong> O ambiente usa contas simuladas. As
        integracoes abaixo estao descritas com base na documentacao oficial de cada plataforma e
        aparecem como nao implementadas ate serem construidas e testadas em ambiente demonstrativo.
        Uma conexao de Forex nao opera Cripto, e o contrario tambem nao.
      </div>

      <Card title={`Conta usada por ${MARKET_LABEL[marketId]}`}>
        <div className="stack-sm">
          <div className="row">
            <label className="field" style={{ minWidth: 280 }}>
              <span className="eyebrow">Conexao deste mercado</span>
              <select
                value={market.accountId}
                onChange={async (e) => {
                  const result = (await api.setAccount(marketId, e.target.value)) as any;
                  if (result && result.ok === false) alert(result.message);
                }}
              >
                {compatible.map((a: any) => (
                  <option key={a.brokerId} value={a.brokerId}>
                    {a.brokerName} — {a.currency}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="btn"
              onClick={() => void api.setConnected(market.accountId, !market.account.connected)}
            >
              {market.account.connected ? 'Simular queda de conexao' : 'Restabelecer conexao'}
            </button>
          </div>
          <p className="tiny dim">
            So aparecem conexoes que declaram atender {MARKET_LABEL[marketId]}. Trocar de conta exige
            que nao existam posicoes abertas deste mercado.
          </p>
        </div>

        <div className="grid grid-4" style={{ marginTop: 14 }}>
          <div>
            <div className="eyebrow">Tipo</div>
            <Badge tone="watch">{market.account.accountType}</Badge>
          </div>
          <div>
            <div className="eyebrow">Saldo</div>
            <div className="figure-sm">{money(market.account.balance, market.account.currency)}</div>
          </div>
          <div>
            <div className="eyebrow">Patrimonio</div>
            <div className="figure-sm">{money(market.account.equity, market.account.currency)}</div>
          </div>
          <div>
            <div className="eyebrow">Margem usada / reservada / livre</div>
            <div className="figure-sm">
              {money(market.account.usedMargin, market.account.currency)}
              <span className="dim"> / </span>
              {money(market.account.reservedMargin, market.account.currency)}
              <span className="dim"> / </span>
              {money(market.account.freeMargin, market.account.currency)}
            </div>
          </div>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn btn-sm" onClick={() => void api.cashflow(market.accountId, 1000)}>
            Depositar 1.000
          </button>
          <button className="btn btn-sm" onClick={() => void api.cashflow(market.accountId, -1000)}>
            Sacar 1.000
          </button>
          <span className="tiny dim">
            Depositos e saques entram no saldo e ficam fora do resultado operacional.
          </span>
        </div>
      </Card>

      <Card title="Saldos por conta">
        <div className="notice scope-global small" style={{ marginBottom: 12 }}>
          {snapshot.consolidated.sharedAccount
            ? 'Os dois mercados usam a MESMA conta. A margem e reservada de forma coordenada antes de cada envio, para que duas ordens simultaneas nao comprometam o mesmo saldo.'
            : 'Cada mercado usa uma conta propria. Os saldos aparecem separados; o total consolidado declara a moeda e a conversao usada.'}
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Conta</th>
                <th>Mercados</th>
                <th>Moeda</th>
                <th className="num">Saldo</th>
                <th className="num">Patrimonio</th>
                <th className="num">Margem usada</th>
                <th className="num">Reservada</th>
                <th className="num">Livre</th>
                <th>Conexao</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.consolidated.accounts.map((a: any) => (
                <tr key={a.accountId}>
                  <td>
                    <div style={{ fontWeight: 500 }}>{a.brokerName}</div>
                    <div className="tiny dim num">{a.accountId}</div>
                  </td>
                  <td>
                    <div className="row" style={{ gap: 4 }}>
                      {a.markets.map((m: MarketId) => (
                        <MarketChip key={m} marketId={m} />
                      ))}
                    </div>
                  </td>
                  <td className="num">{a.currency}</td>
                  <td className="num">{money(a.balance, a.currency)}</td>
                  <td className="num">{money(a.equity, a.currency)}</td>
                  <td className="num">{money(a.usedMargin, a.currency)}</td>
                  <td className="num">{money(a.reservedMargin, a.currency)}</td>
                  <td className="num">{money(a.freeMargin, a.currency)}</td>
                  <td>
                    <Badge tone={a.connected ? 'ok' : 'risk'}>
                      {a.connected ? 'ativa' : 'sem conexao'}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted" style={{ marginTop: 12 }}>
          <strong>
            Total consolidado:{' '}
            {money(snapshot.consolidated.equityInReference, snapshot.consolidated.referenceCurrency)}
          </strong>{' '}
          — {snapshot.consolidated.conversionNote}
        </p>
      </Card>

      <Card title="Comparativo de integracoes" tight>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Plataforma</th>
                <th>Mercados</th>
                <th>Situacao</th>
                <th>Conta e posicoes</th>
                <th>Ordens</th>
                <th>Demo</th>
                <th>Terminal local</th>
                <th>Autenticacao</th>
                <th>Documentacao</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.brokerCatalog.map((broker: any) => {
                const status = STATUS[broker.status] ?? STATUS.NOT_IMPLEMENTED!;
                return (
                  <tr key={broker.id}>
                    <td>
                      <div style={{ fontWeight: 500 }}>{broker.name}</div>
                      <div className="tiny dim">{broker.products.join(', ')}</div>
                    </td>
                    <td>
                      <div className="row" style={{ gap: 4 }}>
                        {broker.markets.map((m: MarketId) => (
                          <MarketChip key={m} marketId={m} />
                        ))}
                      </div>
                    </td>
                    <td>
                      <Badge tone={status.tone}>{status.label}</Badge>
                    </td>
                    <td className="small">
                      saldo/equity <Yes value={broker.capabilities.account} />
                      <br />
                      posicoes <Yes value={broker.capabilities.positions} />
                    </td>
                    <td className="small">
                      envio <Yes value={broker.capabilities.marketOrders} />
                      <br />
                      cancelamento <Yes value={broker.capabilities.cancelOrders} />
                      <br />
                      stop/alvo na ordem <Yes value={broker.capabilities.attachedStops} />
                      <br />
                      busca por chave <Yes value={broker.capabilities.clientOrderIdLookup} />
                    </td>
                    <td className="small">
                      <Yes value={broker.capabilities.demoEnvironment} />
                    </td>
                    <td className="small">
                      <Yes value={broker.capabilities.requiresLocalTerminal} />
                    </td>
                    <td className="small" style={{ maxWidth: 240 }}>
                      {broker.authentication}
                    </td>
                    <td className="small">
                      {broker.docsUrl ? (
                        <a href={broker.docsUrl} target="_blank" rel="noreferrer">
                          fonte oficial
                        </a>
                      ) : (
                        <span className="dim">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid grid-3">
        {snapshot.brokerCatalog
          .filter((b: any) => b.markets.includes(marketId))
          .map((broker: any) => (
            <Card key={broker.id} title={broker.name}>
              {broker.requirements.length > 0 && (
                <>
                  <div className="eyebrow">O que falta para habilitar</div>
                  <ul className="small muted" style={{ paddingLeft: 16, margin: '6px 0 12px' }}>
                    {broker.requirements.map((r: string) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                </>
              )}
              <div className="eyebrow">Restricoes relevantes</div>
              <ul className="small muted" style={{ paddingLeft: 16, margin: '6px 0 0' }}>
                {broker.restrictions.map((r: string) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </Card>
          ))}
      </div>

      <Card title="Credenciais">
        <p className="small muted">
          Credenciais de corretora e de exchange ficam no backend, cifradas em repouso, e nunca
          trafegam para o frontend nem aparecem em log. Consulta de conta e autorizacao de negociacao
          sao pedidas separadamente quando a plataforma permite.
        </p>
        <p className="small muted">
          Nenhum campo de credencial e preenchido automaticamente: login, servidor, client id, secret
          e chave de API vem da conta do proprio usuario, em cada plataforma.
        </p>
        <p className="tiny dim">
          Mercados sem conexao compativel: {MARKETS.filter((m) =>
            snapshot.brokerCatalog.every(
              (b: any) => !b.markets.includes(m) || b.status !== 'CONNECTED',
            ),
          ).map((m) => MARKET_LABEL[m]).join(', ') || 'nenhum — os dois tem conta simulada disponivel'}.
        </p>
      </Card>
    </div>
  );
}
