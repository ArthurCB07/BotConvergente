import { useEffect, useState } from 'react';
import {
  MARKETS,
  MARKET_LABEL,
  api,
  type MarketId,
  type MarketSlice,
  type Meta,
  type Snapshot,
  type TelegramState,
} from '../api.ts';
import { Badge, Card, Empty, MarketChip, SIDE_LABEL, clock } from '../components/ui.tsx';
import { TelegramPanel } from '../components/TelegramPanel.tsx';

/** Como a origem entrega os sinais, em palavras. */
const KIND_LABEL: Record<string, string> = {
  TELEGRAM: 'Sala do Telegram',
  WEBHOOK: 'Webhook',
  MANUAL: 'Teste manual',
  GENERATOR: 'Gerador de teste',
  DISCORD: 'Discord',
  API: 'API',
};

const STATUS_TONE: Record<string, 'ok' | 'block' | 'watch' | 'risk' | 'neutral'> = {
  VALID: 'ok',
  AMBIGUOUS: 'block',
  INCOMPLETE: 'block',
  EXPIRED: 'neutral',
  CANCELLED: 'neutral',
  SUPERSEDED: 'neutral',
  DUPLICATE: 'neutral',
  REJECTED: 'risk',
  MARKET_MISMATCH: 'risk',
};

