import { useEffect, useState } from 'react';
import { api, type Meta, type Snapshot } from '../api.ts';
import { Badge, Card, Empty } from '../components/ui.tsx';

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
  corretora: 'Corretora',
};

export function Configuracoes({ snapshot, meta }: { snapshot: Snapshot; meta: Meta | null }) {
  const [scenarioNote, setScenarioNote] = useState<string | null>(null);

  if (!meta) {
    return (
      <div className="page">
        <Empty>Carregando descritores de configuracao...</Empty>
      </div>
    );
  }

  const valueOf = (key: string): any => {
    if (key === 'mode') return snapshot.mode;
    if (key in snapshot.convergenceSettings) return snapshot.convergenceSettings[key];
    if (key in snapshot.riskSettings) return snapshot.riskSettings[key];
    return undefined;
  };

  const save = (key: string, value: any) => {
    if (key === 'mode') return void api.setMode(value);
    if (key in snapshot.convergenceSettings) return void api.saveConvergence({ [key]: value });
    if (key in snapshot.riskSettings) return void api.saveRisk({ [key]: value });
  };

  const groups = ['operacao', 'convergencia', 'risco', 'execucao'] as const;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <div className="eyebrow">Configuracoes</div>
          <h1>Parametros, sugestoes e efeitos</h1>
        </div>
        <button className="btn" onClick={() => void api.resetSettings()}>
          Restaurar todas as sugestoes
        </button>
      </header>

      <div className="notice notice-warn small">
        <strong>Os valores sugeridos sao pontos de partida para simulacao.</strong> Nao foram
        validados com dados historicos e nao ha evidencia de rentabilidade associada a eles. Ajustes
        futuros baseados em desempenho precisam considerar custos, tamanho da amostra, dependencia
        entre fontes e teste fora da amostra. Nenhuma configuracao e alterada sem acao sua.
      </div>

      {groups.map((group) => {
        const items = meta.descriptors.filter((d: any) => d.group === group);
        if (items.length === 0) return null;
        return (
          <Card
            key={group}
            title={GROUP_TITLE[group]}
            aside={
              group !== 'operacao' ? (
                <button className="btn btn-sm" onClick={() => void api.resetSettings(group)}>
                  Restaurar grupo
                </button>
              ) : undefined
            }
          >
            {items.map((descriptor: any) => {
              const current = valueOf(descriptor.key);
              const suggested = descriptor.suggested;
              const isSuggested = JSON.stringify(current) === JSON.stringify(suggested);
              const basis = BASIS_LABEL[descriptor.basis] ?? BASIS_LABEL.PADRAO_INICIAL_SIMULACAO!;

              return (
                <div key={descriptor.key} className="param">
                  <div className="param-meta">
                    <div className="row" style={{ gap: 8 }}>
                      <strong>{descriptor.label}</strong>
                      <Badge tone={basis.tone}>{basis.label}</Badge>
                      {!isSuggested && <Badge tone="block">alterado</Badge>}
                    </div>
                    <dl className="param-note small">
                      <dt>O que e</dt>
                      <dd>{descriptor.explanation}</dd>
                      <dt>Efeito</dt>
                      <dd>{descriptor.effect}</dd>
                      <dt>Depende de</dt>
                      <dd>{descriptor.dependencies}</dd>
                      <dt>Sugerido</dt>
                      <dd className="num">
                        {typeof suggested === 'object' ? JSON.stringify(suggested) : String(suggested)}
                        {descriptor.unit ? ` ${descriptor.unit}` : ''}
                      </dd>
                    </dl>
                  </div>

                  <div className="param-control">
                    <Control descriptor={descriptor} value={current} onChange={(v) => save(descriptor.key, v)} />
                    <button
                      className="btn btn-sm"
                      disabled={isSuggested}
                      onClick={() => save(descriptor.key, suggested)}
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

      <Card title="Fontes incluidas e excluidas da convergencia">
        <p className="small muted">
          Fontes excluidas continuam recebendo sinais e aparecem no historico, porem nao votam nem
          entram no denominador do percentual.
        </p>
        <div className="stack-sm" style={{ marginTop: 10 }}>
          {snapshot.sources.map((source: any) => {
            const excluded = snapshot.convergenceSettings.excludedSourceIds.includes(source.id);
            return (
              <label key={source.id} className="row" style={{ gap: 8 }}>
                <input
                  type="checkbox"
                  style={{ width: 'auto' }}
                  checked={!excluded}
                  onChange={(e) => {
                    const next = e.target.checked
                      ? snapshot.convergenceSettings.excludedSourceIds.filter((id: string) => id !== source.id)
                      : [...snapshot.convergenceSettings.excludedSourceIds, source.id];
                    void api.saveConvergence({ excludedSourceIds: next });
                  }}
                />
                <span>{source.name}</span>
                <span className="tiny dim num">grupo {source.independenceGroupId}</span>
                {excluded && <Badge tone="block">excluida</Badge>}
              </label>
            );
          })}
        </div>
      </Card>

      <Card title="Horarios permitidos">
        <div className="stack-sm">
          {snapshot.riskSettings.tradingWindows.map((window: any, index: number) => (
            <div className="row" key={index}>
              <label className="field">
                <span className="eyebrow">Inicio</span>
                <input
                  type="text"
                  value={window.start}
                  onChange={(e) => {
                    const next = [...snapshot.riskSettings.tradingWindows];
                    next[index] = { ...window, start: e.target.value };
                    void api.saveRisk({ tradingWindows: next });
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
                    const next = [...snapshot.riskSettings.tradingWindows];
                    next[index] = { ...window, end: e.target.value };
                    void api.saveRisk({ tradingWindows: next });
                  }}
                  style={{ width: 90 }}
                />
              </label>
              <span className="small dim">
                interpretado em {snapshot.riskSettings.tradingTimezone}
              </span>
            </div>
          ))}
          <div className="row">
            <span className="eyebrow">Dias</span>
            {['seg', 'ter', 'qua', 'qui', 'sex', 'sab', 'dom'].map((label, index) => {
              const day = index + 1;
              const active = snapshot.riskSettings.tradingDays.includes(day);
              const weekend = day >= 6;
              return (
                <label key={label} className="row" style={{ gap: 4 }}>
                  <input
                    type="checkbox"
                    style={{ width: 'auto' }}
                    checked={active}
                    onChange={(e) => {
                      const next = e.target.checked
                        ? [...snapshot.riskSettings.tradingDays, day].sort()
                        : snapshot.riskSettings.tradingDays.filter((d: number) => d !== day);
                      void api.saveRisk({ tradingDays: next });
                    }}
                  />
                  <span className={weekend ? 'dim' : undefined}>{label}</span>
                </label>
              );
            })}
          </div>
          <p className="tiny dim">
            Forex spot nao negocia sabado e domingo. Marcar o fim de semana nao gera negocios.
          </p>
        </div>
      </Card>

      <Card title="Cenarios de demonstracao">
        <p className="small muted">
          Cada cenario exercita um caminho do fluxo e deixa o rastro no historico de decisoes.
        </p>
        <div className="stack-sm" style={{ marginTop: 10 }}>
          {meta.scenarios.map((scenario) => (
            <div key={scenario.key} className="row" style={{ justifyContent: 'space-between', gap: 12 }}>
              <div style={{ flex: 1, minWidth: 240 }}>
                <strong className="small">{scenario.name}</strong>
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

      <Persistencia snapshot={snapshot} />

      <Card title="Caixa da conta simulada">
        <p className="small muted">
          Depositos e saques entram no saldo e ficam de fora do resultado operacional do dia.
        </p>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn btn-sm" onClick={() => void api.cashflow(1000)}>
            Depositar USD 1.000
          </button>
          <button className="btn btn-sm" onClick={() => void api.cashflow(-1000)}>
            Sacar USD 1.000
          </button>
        </div>
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
  const [info, setInfo] = useState<Awaited<ReturnType<typeof api.db>> | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // Recarrega a contagem quando o instantaneo muda de minuto.
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
    <Card
      title="Persistencia"
      aside={<Badge tone="ok">SQLite</Badge>}
    >
      <p className="small muted">
        Fontes, sinais, oportunidades, ordens, posicoes, eventos e configuracoes ficam gravados em
        disco. Reiniciar o backend retoma de onde parou. Oportunidades que venceram enquanto o
        processo estava fora do ar voltam como expiradas, nunca elegiveis.
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
      </dl>

      <div className="notice notice-risk small" style={{ marginTop: 12 }}>
        <strong>Apagar o banco e irreversivel.</strong> Remove todo o historico de decisoes,
        operacoes e ajustes, e devolve as configuracoes aos valores sugeridos.
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
    return (
      <p className="tiny dim">
        Editado nos blocos especificos abaixo desta pagina.
      </p>
    );
  }

  if (descriptor.kind === 'secret') {
    return (
      <input type="text" value="" placeholder="preenchido pelo usuario" readOnly />
    );
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
      {descriptor.unit && <span className="tiny dim" style={{ whiteSpace: 'nowrap' }}>{descriptor.unit}</span>}
    </div>
  );
}
