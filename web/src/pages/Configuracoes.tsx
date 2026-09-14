import { useEffect, useState } from 'react';
import {
  MARKETS,
  MARKET_LABEL,
  api,
  type MarketId,
  type MarketSlice,
  type Meta,
  type Snapshot,
} from '../api.ts';
import { Badge, Card, Empty, MarketChip } from '../components/ui.tsx';

const BASIS_LABEL: Record<string, { label: string; tone: 'watch' | 'neutral' | 'block' | 'ok' }> = {
  PADRAO_INICIAL_SIMULACAO: { label: 'padrao inicial para simulacao', tone: 'watch' },
  LIMITE_TECNICO: { label: 'restricao tecnica', tone: 'neutral' },
  NAO_SE_APLICA: { label: 'nao se aplica', tone: 'neutral' },
  PREENCHIMENTO_DO_USUARIO: { label: 'preenchimento do usuario', tone: 'block' },
};

const GROUP_TITLE: Record<string, string> = {
  operacao: 'Operacao',
  convergencia: 'Convergencia',
  risco: 'Risco',
  execucao: 'Execucao',
  global: 'Limites globais',
};

export function Configuracoes({
  snapshot,
  market,
  meta,
}: {
  snapshot: Snapshot;
  market: MarketSlice;
  meta: Meta | null;
}) {
  const marketId = market.marketId;
  const [scenarioNote, setScenarioNote] = useState<string | null>(null);

  if (!meta) {
    return (
      <div className="page">
        <Empty>Carregando descritores de configuracao...</Empty>
      </div>
    );
  }

  const valueOf = (key: string, scope: 'MARKET' | 'GLOBAL'): any => {
    if (scope === 'GLOBAL') return snapshot.globalRisk[key];
    if (key === 'mode') return market.mode;
    if (key === 'automationEnabled') return market.automationEnabled;
    if (key in market.convergenceSettings) return market.convergenceSettings[key];
    if (key in market.riskSettings) return market.riskSettings[key];
    return undefined;
  };

  const save = (key: string, scope: 'MARKET' | 'GLOBAL', value: any) => {
    if (scope === 'GLOBAL') return void api.saveGlobalRisk({ [key]: value });
    if (key === 'mode') return void api.setMode(marketId, value);
    if (key === 'automationEnabled') return void api.setAutomation(marketId, Boolean(value));
    if (key in market.convergenceSettings) return void api.saveConvergence(marketId, { [key]: value });
    if (key in market.riskSettings) return void api.saveRisk(marketId, { [key]: value });
  };

  const suggestedOf = (descriptor: any) =>
    descriptor.scope === 'GLOBAL' ? descriptor.suggested : descriptor.suggestedByMarket?.[marketId];

  const basisOf = (descriptor: any) =>
    descriptor.basisByMarket?.[marketId] ?? descriptor.basis;

  const groups = ['operacao', 'convergencia', 'risco', 'execucao', 'global'] as const;
  const scenarios = meta.scenarios.filter((s) => s.marketId === marketId || s.marketId === null);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <div className="eyebrow">Configuracoes · {MARKET_LABEL[marketId]}</div>
          <h1>Parametros, sugestoes e efeitos</h1>
        </div>
        <div className="row">
          <MarketChip marketId={marketId} />
          <button className="btn" onClick={() => void api.resetMarketSettings(marketId)}>
            Restaurar sugestoes de {MARKET_LABEL[marketId]}
          </button>
        </div>
      </header>

      <div className="notice notice-warn small">
        <strong>Os valores sugeridos sao pontos de partida para simulacao.</strong> Nao foram
        validados com dados historicos e nao ha evidencia de rentabilidade associada a eles.{' '}
        <strong>Forex e Cripto tem configuracoes independentes</strong> e nada e copiado
        automaticamente de um mercado para o outro: onde os padroes diferem, o motivo esta declarado
        no campo. Nenhuma configuracao muda sem acao sua.
      </div>

      {groups.map((group) => {
        const items = meta.descriptors.filter((d: any) => d.group === group);
        if (items.length === 0) return null;
        const isGlobal = group === 'global';
        return (
          <Card
            key={group}
            title={
              <span className="row" style={{ gap: 8 }}>
                {GROUP_TITLE[group]}
                {isGlobal ? (
                  <Badge tone="watch">vale para os dois mercados</Badge>
                ) : (
                  <MarketChip marketId={marketId} />
                )}
              </span>
            }
            aside={
              isGlobal ? (
                <button className="btn btn-sm" onClick={() => void api.resetGlobalRisk()}>
                  Restaurar globais
                </button>
              ) : group !== 'operacao' ? (
                <button className="btn btn-sm" onClick={() => void api.resetMarketSettings(marketId, group)}>
                  Restaurar grupo
                </button>
              ) : undefined
            }
          >
            {items.map((descriptor: any) => {
              const current = valueOf(descriptor.key, descriptor.scope);
              const suggested = suggestedOf(descriptor);
              const isSuggested = JSON.stringify(current) === JSON.stringify(suggested);
              const basis = BASIS_LABEL[basisOf(descriptor)] ?? BASIS_LABEL.PADRAO_INICIAL_SIMULACAO!;
              const note = descriptor.marketNotes?.[marketId];
              const otherSuggestion =
                descriptor.scope === 'MARKET'
                  ? descriptor.suggestedByMarket?.[marketId === 'FOREX' ? 'CRYPTO' : 'FOREX']
                  : undefined;
              const differs =
                otherSuggestion !== undefined &&
                JSON.stringify(otherSuggestion) !== JSON.stringify(suggested);

              return (
                <div key={`${descriptor.scope}:${descriptor.key}`} className="param">
                  <div className="param-meta">
                    <div className="row" style={{ gap: 8 }}>
                      <strong>{descriptor.label}</strong>
                      <Badge tone={basis.tone}>{basis.label}</Badge>
                      {!isSuggested && <Badge tone="block">alterado</Badge>}
                      {differs && <Badge tone="neutral">difere do outro mercado</Badge>}
                    </div>
                    <dl className="param-note small">
                      <dt>O que e</dt>
                      <dd>{descriptor.explanation}</dd>
                      <dt>Efeito</dt>
                      <dd>{descriptor.effect}</dd>
                      <dt>Depende de</dt>
                      <dd>{descriptor.dependencies}</dd>
                      {note && (
                        <>
                          <dt>{MARKET_LABEL[marketId]}</dt>
                          <dd>{note}</dd>
                        </>
                      )}
                      <dt>Sugerido</dt>
                      <dd className="num">
                        {typeof suggested === 'object' ? JSON.stringify(suggested) : String(suggested)}
                        {descriptor.unit ? ` ${descriptor.unit}` : ''}
                        {differs && (
                          <span className="dim">
                            {' '}
                            · em {MARKET_LABEL[marketId === 'FOREX' ? 'CRYPTO' : 'FOREX']}:{' '}
                            {typeof otherSuggestion === 'object'
                              ? JSON.stringify(otherSuggestion)
                              : String(otherSuggestion)}
                          </span>
                        )}
                      </dd>
                    </dl>
                  </div>

                  <div className="param-control">
                    <Control
                      descriptor={descriptor}
                      value={current}
                      onChange={(v) => save(descriptor.key, descriptor.scope, v)}
                    />
                    <button
                      className="btn btn-sm"
                      disabled={isSuggested}
                      onClick={() => save(descriptor.key, descriptor.scope, suggested)}
                    >
                      Restaurar sugestao
                    </button>
                  </div>
                </div>
              );
            })}
          </Card>
        );
      })}

      <Card
        title={
          <span className="row" style={{ gap: 8 }}>
            Fontes incluidas na convergencia <MarketChip marketId={marketId} />
          </span>
        }
      >
        <p className="small muted">
          Somente fontes cadastradas para {MARKET_LABEL[marketId]} aparecem aqui. Fontes excluidas
          continuam recebendo sinais e aparecem no historico, porem nao votam nem entram no
          denominador deste mercado.
        </p>
        <div className="stack-sm" style={{ marginTop: 10 }}>
          {market.sources.map((source: any) => {
            const excluded = market.convergenceSettings.excludedSourceIds.includes(source.id);
            return (
              <label key={source.id} className="row" style={{ gap: 8 }}>
                <input
                  type="checkbox"
                  style={{ width: 'auto' }}
                  checked={!excluded}
                  onChange={(e) => {
                    const next = e.target.checked
                      ? market.convergenceSettings.excludedSourceIds.filter(
                          (id: string) => id !== source.id,
                        )
                      : [...market.convergenceSettings.excludedSourceIds, source.id];
                    void api.saveConvergence(marketId, { excludedSourceIds: next });
                  }}
                />
                <span>{source.name}</span>
                <span className="tiny dim num">grupo {source.independenceGroupId}</span>
                {excluded && <Badge tone="block">excluida</Badge>}
              </label>
            );
          })}
          {market.sources.length === 0 && (
            <Empty>Nenhuma fonte cadastrada para {MARKET_LABEL[marketId]}.</Empty>
          )}
        </div>
      </Card>

      <Card
        title={
          <span className="row" style={{ gap: 8 }}>
            Instrumentos permitidos <MarketChip marketId={marketId} />
          </span>
        }
      >
        <p className="small muted">
          Instrumentos fora da lista nao formam agrupamento neste mercado. Sem nenhum marcado, todos
          os instrumentos do mercado sao aceitos.
        </p>
        <div className="row" style={{ marginTop: 10, gap: 14 }}>
          {market.instruments.map((instrument: any) => {
            const allowed = market.convergenceSettings.allowedSymbols;
            const checked = allowed == null || allowed.includes(instrument.symbol);
            return (
              <label key={instrument.symbol} className="row" style={{ gap: 5 }}>
                <input
                  type="checkbox"
                  style={{ width: 'auto' }}
                  checked={checked}
                  onChange={(e) => {
                    const all = market.instruments.map((i: any) => i.symbol);
                    const base = allowed == null ? all : allowed;
                    const next = e.target.checked
                      ? [...new Set([...base, instrument.symbol])]
                      : base.filter((s: string) => s !== instrument.symbol);
                    void api.saveConvergence(marketId, {
                      allowedSymbols: next.length === all.length ? null : next,
                    });
                  }}
                />
                <span className="num small">{instrument.symbol}</span>
              </label>
            );
          })}
        </div>
      </Card>

      <Card
        title={
          <span className="row" style={{ gap: 8 }}>
            Horarios permitidos <MarketChip marketId={marketId} />
          </span>
        }
      >
        <div className="stack-sm">
          {market.riskSettings.tradingWindows.map((window: any, index: number) => (
            <div className="row" key={index}>
              <label className="field">
                <span className="eyebrow">Inicio</span>
                <input
                  type="text"
                  value={window.start}
                  onChange={(e) => {
                    const next = [...market.riskSettings.tradingWindows];
                    next[index] = { ...window, start: e.target.value };
                    void api.saveRisk(marketId, { tradingWindows: next });
                  }}
                  style={{ width: 90 }}
                />
              </label>
              <label className="field">
                <span className="eyebrow">Fim</span>
                <input
                  type="text"
                  value={window.end}
                  onChange={(e) => {
                    const next = [...market.riskSettings.tradingWindows];
                    next[index] = { ...window, end: e.target.value };
                    void api.saveRisk(marketId, { tradingWindows: next });
                  }}
                  style={{ width: 90 }}
                />
              </label>
              <span className="small dim">
                interpretado em {market.riskSettings.tradingTimezone}
              </span>
            </div>
          ))}
          <div className="row">
            <span className="eyebrow">Dias</span>
            {['seg', 'ter', 'qua', 'qui', 'sex', 'sab', 'dom'].map((label, index) => {
              const day = index + 1;
              const active = market.riskSettings.tradingDays.includes(day);
              return (
                <label key={label} className="row" style={{ gap: 4 }}>
                  <input
                    type="checkbox"
                    style={{ width: 'auto' }}
                    checked={active}
                    onChange={(e) => {
                      const next = e.target.checked
                        ? [...market.riskSettings.tradingDays, day].sort()
                        : market.riskSettings.tradingDays.filter((d: number) => d !== day);
                      void api.saveRisk(marketId, { tradingDays: next });
                    }}
                  />
                  <span>{label}</span>
                </label>
              );
            })}
          </div>
          <p className="tiny dim">
            {marketId === 'FOREX'
              ? 'Forex spot nao negocia sabado e domingo. Marcar o fim de semana nao gera negocios.'
              : 'Cripto negocia todos os dias, 24 horas.'}
          </p>
        </div>
      </Card>

      <Card title="Comparativo rapido entre os mercados">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Parametro</th>
                {MARKETS.map((id) => (
                  <th key={id}>{MARKET_LABEL[id]}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[
                ['Modo', (m: MarketId) => snapshot.markets[m].mode],
                ['Automacao', (m: MarketId) => (snapshot.markets[m].automationEnabled ? 'ligada' : 'desligada')],
                ['Minimo de fontes', (m: MarketId) => snapshot.markets[m].convergenceSettings.minAgreeingSources],
                ['Concordancia minima', (m: MarketId) => `${snapshot.markets[m].convergenceSettings.minAgreementPercent}%`],
                ['Janela', (m: MarketId) => `${snapshot.markets[m].convergenceSettings.groupingWindowMinutes} min`],
                ['Tolerancia de entrada', (m: MarketId) => `${snapshot.markets[m].convergenceSettings.entryTolerancePips} pips`],
                ['Risco por operacao', (m: MarketId) => `${snapshot.markets[m].riskSettings.riskPercentPerTrade}%`],
                ['Stop padrao', (m: MarketId) => `${snapshot.markets[m].riskSettings.defaultStopPips} pips`],
                ['Maximo aberto', (m: MarketId) => snapshot.markets[m].riskSettings.maxOpenPositions],
                ['Conta', (m: MarketId) => snapshot.markets[m].account.brokerName],
              ].map(([label, get]) => (
                <tr key={label as string}>
                  <td className="small">{label as string}</td>
                  {MARKETS.map((id) => (
                    <td key={id} className="num small">
                      {String((get as (m: MarketId) => unknown)(id))}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Persistencia snapshot={snapshot} />

      <Card title="Cenarios de demonstracao">
        <p className="small muted">
          Cada cenario exercita um caminho do fluxo e deixa o rastro no historico de decisoes.
          Mostrando os de {MARKET_LABEL[marketId]} e os que cobrem os dois mercados.
        </p>
        <div className="stack-sm" style={{ marginTop: 10 }}>
          {scenarios.map((scenario) => (
            <div key={scenario.key} className="row" style={{ justifyContent: 'space-between', gap: 12 }}>
              <div style={{ flex: 1, minWidth: 240 }}>
                <div className="row" style={{ gap: 6 }}>
                  <strong className="small">{scenario.name}</strong>
                  {scenario.marketId ? (
                    <MarketChip marketId={scenario.marketId} />
                  ) : (
                    <Badge tone="watch">dois mercados</Badge>
                  )}
                </div>
                <div className="small muted">{scenario.description}</div>
                <div className="tiny dim">Esperado: {scenario.expected}</div>
              </div>
              <button
                className="btn btn-sm"
                onClick={async () => {
                  const result = await api.runScenario(scenario.key);
                  setScenarioNote(`${scenario.name}: ${result.expected}`);
                }}
              >
                Rodar
              </button>
            </div>
          ))}
        </div>
        {scenarioNote && (
          <div className="notice small" style={{ marginTop: 12 }}>
            {scenarioNote}
          </div>
        )}
      </Card>
    </div>
  );
}

const TABLE_LABEL: Record<string, string> = {
  sources: 'fontes',
  signals: 'sinais',
  opportunities: 'oportunidades',
  orders: 'ordens',
  positions: 'posicoes',
  events: 'eventos',
};

function Persistencia({ snapshot }: { snapshot: Snapshot }) {
  const [info, setInfo] = useState<any>(null);
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    void api.db().then(setInfo).catch(() => setInfo(null));
  }, [snapshot.now.slice(0, 16)]);

  if (!snapshot.persistence.enabled) {
    return (
      <Card title="Persistencia">
        <p className="small muted">
          Este backend esta rodando sem banco. O estado vive apenas em memoria e some ao reiniciar.
        </p>
      </Card>
    );
  }

  return (
    <Card title="Persistencia" aside={<Badge tone="ok">SQLite</Badge>}>
      <p className="small muted">
        Fontes, sinais, oportunidades, ordens, posicoes, eventos e as configuracoes dos dois mercados
        ficam gravados em disco, cada registro carimbado com o mercado. Reiniciar o backend retoma de
        onde parou.
      </p>

      <dl className="param-note small" style={{ marginTop: 10 }}>
        <dt>Arquivo</dt>
        <dd className="num">{snapshot.persistence.path}</dd>
        <dt>Esquema</dt>
        <dd className="num">versao {info?.schemaVersion ?? '—'}</dd>
        <dt>Registros</dt>
        <dd className="num">
          {info?.counts
            ? Object.entries(info.counts)
                .map(([table, n]) => `${n} ${TABLE_LABEL[table] ?? table}`)
                .join(' · ')
            : '—'}
        </dd>
        {info?.countsByMarket && (
          <>
            <dt>Por mercado</dt>
            <dd className="num">
              {Object.entries(info.countsByMarket)
                .map(
                  ([table, byMarket]) =>
                    `${TABLE_LABEL[table] ?? table}: ${Object.entries(byMarket as Record<string, number>)
                      .map(([m, n]) => `${m} ${n}`)
                      .join(', ') || 'vazio'}`,
                )
                .join(' · ')}
            </dd>
          </>
        )}
        {info?.lastMigration && (
          <>
            <dt>Migracao</dt>
            <dd>
              v{info.lastMigration.fromVersion} para v{info.lastMigration.toVersion}:{' '}
              {info.lastMigration.sourcesMigrated} fonte(s), {info.lastMigration.signalsMigrated}{' '}
              sinal(is).
              {info.lastMigration.sourcesNeedingClassification.length > 0 && (
                <>
                  {' '}
                  Precisam de classificacao:{' '}
                  {info.lastMigration.sourcesNeedingClassification.join(', ')}.
                </>
              )}
            </dd>
          </>
        )}
      </dl>

      <div className="notice notice-risk small" style={{ marginTop: 12 }}>
        <strong>Apagar o banco e irreversivel.</strong> Remove o historico dos dois mercados e
        devolve todas as configuracoes aos valores sugeridos.
      </div>

      <div className="row" style={{ marginTop: 10 }}>
        {confirming ? (
          <>
            <button
              className="btn btn-danger btn-sm"
              onClick={async () => {
                try {
                  await api.resetDb();
                  setNote('Banco apagado. Ambiente de demonstracao semeado de novo.');
                } catch (e) {
                  setNote((e as Error).message);
                } finally {
                  setConfirming(false);
                  void api.db().then(setInfo).catch(() => undefined);
                }
              }}
            >
              Confirmar: apagar tudo
            </button>
            <button className="btn btn-sm" onClick={() => setConfirming(false)}>
              Cancelar
            </button>
          </>
        ) : (
          <button className="btn btn-sm" onClick={() => setConfirming(true)}>
            Apagar banco e recomecar
          </button>
        )}
      </div>
      {note && (
        <div className="notice small" style={{ marginTop: 10 }}>
          {note}
        </div>
      )}
    </Card>
  );
}

function Control({
  descriptor,
  value,
  onChange,
}: {
  descriptor: any;
  value: any;
  onChange: (value: any) => void;
}) {
  if (descriptor.kind === 'boolean') {
    return (
      <div className="seg">
        <button aria-pressed={value === true} onClick={() => onChange(true)}>
          Ligado
        </button>
        <button aria-pressed={value === false} onClick={() => onChange(false)}>
          Desligado
        </button>
      </div>
    );
  }

  if (descriptor.kind === 'enum') {
    return (
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
        {(descriptor.options ?? []).map((option: any) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }

  if (descriptor.kind === 'list') {
    return <p className="tiny dim">Editado nos blocos especificos abaixo desta pagina.</p>;
  }

  if (descriptor.kind === 'secret') {
    return <input type="text" value="" placeholder="preenchido pelo usuario" readOnly />;
  }

  return (
    <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
      <input
        type="number"
        value={value ?? ''}
        min={descriptor.min}
        max={descriptor.max}
        step={descriptor.step ?? 1}
        onChange={(e) => {
          const next = Number(e.target.value);
          if (Number.isFinite(next)) onChange(next);
        }}
      />
      {descriptor.unit && (
        <span className="tiny dim" style={{ whiteSpace: 'nowrap' }}>
          {descriptor.unit}
        </span>
      )}
    </div>
  );
}
