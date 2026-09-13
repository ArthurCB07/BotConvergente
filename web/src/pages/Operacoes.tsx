import { api, type Snapshot } from '../api.ts';
import { Badge, Card, Empty, SIDE_LABEL, clock, dateTime, money, signed } from '../components/ui.tsx';

const ORDER_TONE: Record<string, 'ok' | 'block' | 'watch' | 'risk' | 'neutral'> = {
  FILLED: 'ok',
  SENT: 'watch',
  PENDING: 'watch',
  RECONCILED: 'watch',
  TIMEOUT: 'block',
  REJECTED: 'risk',
  CANCELLED: 'neutral',
};

export function Operacoes({ snapshot }: { snapshot: Snapshot }) {
  const closed = snapshot.positions.filter((p: any) => p.status === 'CLOSED');
  const totals = closed.reduce(
    (acc: any, p: any) => ({
      gross: acc.gross + p.grossPnl,
      costs: acc.costs + p.costs,
      net: acc.net + p.netPnl,
    }),
    { gross: 0, costs: 0, net: 0 },
  );

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <div className="eyebrow">Operacoes</div>
          <h1>Ordens, posicoes e historico</h1>
        </div>
        <Badge tone="watch">todas simuladas</Badge>
      </header>

      <div className="grid grid-4">
        <Card title="Resultado bruto">
          <div className={`figure ${totals.gross >= 0 ? 'gain' : 'loss'}`}>{signed(totals.gross)}</div>
          <p className="tiny dim">Antes de custos, sobre operacoes fechadas.</p>
        </Card>
        <Card title="Custos">
          <div className="figure">{money(totals.costs)}</div>
          <p className="tiny dim">Comissao simulada de USD 7 por lote, ida e volta.</p>
        </Card>
        <Card title="Resultado liquido">
          <div className={`figure ${totals.net >= 0 ? 'gain' : 'loss'}`}>{signed(totals.net)}</div>
          <p className="tiny dim">Bruto menos custos. O spread ja esta no preco de entrada.</p>
        </Card>
        <Card title="Operacoes">
          <div className="figure">{closed.length}</div>
          <p className="tiny dim">{snapshot.openPositions.length} aberta(s) agora.</p>
        </Card>
      </div>

      <Card title="Posicoes abertas" tight>
        {snapshot.openPositions.length === 0 ? (
          <Empty>Nenhuma posicao aberta.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Abertura</th>
                  <th>Ativo</th>
                  <th>Direcao</th>
                  <th className="num">Lotes</th>
                  <th className="num">Preco</th>
                  <th className="num">Stop</th>
                  <th className="num">Alvo</th>
                  <th className="num">Nocional</th>
                  <th className="num">Arriscado</th>
                  <th className="num">Aberto</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {snapshot.openPositions.map((p: any) => (
                  <tr key={p.id}>
                    <td className="num small">{clock(p.openedAt)}</td>
                    <td className="num">{p.symbol}</td>
                    <td>
                      <Badge tone={p.side === 'BUY' ? 'long' : 'short'}>{SIDE_LABEL[p.side]}</Badge>
                    </td>
                    <td className="num">{p.lots}</td>
                    <td className="num">{p.openPrice}</td>
                    <td className="num">{p.stopLoss ?? '—'}</td>
                    <td className="num">{p.takeProfit ?? '—'}</td>
                    <td className="num">{money(p.notionalValue)}</td>
                    <td className="num">{money(p.riskedValue)}</td>
                    <td className={`num ${p.netPnl >= 0 ? 'gain' : 'loss'}`}>{signed(p.netPnl)}</td>
                    <td>
                      <button className="btn btn-sm" onClick={() => void api.closePosition(p.id)}>
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

      <Card title="Ordens" tight>
        {snapshot.orders.length === 0 ? (
          <Empty>Nenhuma ordem enviada.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Enviada</th>
                  <th>Ativo</th>
                  <th>Direcao</th>
                  <th className="num">Lotes</th>
                  <th className="num">Preenchimento</th>
                  <th>Situacao</th>
                  <th>Chave de cliente</th>
                  <th>Observacao</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.orders.map((o: any) => (
                  <tr key={o.id}>
                    <td className="num small">{clock(o.createdAt)}</td>
                    <td className="num">{o.symbol}</td>
                    <td>
                      <Badge tone={o.side === 'BUY' ? 'long' : 'short'}>{SIDE_LABEL[o.side]}</Badge>
                    </td>
                    <td className="num">{o.lots}</td>
                    <td className="num">{o.filledPrice ?? '—'}</td>
                    <td>
                      <Badge tone={ORDER_TONE[o.status] ?? 'neutral'}>{o.status}</Badge>
                    </td>
                    <td className="tiny num dim">{o.clientOrderId}</td>
                    <td className="small dim">{o.message ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="tiny dim" style={{ padding: '10px 14px' }}>
          A chave de cliente e deterministica por oportunidade e tentativa. Se uma requisicao expira
          sem resposta, o sistema consulta o estado dessa chave antes de qualquer reenvio, para nao
          abrir posicao duplicada.
        </p>
      </Card>

      <Card title="Historico de operacoes" tight>
        {closed.length === 0 ? (
          <Empty>Nenhuma operacao encerrada.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Fechada</th>
                  <th>Ativo</th>
                  <th>Direcao</th>
                  <th className="num">Abertura</th>
                  <th className="num">Fechamento</th>
                  <th>Motivo</th>
                  <th className="num">Bruto</th>
                  <th className="num">Custos</th>
                  <th className="num">Liquido</th>
                </tr>
              </thead>
              <tbody>
                {[...closed].reverse().map((p: any) => (
                  <tr key={p.id}>
                    <td className="num small">{dateTime(p.closedAt)}</td>
                    <td className="num">{p.symbol}</td>
                    <td>
                      <Badge tone={p.side === 'BUY' ? 'long' : 'short'}>{SIDE_LABEL[p.side]}</Badge>
                    </td>
                    <td className="num">{p.openPrice}</td>
                    <td className="num">{p.closePrice}</td>
                    <td className="small">{p.closeReason}</td>
                    <td className={`num ${p.grossPnl >= 0 ? 'gain' : 'loss'}`}>{signed(p.grossPnl)}</td>
                    <td className="num">{money(p.costs)}</td>
                    <td className={`num ${p.netPnl >= 0 ? 'gain' : 'loss'}`}>{signed(p.netPnl)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Registro completo de decisoes" tight>
        <div className="log">
          {snapshot.events.map((event: any) => (
            <div key={event.id} className="log-row">
              <span className="log-time">{clock(event.at)}</span>
              <span className={`log-bar log-${event.severity}`} />
              <span>
                <span className="log-title">{event.title}</span>{' '}
                <span className="tiny dim num">{event.kind}</span>
                <br />
                <span className="log-detail small">{event.detail}</span>
              </span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