export function Fontes({
  snapshot,
  market,
  meta,
  telegram,
}: {
  snapshot: Snapshot;
  market: MarketSlice;
  meta: Meta | null;
  telegram: {
    telegram: TelegramState | null;
    error: string | null;
    needsToken: boolean;
    reload: () => void;
  };
}) {
  const marketId = market.marketId;
  const [generator, setGenerator] = useState<{ running: boolean; config: any } | null>(null);
  const [onlyThisMarket, setOnlyThisMarket] = useState(true);
  const [newSource, setNewSource] = useState<{
    name: string;
    kind: string;
    markets: MarketId[];
    independenceGroupId: string;
  }>({ name: '', kind: 'WEBHOOK', markets: [marketId], independenceGroupId: '' });
  const [manual, setManual] = useState({
    sourceId: 'src_manual',
    symbol: '',
    side: 'BUY',
    entryPrice: '',
    stopLoss: '',
    takeProfit: '',
    timeframeMinutes: '15',
    text: '',
  });
  const [feedback, setFeedback] = useState<string | null>(null);
  const [parsed, setParsed] = useState<any>(null);

  const instruments = meta?.instrumentsByMarket?.[marketId] ?? [];

  useEffect(() => {
    void api.generator().then(setGenerator).catch(() => setGenerator(null));
  }, [snapshot.now.slice(0, 16)]);

  useEffect(() => {
    setNewSource((s) => ({ ...s, markets: [marketId] }));
    setManual((m) => ({ ...m, symbol: instruments[0]?.symbol ?? '' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketId, instruments.length]);

  const refreshGenerator = () => void api.generator().then(setGenerator);

  const visibleSources = onlyThisMarket
    ? snapshot.sources.filter((s: any) => s.markets.includes(marketId))
    : snapshot.sources;

  const visibleSignals = onlyThisMarket
    ? market.signals
    : snapshot.markets.FOREX.signals.concat(snapshot.markets.CRYPTO.signals).sort(
        (a: any, b: any) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt),
      );

  const submitManual = async (event: React.FormEvent) => {
    event.preventDefault();
    setFeedback(null);
    try {
      const result = await api.sendSignal({
        sourceId: manual.sourceId,
        text: manual.text || `${SIDE_LABEL[manual.side]} ${manual.symbol}`,
        marketId,
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

  const toggleMarket = (source: any, id: MarketId) => {
    const next = source.markets.includes(id)
      ? source.markets.filter((m: MarketId) => m !== id)
      : [...source.markets, id];
    void api.patchSource(source.id, { markets: next });
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <div className="eyebrow">Fontes · {MARKET_LABEL[marketId]}</div>
          <h1>De onde vem os sinais</h1>
        </div>
        <label className="row small" style={{ gap: 6 }}>
          <input
            type="checkbox"
            style={{ width: 'auto' }}
            checked={onlyThisMarket}
            onChange={(e) => setOnlyThisMarket(e.target.checked)}
          />
          Mostrar apenas {MARKET_LABEL[marketId]}
        </label>
      </header>

      <div className="notice small">
        <strong>Os sinais chegam de fora.</strong> A plataforma le as salas e provedores que voce
        conectou, interpreta cada mensagem e compara o que e comparavel. Voce nao digita sinais aqui:
        conecte as salas no <strong>Telegram</strong> abaixo, ou aponte um provedor para o{' '}
        <strong>Webhook</strong>. O que voce cadastra nesta tela e a <strong>origem</strong> — quem
        fala — e nao o que ela disse.
      </div>

      <section className="stack" id="telegram">
        <div className="eyebrow">Telegram · MTProto (sua conta)</div>
        <TelegramPanel
          telegram={telegram.telegram}
          now={snapshot.now}
          needsToken={telegram.needsToken}
          error={telegram.error}
          reload={telegram.reload}
        />
      </section>

      <section className="stack">
        <div className="eyebrow">Webhook · provedores e integracoes proprias</div>
        <Card title="Endereco de recebimento">
          {webhookSource ? (
            <div className="stack-sm">
              <p className="small muted">
                Envie um POST com a mensagem da sala. O mercado sai do instrumento reconhecido.
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
  "text": "${marketId === 'FOREX' ? 'COMPRA EURUSD M15 entrada: 1.0850 SL: 1.0830 TP: 1.0880' : 'COMPRA BTCUSDT M15 entrada: 72500 SL: 71400 TP: 74300'}"
}`}</pre>
              <p className="tiny dim">
                Esta fonte atende: {webhookSource.markets.map((m: MarketId) => MARKET_LABEL[m]).join(' e ') || 'nenhum mercado'}.
                Um sinal de mercado nao cadastrado fica registrado com o aviso, fora da convergencia.
              </p>
            </div>
          ) : (
            <Empty>
              Nenhuma fonte do tipo webhook cadastrada. Crie uma em "Cadastrar fonte", escolhendo o
              tipo <strong>Webhook</strong>: o endereco de recebimento aparece aqui em seguida.
            </Empty>
          )}
        </Card>
      </section>

      <div className="notice small">
        <strong>Mercado da fonte.</strong> Uma fonte so vota nos mercados marcados. Uma sala que
        publica os dois fica cadastrada uma vez com os dois: cada sinal vai para o mercado do
        instrumento e a fonte vale um voto em cada mercado, nunca dois no mesmo.{' '}
        <strong>Grupo de independencia</strong> agrupa espelhos e revendas: nomes diferentes nao
        provam origens diferentes.
      </div>

      {snapshot.unclassifiedSources.length > 0 && (
        <div className="notice notice-warn small">
          <strong>Classificacao pendente.</strong>{' '}
          {snapshot.unclassifiedSources.map((s: any) => s.name).join(', ')} — sem mercado definido.
          Os registros foram preservados, porem nao votam ate voce marcar Forex, Cripto ou os dois.
        </div>
      )}

      <Card title="Fontes cadastradas" tight>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Fonte</th>
                <th>Tipo</th>
                <th>Mercados</th>
                <th>Grupo de independencia</th>
                <th className="num">Peso em {MARKET_LABEL[marketId]}</th>
                <th>Sinais</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visibleSources.map((source: any) => {
                const shared = snapshot.sources.filter(
                  (s: any) =>
                    s.independenceGroupId === source.independenceGroupId &&
                    s.markets.some((m: MarketId) => source.markets.includes(m)),
                ).length;
                return (
                  <tr key={source.id}>
                    <td>
                      <div style={{ fontWeight: 500 }}>{source.name}</div>
                      <div className="tiny dim num">{source.id}</div>
                      {source.notes && <div className="tiny dim">{source.notes}</div>}
                    </td>
                    <td className="small">{KIND_LABEL[source.kind] ?? source.kind}</td>
                    <td>
                      {/*
                       * Sala do Telegram tem um dono so: o painel acima. Editar o mercado
                       * em dois lugares diferentes e o caminho curto para estados divergentes.
                       */}
                      {source.kind === 'TELEGRAM' ? (
                        <div className="row" style={{ gap: 4 }}>
                          {source.markets.map((id: MarketId) => (
                            <MarketChip key={id} marketId={id} />
                          ))}
                          {source.markets.length === 0 && <Badge tone="risk">sem classificacao</Badge>}
                        </div>
                      ) : (
                        <>
                          <div className="row" style={{ gap: 6 }}>
                            {MARKETS.map((id) => (
                              <label key={id} className="row tiny" style={{ gap: 3 }}>
                                <input
                                  type="checkbox"
                                  style={{ width: 'auto' }}
                                  checked={source.markets.includes(id)}
                                  onChange={() => toggleMarket(source, id)}
                                />
                                {MARKET_LABEL[id]}
                              </label>
                            ))}
                          </div>
                          {source.markets.length === 0 && (
                            <Badge tone="risk">sem classificacao</Badge>
                          )}
                        </>
                      )}
                    </td>
                    <td>
                      {source.kind === 'TELEGRAM' ? (
                        <span className="tiny num dim">{source.independenceGroupId}</span>
                      ) : (
                        <input
                          type="text"
                          value={source.independenceGroupId}
                          onChange={(e) =>
                            void api.patchSource(source.id, { independenceGroupId: e.target.value })
                          }
                          style={{ minWidth: 120 }}
                        />
                      )}
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
                        value={source.weightByMarket?.[marketId] ?? 1}
                        onChange={(e) =>
                          void api.patchSource(source.id, {
                            weightByMarket: {
                              ...source.weightByMarket,
                              [marketId]: Number(e.target.value),
                            },
                          })
                        }
                        style={{ width: 64 }}
                      />
                    </td>
                    <td className="small">
                      <span className="num">{source.stats.valid}</span> validos de{' '}
                      <span className="num">{source.stats.received}</span> recebidos
                      {source.stats.rejected > 0 && (
                        <div className="tiny dim">
                          <span className="num">{source.stats.rejected}</span> recusado(s)
                        </div>
                      )}
                      <div className="tiny dim num">
                        {source.stats.lastSignalAt ? `ultimo ${clock(source.stats.lastSignalAt)}` : 'nenhum ainda'}
                      </div>
                    </td>
                    <td>
                      {source.kind === 'TELEGRAM' ? (
                        <a className="btn btn-sm" href="#telegram">
                          Gerenciar no Telegram
                        </a>
                      ) : (
                        <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                          <button
                            className="btn btn-sm"
                            onClick={() =>
                              void api.patchSource(source.id, { enabled: !source.enabled })
                            }
                          >
                            {source.enabled ? 'Desativar' : 'Ativar'}
                          </button>
                          <button
                            className="btn btn-sm"
                            onClick={() => void api.deleteSource(source.id)}
                          >
                            Remover
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Cadastrar fonte">
        <p className="small muted" style={{ marginBottom: 10 }}>
          Para salas do Telegram nao e preciso cadastrar nada aqui: ligar o monitoramento de uma sala
          ja cria a fonte correspondente. Este formulario serve para provedores que entregam por
          webhook ou por integracao propria.
        </p>
        <form
          className="stack-sm"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!newSource.name.trim()) return;
            await api.addSource(newSource);
            setNewSource({ name: '', kind: 'WEBHOOK', markets: [marketId], independenceGroupId: '' });
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
          <div className="field">
            <span className="eyebrow">Mercados desta fonte</span>
            <div className="row" style={{ gap: 12 }}>
              {MARKETS.map((id) => (
                <label key={id} className="row" style={{ gap: 5 }}>
                  <input
                    type="checkbox"
                    style={{ width: 'auto' }}
                    checked={newSource.markets.includes(id)}
                    onChange={(e) =>
                      setNewSource({
                        ...newSource,
                        markets: e.target.checked
                          ? [...newSource.markets, id]
                          : newSource.markets.filter((m) => m !== id),
                      })
                    }
                  />
                  {MARKET_LABEL[id]}
                </label>
              ))}
            </div>
            <p className="tiny dim">
              Marque os dois se a sala publica Forex e Cripto. Sem marcar nenhum, a fonte fica
              cadastrada porem sem voto ate ser classificada.
            </p>
          </div>
          <label className="field">
            <span className="eyebrow">Como ela entrega os sinais</span>
            <select
              value={newSource.kind}
              onChange={(e) => setNewSource({ ...newSource, kind: e.target.value })}
            >
              <option value="WEBHOOK">Webhook — o provedor faz POST no endereco gerado</option>
              <option value="MANUAL">Somente teste — sinais digitados a mao</option>
            </select>
            <span className="tiny dim">
              {newSource.kind === 'WEBHOOK'
                ? 'Ao cadastrar, o endereco de recebimento aparece na secao Webhook, acima.'
                : 'Nao recebe nada sozinha. Serve de destino para as ferramentas de teste do rodape.'}
            </span>
          </label>

          {/* Detalhe de convergencia, nao de cadastro: fica fora do caminho comum. */}
          <details>
            <summary className="small">Agrupamento avancado</summary>
            <label className="field" style={{ marginTop: 8 }}>
              <span className="eyebrow">Grupo de independencia</span>
              <input
                type="text"
                value={newSource.independenceGroupId}
                onChange={(e) => setNewSource({ ...newSource, independenceGroupId: e.target.value })}
                placeholder="deixe vazio para tratar como origem independente"
              />
              <span className="tiny dim">
                Use o mesmo valor em espelhos e revendas da mesma origem: elas passam a valer um voto
                so. Vazio = origem independente.
              </span>
            </label>
          </details>

          <button className="btn btn-primary" type="submit">
            Cadastrar fonte
          </button>
        </form>
      </Card>

      <Card
        title={onlyThisMarket ? `Sinais de ${MARKET_LABEL[marketId]}` : 'Sinais dos dois mercados'}
        tight
      >
        {visibleSignals.length === 0 ? (
          <Empty>Nenhum sinal recebido.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Recebido</th>
                  <th>Mercado</th>
                  <th>Fonte</th>
                  <th>Ativo</th>
                  <th>Direcao</th>
                  <th className="num">Entrada</th>
                  <th>Situacao</th>
                  <th>Mensagem original</th>
                </tr>
              </thead>
              <tbody>
                {visibleSignals.slice(0, 40).map((signal: any) => (
                  <tr key={signal.id}>
                    <td className="num small">{clock(signal.receivedAt)}</td>
                    <td>
                      <MarketChip marketId={signal.marketId} />
                    </td>
                    <td className="small">
                      {snapshot.sources.find((s: any) => s.id === signal.sourceId)?.name ?? signal.sourceId}
                    </td>
                    <td className="num">
                      {signal.symbol}
                      {signal.venue === 'OTC' && <Badge tone="risk">OTC</Badge>}
                    </td>
                    <td>
                      {signal.side ? (
                        <Badge tone={signal.side === 'BUY' ? 'long' : 'short'}>
                          {SIDE_LABEL[signal.side]}
                        </Badge>
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
                    <td className="tiny dim" style={{ maxWidth: 240 }}>
                      {signal.raw.text}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <section className="stack">
        <div className="eyebrow">Ferramentas de teste</div>
        <div className="notice notice-warn small">
          <strong>Isto nao e o funcionamento normal da plataforma.</strong> Servem para exercitar o
          leitor de mensagens e a convergencia sem esperar uma sala publicar. Um sinal injetado aqui
          entra pelo mesmo caminho de um sinal real e conta como voto da fonte escolhida — entao use
          fontes de teste, nao as suas salas de verdade.
        </div>
        <details>
          <summary className="small">Abrir ferramentas de teste</summary>
          <div className="grid grid-2" style={{ marginTop: 12 }}>
            <Card title={`Injetar sinal de teste em ${MARKET_LABEL[marketId]}`}>
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
                          {s.kind === 'TELEGRAM' ? ' — sala real do Telegram' : ''}
                          {s.markets.includes(marketId) ? '' : ` (nao atende ${MARKET_LABEL[marketId]})`}
                        </option>
                      ))}
                    </select>
                    {snapshot.sources.find((s: any) => s.id === manual.sourceId)?.kind ===
                      'TELEGRAM' && (
                      <span className="tiny dim">
                        Esta e uma sala real. O sinal injetado vira voto dela e fica misturado ao
                        historico verdadeiro. Prefira uma fonte de teste.
                      </span>
                    )}
                  </label>
                  <label className="field" style={{ flex: 1 }}>
                    <span className="eyebrow">Ativo</span>
                    <select
                      value={manual.symbol}
                      onChange={(e) => setManual({ ...manual, symbol: e.target.value })}
                    >
                      {instruments.map((i: any) => (
                        <option key={i.symbol} value={i.symbol}>
                          {i.symbol} {i.venue === 'OTC' ? '(OTC)' : ''}
                          {i.contractType === 'PERPETUAL' ? ' — perpetuo' : ''}
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
                      step="any"
                      value={manual.entryPrice}
                      onChange={(e) => setManual({ ...manual, entryPrice: e.target.value })}
                      placeholder="vazio = a mercado"
                    />
                  </label>
                  <label className="field" style={{ flex: 1 }}>
                    <span className="eyebrow">Stop</span>
                    <input
                      type="number"
                      step="any"
                      value={manual.stopLoss}
                      onChange={(e) => setManual({ ...manual, stopLoss: e.target.value })}
                    />
                  </label>
                  <label className="field" style={{ flex: 1 }}>
                    <span className="eyebrow">Alvo</span>
                    <input
                      type="number"
                      step="any"
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
                      Confianca: <span className="num">{parsed.confidence}</span> · direcao{' '}
                      {parsed.side ?? 'nao identificada'} · ativo {parsed.symbol ?? 'nao identificado'} ·
                      mercado {parsed.marketId ?? 'nao identificado'}
                    </div>
                    {parsed.notes.map((n: string) => (
                      <div key={n} className="dim">
                        {n}
                      </div>
                    ))}
                    <div className="dim">
                      O mercado sai do instrumento reconhecido, nunca do palpite de quem enviou.
                    </div>
                  </div>
                )}
                {feedback && <div className="notice small">{feedback}</div>}
              </form>
            </Card>

            <Card
              title="Gerador de sinais"
              aside={
                <Badge tone={generator?.running ? 'ok' : 'neutral'}>
                  {generator?.running ? 'rodando' : 'parado'}
                </Badge>
              }
            >
              <p className="small muted">
                Cria mensagens sinteticas nas fontes do tipo Gerador de cada mercado. Nao imita o
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
                <button className="btn" onClick={() => void api.generatorRound(marketId)}>
                  Rodada em {MARKET_LABEL[marketId]}
                </button>
                <button className="btn" onClick={() => void api.generatorRound()}>
                  Rodada nos dois
                </button>
              </div>
              {generator && (
                <dl className="param-note small" style={{ marginTop: 12 }}>
                  <dt>Intervalo</dt>
                  <dd>{generator.config.intervalSeconds} s entre rodadas</dd>
                  <dt>Mercados</dt>
                  <dd>{(generator.config.markets ?? []).join(', ')}</dd>
                  <dt>Concordancia</dt>
                  <dd>{Math.round(generator.config.agreementProbability * 100)}% das rodadas tentam concordar</dd>
                </dl>
              )}
            </Card>
          </div>
        </details>
      </section>

    </div>
  );
}
