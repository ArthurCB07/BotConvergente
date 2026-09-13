import { api, type Snapshot } from '../api.ts';
import { Badge, Card, money } from '../components/ui.tsx';

const STATUS: Record<string, { tone: 'ok' | 'block' | 'watch' | 'risk' | 'neutral'; label: string }> = {
  CONNECTED: { tone: 'ok', label: 'conectada' },
  DISCONNECTED: { tone: 'block', label: 'desconectada' },
  NOT_IMPLEMENTED: { tone: 'neutral', label: 'nao implementada' },
  ERROR: { tone: 'risk', label: 'erro' },
};

function Yes({ value }: { value: boolean }) {
  return <span style={{ color: value ? 'var(--ok)' : 'var(--ink-3)' }}>{value ? 'sim' : 'nao'}</span>;
}

export function Corretoras({ snapshot }: { snapshot: Snapshot }) {
  const account = snapshot.account;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <div className="eyebrow">Corretoras</div>
          <h1>Integracoes suportadas</h1>
        </div>
        <div className="row">
          <button className="btn" onClick={() => void api.setConnected(!account.connected)}>
            {account.connected ? 'Simular queda de conexao' : 'Restabelecer conexao'}
          </button>
          <select
            onChange={(e) => void api.setFailure(e.target.value)}
            defaultValue="NONE"
            style={{ width: 200 }}
          >
            <option value="NONE">Sem falha injetada</option>
            <option value="TIMEOUT">Timeout nas ordens</option>
            <option value="REJECT">Rejeicao nas ordens</option>
            <option value="DISCONNECTED">Desconectada</option>
          </select>
        </div>
      </header>

      <div className="notice small">
        <strong>Nenhuma conexao real esta ativa.</strong> O ambiente usa um simulador local. As
        integracoes abaixo estao descritas com base na documentacao oficial de cada plataforma e
        aparecem como nao implementadas ate que sejam efetivamente construidas e testadas em conta
        demonstrativa.
      </div>

      <Card title="Conta ativa">
        <div className="grid grid-4">
          <div>
            <div className="eyebrow">Tipo</div>
            <Badge tone="watch">{account.accountType}</Badge>
          </div>
          <div>
            <div className="eyebrow">Saldo</div>
            <div className="figure-sm">{money(account.balance)}</div>
          </div>
          <div>
            <div className="eyebrow">Patrimonio</div>
            <div className="figure-sm">{money(account.equity)}</div>
          </div>
          <div>
            <div className="eyebrow">Margem usada / livre</div>
            <div className="figure-sm">
              {money(account.usedMargin)} <span className="dim">/</span> {money(account.freeMargin)}
            </div>
          </div>
        </div>
      </Card>

      <Card title="Comparativo de integracoes" tight>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Plataforma</th>
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
                      <div className="tiny dim">{broker.markets.join(', ')}</div>
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
                    <td className="small" style={{ maxWidth: 260 }}>
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
        {snapshot.brokerCatalog.map((broker: any) => (
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
          Credenciais de corretora ficam no backend, cifradas em repouso, e nunca trafegam para o
          frontend nem aparecem em log. Consulta de conta e autorizacao de negociacao sao pedidas
          separadamente quando a plataforma permite, para que a conexao possa comecar somente com
          leitura.
        </p>
        <p className="small muted">
          Nenhum campo de credencial e preenchido automaticamente: login, servidor, client id e
          secret vem da propria corretora do usuario.
        </p>
      </Card>
    </div>
  );
}
