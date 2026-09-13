import { useEffect, useState } from 'react';
import { api, type Meta, type Snapshot } from '../api.ts';
import { Badge, Card, Empty, SIDE_LABEL, clock } from '../components/ui.tsx';

const STATUS_TONE: Record<string, 'ok' | 'block' | 'watch' | 'risk' | 'neutral'> = {
  VALID: 'ok',
  AMBIGUOUS: 'block',
  INCOMPLETE: 'block',
  EXPIRED: 'neutral',
  CANCELLED: 'neutral',
  SUPERSEDED: 'neutral',
  DUPLICATE: 'neutral',
  REJECTED: 'risk',
};

export function Fontes({ snapshot, meta }: { snapshot: Snapshot; meta: Meta | null }) {
  const [generator, setGenerator] = useState<{ running: boolean; config: any } | null>(null);
  const [newSource, setNewSource] = useState({ name: '', kind: 'MANUAL', independenceGroupId: '' });
  const [manual, setManual] = useState({
    sourceId: 'src_manual',
    symbol: 'EURUSD',
    side: 'BUY',
    entryPrice: '',
    stopLoss: '',
    takeProfit: '',
    timeframeMinutes: '15',
    text: '',
  });
  const [feedback, setFeedback] = useState<string | null>(null);
  const [parsed, setParsed] = useState<any>(null);

  useEffect(() => {
    void api.generator().then(setGenerator).catch(() => setGenerator(null));
  }, [snapshot.now.slice(0, 16)]);

  const refreshGenerator = () => void api.generator().then(setGenerator);

  const submitManual = async (event: React.FormEvent) => {
    event.preventDefault();
    setFeedback(null);
    try {
      const result = await api.sendSignal({
        sourceId: manual.sourceId,
        text: manual.text || `${SIDE_LABEL[manual.side]} ${manual.symbol}`,
        symbol: manual.symbol,
        side: manual.side,
        timeframeMinutes: Number(manual.timeframeMinutes) || null,
        horizonMinutes: (Number(manual.timeframeMinutes) || 15) * 4,
        entryPrice: manual.entryPrice ? Number(manual.entryPrice) : null,
        stopLoss: manual.stopLoss ? Number(manual.stopLoss) : null,
        takeProfit: manual.takeProfit ? Number(manual.takeProfit) : null,
      });
      setFeedback(result.message);
    } catch (e) {
      setFeedback((e as Error).message);
    }
  };

  const webhookSource = snapshot.sources.find((s: any) => s.kind === 'WEBHOOK');

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <div className="eyebrow">Fontes</div>
          <h1>Cadastro, agrupamento e entrada de sinais</h1>
        </div>
      </header>

      <div className="notice small">
        <strong>Grupo de independencia.</strong> Fontes com o mesmo grupo contam como um voto so.
        Nomes diferentes nao provam origens diferentes: revendas e espelhos de canal precisam ser
        agrupados manualmente, senao a concordancia vira contagem artificial.
      </div>

      <Card title="Fontes cadastradas" tight>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Fonte</th>
                <th>Tipo</th>
                <th>Grupo de independencia</th>
                <th className="num">Peso</th>
                <th className="num">Recebidos</th>
                <th className="num">Validos</th>
                <th className="num">Recusados</th>
                <th>Ultimo sinal</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {snapshot.sources.map((source: any) => {
                const shared = snapshot.sources.filter(
                  (s: any) => s.independenceGroupId === source.independenceGroupId,
                ).length;
                return (
                  <tr key={source.id}>
                    <td>
                      <div style={{ fontWeight: 500 }}>{source.name}</div>
                      <div className="tiny dim num">{source.id}</div>
                      {source.notes && <div className="tiny dim">{source.notes}</div>}
                    </td>
                    <td className="small">{source.kind}</td>
                    <td>
                      <input
                        type="text"
                        value={source.independenceGroupId}
                        onChange={(e) =>
                          void api.patchSource(source.id, { independenceGroupId: e.target.value })
                        }
                        style={{ minWidth: 130 }}
                      />
                      {shared > 1 && (
                        <div className="tiny" style={{ color: 'var(--block)' }}>
                          compartilhado com {shared - 1} outra(s): vale 1 voto
                        </div>
                      )}
                    </td>
                    <td className="num">
                      <input
                        type="number"
                        step="0.1"
                        min="0"
                        value={source.weight}
                        onChange={(e) =>
                          void api.patchSource(source.id, { weight: Number(e.target.value) })
                        }
                        style={{ width: 64 }}
                      />
                    </td>
                    <td className="num">{source.stats.received}</td>
                    <td className="num">{source.stats.valid}</td>
                    <td className="num">{source.stats.rejected}</td>
                    <td className="small num">{clock(source.stats.lastSignalAt)}</td>
                    <td>
                      <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                        <button
                          className="btn btn-sm"
                          onClick={() => void api.patchSource(source.id, { enabled: !source.enabled })}
                        >
                          {source.enabled ? 'Desativar' : 'Ativar'}
                        </button>
                        <button className="btn btn-sm" onClick={() => void api.deleteSource(source.id)}>
                          Remover
                        </button>
                      </div>
                      <div style={{ marginTop: 4 }}>
                        <Badge tone={source.enabled ? 'ok' : 'neutral'}>
                          {source.enabled ? 'ativa' : 'inativa'}
                        </Badge>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid grid-2">
        <Card title="Cadastrar fonte">
          <form
            className="stack-sm"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!newSource.name.trim()) return;
              await api.addSource(newSource);
              setNewSource({ name: '', kind: 'MANUAL', independenceGroupId: '' });
            }}
          >
            <label className="field">
              <span className="eyebrow">Nome</span>
              <input
                type="text"
                value={newSource.name}
                onChange={(e) => setNewSource({ ...newSource, name: e.target.value })}
                placeholder="Nome da sala ou provedor"
              />
            </label>
            <label className="field">
              <span className="eyebrow">Tipo de conector</span>
              <select
                value={newSource.kind}
                onChange={(e) => setNewSource({ ...newSource, kind: e.target.value })}
              >
                <option value="MANUAL">Entrada manual</option>
                <option value="GENERATOR">Gerador do prototipo</option>
                <option value="WEBHOOK">Webhook</option>
                <option value="TELEGRAM">Telegram (nao implementado)</option>
                <option value="DISCORD">Discord (nao implementado)</option>
                <option value="API">API (nao implementado)</option>
              </select>
            </label>
            <label className="field">
              <span className="eyebrow">Grupo de independencia</span>
              <input
                type="text"
                value={newSource.independenceGroupId}
                onChange={(e) => setNewSource({ ...newSource, independenceGroupId: e.target.value })}
                placeholder="deixe vazio para tratar como origem independente"
              />
            </label>
            <p className="tiny dim">
              Telegram, Discord e APIs de terceiros aparecem como opcao de cadastro, porem sem
              conector implementado: sinais dessas fontes precisam entrar por webhook ou manualmente
              ate a integracao existir.
            </p>
            <button className="btn btn-primary" type="submit">
              Cadastrar fonte
            </button>
          </form>
        </Card>

        <Card title="Entrada manual de sinal">
          <form className="stack-sm" onSubmit={submitManual}>
            <div className="row">
              <label className="field" style={{ flex: 1 }}>
                <span className="eyebrow">Fonte</span>
                <select
                  value={manual.sourceId}
                  onChange={(e) => setManual({ ...manual, sourceId: e.target.value })}
                >
                  {snapshot.sources.map((s: any) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field" style={{ flex: 1 }}>
                <span className="eyebrow">Ativo</span>
                <select
                  value={manual.symbol}
                  onChange={(e) => setManual({ ...manual, symbol: e.target.value })}
                >
                  {(meta?.instruments ?? []).map((i: any) => (
                    <option key={i.symbol} value={i.symbol}>
                      {i.symbol} {i.venue === 'OTC' ? '(OTC)' : ''}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="row">
              <label className="field" style={{ flex: 1 }}>
                <span className="eyebrow">Direcao</span>
                <select value={manual.side} onChange={(e) => setManual({ ...manual, side: e.target.value })}>
                  <option value="BUY">Compra</option>
                  <option value="SELL">Venda</option>
                </select>
              </label>
              <label className="field" style={{ flex: 1 }}>
                <span className="eyebrow">Timeframe (min)</span>
                <input
                  type="number"
                  value={manual.timeframeMinutes}
                  onChange={(e) => setManual({ ...manual, timeframeMinutes: e.target.value })}
                />
              </label>
            </div>
            <div className="row">
              <label className="field" style={{ flex: 1 }}>
                <span className="eyebrow">Entrada</span>
                <input
                  type="number"
                  step="0.00001"
                  value={manual.entryPrice}
                  onChange={(e) => setManual({ ...manual, entryPrice: e.target.value })}
                  placeholder="vazio = a mercado"
                />
              </label>
              <label className="field" style={{ flex: 1 }}>
                <span className="eyebrow">Stop</span>
                <input
                  type="number"
                  step="0.00001"
                  value={manual.stopLoss}
                  onChange={(e) => setManual({ ...manual, stopLoss: e.target.value })}
                />
              </label>
              <label className="field" style={{ flex: 1 }}>
                <span className="eyebrow">Alvo</span>
                <input
                  type="number"
                  step="0.00001"
                  value={manual.takeProfit}
                  onChange={(e) => setManual({ ...manual, takeProfit: e.target.value })}
                />
              </label>
            </div>
            <label className="field">
              <span className="eyebrow">Mensagem original</span>
              <textarea
                value={manual.text}
                onChange={(e) => setManual({ ...manual, text: e.target.value })}
                placeholder="Cole aqui a mensagem como ela chegou. Ela e preservada sem alteracao."
              />
            </label>
            <div className="row">
              <button className="btn btn-primary" type="submit">
                Registrar sinal
              </button>
              <button
                className="btn"
                type="button"
                onClick={async () => setParsed(await api.parse(manual.text))}
                disabled={!manual.text}
              >
                Testar leitura do texto
              </button>
            </div>
            {parsed && (
              <div className="notice small">
                <div>
                  Confianca da leitura: <span className="num">{parsed.confidence}</span> ·{' '}
                  direcao {parsed.side ?? 'nao identificada'} · ativo {parsed.symbol ?? 'nao identificado'}
                </div>
                {parsed.notes.map((n: string) => (
                  <div key={n} className="dim">
                    {n}
                  </div>
                ))}
                <div className="dim">
                  Leitura de texto livre so vira voto depois de passar pela validacao deterministica.
                </div>
              </div>
            )}
            {feedback && <div className="notice small">{feedback}</div>}
          </form>
        </Card>
      </div>

      <div className="grid grid-2">
        <Card
          title="Gerador de sinais"
          aside={<Badge tone={generator?.running ? 'ok' : 'neutral'}>{generator?.running ? 'rodando' : 'parado'}</Badge>}
        >
          <p className="small muted">
            Cria mensagens sinteticas nas fontes do tipo Gerador, para exercitar o motor. Nao imita o
            comportamento estatistico de nenhum provedor real.
          </p>
          <div className="row" style={{ marginTop: 10 }}>
            <button
              className="btn"
              onClick={async () => {
                await (generator?.running ? api.generatorStop() : api.generatorStart());
                refreshGenerator();
              }}
            >
              {generator?.running ? 'Parar gerador' : 'Iniciar gerador'}
            </button>
            <button className="btn" onClick={() => void api.generatorRound()}>
              Gerar uma rodada agora
            </button>
          </div>
          {generator && (
            <dl className="param-note small" style={{ marginTop: 12 }}>
              <dt>Intervalo</dt>
              <dd>{generator.config.intervalSeconds} s entre rodadas</dd>
              <dt>Concordancia</dt>
              <dd>{Math.round(generator.config.agreementProbability * 100)}% das rodadas tentam concordar</dd>
              <dt>Divergencia</dt>
              <dd>{Math.round(generator.config.dissentProbability * 100)}% de chance de uma fonte discordar</dd>
            </dl>
          )}
        </Card>

        <Card title="Webhook">
          {webhookSource ? (
            <div className="stack-sm">
              <p className="small muted">
                Envie um POST com a mensagem da sala. Aceita texto livre ou campos ja normalizados.
              </p>
              <pre
                className="num tiny"
                style={{
                  background: 'var(--surface-sunken)',
                  padding: 10,
                  borderRadius: 4,
                  overflowX: 'auto',
                  margin: 0,
                }}
              >{`POST /api/webhook/${webhookSource.webhookToken}
{
  "id": "1234",
  "text": "COMPRA EURUSD M15 entrada: 1.0850 SL: 1.0830 TP: 1.0880"
}`}</pre>
              <p className="tiny dim">
                O token identifica a fonte. Em producao ele fica no backend, com rotacao e
                verificacao de assinatura; nunca no frontend nem em log.
              </p>
            </div>
          ) : (
            <Empty>Nenhuma fonte do tipo webhook cadastrada.</Empty>
          )}
        </Card>
      </div>

      <Card title="Sinais recebidos" tight>
        {snapshot.signals.length === 0 ? (
          <Empty>Nenhum sinal recebido ainda.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Recebido</th>
                  <th>Fonte</th>
                  <th>Ativo</th>
                  <th>Direcao</th>
                  <th className="num">Entrada</th>
                  <th>Situacao</th>
                  <th>Mensagem original</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.signals.slice(0, 40).map((signal: any) => (
                  <tr key={signal.id}>
                    <td className="num small">{clock(signal.receivedAt)}</td>
                    <td className="small">
                      {snapshot.sources.find((s: any) => s.id === signal.sourceId)?.name ?? signal.sourceId}
                    </td>
                    <td className="num">
                      {signal.symbol}
                      {signal.venue === 'OTC' && <Badge tone="risk">OTC</Badge>}
                    </td>
                    <td>
                      {signal.side ? (
                        <Badge tone={signal.side === 'BUY' ? 'long' : 'short'}>{SIDE_LABEL[signal.side]}</Badge>
                      ) : (
                        <span className="dim">—</span>
                      )}
                    </td>
                    <td className="num">{signal.entryPrice ?? 'mercado'}</td>
                    <td>
                      <Badge tone={STATUS_TONE[signal.status] ?? 'neutral'}>{signal.status}</Badge>
                      {signal.version > 1 && <span className="tiny dim num"> v{signal.version}</span>}
                      {signal.issues.length > 0 && (
                        <div className="tiny dim">{signal.issues.map((i: any) => i.message).join(' ')}</div>
                      )}
                    </td>
                    <td className="tiny dim" style={{ maxWidth: 260 }}>
                      {signal.raw.text}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
