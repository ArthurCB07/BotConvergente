import type { Snapshot } from '../api.ts';
import { Quorum } from '../components/Quorum.tsx';
import { Badge, Card, Checks, Empty, SIDE_LABEL, clock, pct } from '../components/ui.tsx';

/**
 * Tela Convergencias: mostra TODOS os agrupamentos avaliados, inclusive os que nao
 * viraram oportunidade. O valor aqui esta no "por que nao".
 */
export function Convergencias({ snapshot }: { snapshot: Snapshot }) {
  const settings = snapshot.convergenceSettings;
  const evaluations = [...snapshot.evaluations].sort(
    (a: any, b: any) => Number(b.meetsCriteria) - Number(a.meetsCriteria) || b.agreementPercent - a.agreementPercent,
  );

  const criteriaLabel =
    settings.criteriaMode === 'BOTH'
      ? `${settings.minAgreeingSources} fontes e ${settings.minAgreementPercent}%`
      : settings.criteriaMode === 'COUNT'
        ? `${settings.minAgreeingSources} fontes`
        : `${settings.minAgreementPercent}%`;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <div className="eyebrow">Convergencias</div>
          <h1>Agrupamentos avaliados agora</h1>
        </div>
        <div className="row">
          <Badge tone="neutral">corte: {criteriaLabel}</Badge>
          <Badge tone="neutral">janela: {settings.groupingWindowMinutes} min</Badge>
          <Badge tone="neutral">tolerancia: {settings.entryTolerancePips} pips</Badge>
        </div>
      </header>

      <div className="notice small">
        <strong>Como ler o percentual.</strong> O denominador sao os grupos de independencia com
        sinal valido e comparavel dentro da janela. "3 de 4 fontes participantes — 75% de
        concordancia" descreve quantas fontes disseram a mesma coisa. Nao e probabilidade de ganho,
        nem estimativa de retorno.
      </div>

      {evaluations.length === 0 ? (
        <Card title="Nenhum agrupamento">
          <Empty>
            Nenhum instrumento tem sinais validos na janela atual. Gere uma rodada na tela Fontes ou
            rode um cenario.
          </Empty>
        </Card>
      ) : (
        evaluations.map((evaluation: any) => (
          <Card
            key={evaluation.clusterKey + evaluation.anchorAt}
            title={
              <span className="row" style={{ gap: 8 }}>
                <span className="num" style={{ fontSize: 15 }}>
                  {evaluation.symbol}
                </span>
                <Badge tone={evaluation.side === 'BUY' ? 'long' : 'short'}>
                  {SIDE_LABEL[evaluation.side]}
                </Badge>
                <Badge tone={evaluation.venue === 'OTC' ? 'risk' : 'neutral'}>
                  {evaluation.venue === 'OTC' ? 'OTC' : 'mercado regular'}
                </Badge>
              </span>
            }
            aside={
              <span className="row">
                <Badge tone={evaluation.meetsCriteria ? 'ok' : 'block'}>
                  {evaluation.meetsCriteria ? 'criterios atendidos' : 'abaixo do corte'}
                </Badge>
                <span className="tiny dim num">ancora {clock(evaluation.anchorAt)}</span>
              </span>
            }
          >
            <div className="row" style={{ gap: 24, marginBottom: 12 }}>
              <div>
                <div className="eyebrow">Concordancia</div>
                <div className="figure">{pct(evaluation.agreementPercent, 0)}</div>
                <div className="tiny dim">
                  {evaluation.agreeingCount} de {evaluation.participantCount} participantes
                </div>
              </div>
              <div>
                <div className="eyebrow">Ponderada</div>
                <div className="figure-sm">{pct(evaluation.weightedAgreementPercent, 0)}</div>
                <div className="tiny dim">
                  {settings.useSourceWeights ? 'em uso' : 'informativa: pesos desligados'}
                </div>
              </div>
              <div>
                <div className="eyebrow">Cadastradas ativas</div>
                <div className="figure-sm">{evaluation.registeredActiveSources}</div>
                <div className="tiny dim">{evaluation.nonParticipants.length} sem voto nesta janela</div>
              </div>
              <div>
                <div className="eyebrow">Referencia</div>
                <div className="figure-sm">{evaluation.referenceEntry ?? 'mercado'}</div>
                <div className="tiny dim">mediana das entradas concordantes</div>
              </div>
            </div>

            <Quorum
              agreeing={evaluation.agreeing}
              dissenting={evaluation.dissenting}
              notComparable={evaluation.notComparable}
              nonParticipants={evaluation.nonParticipants}
            />

            <div className="grid grid-2" style={{ marginTop: 14 }}>
              <div>
                <div className="eyebrow" style={{ marginBottom: 6 }}>
                  Criterios
                </div>
                <Checks items={evaluation.criteria} />
              </div>
              <div>
                <div className="eyebrow" style={{ marginBottom: 6 }}>
                  Fora do denominador
                </div>
                {evaluation.notComparable.length === 0 && evaluation.nonParticipants.length === 0 ? (
                  <p className="small dim">Todas as fontes cadastradas participaram.</p>
                ) : (
                  <ul className="checks">
                    {evaluation.notComparable.map((v: any) => (
                      <li key={v.signalId} className="check check-fail">
                        <span className="check-mark">≠</span>
                        <span>
                          <span className="check-label">{v.sourceName}</span>
                          <br />
                          <span className="check-detail small">{v.excludedReason}</span>
                        </span>
                      </li>
                    ))}
                    {evaluation.nonParticipants.map((v: any) => (
                      <li key={v.sourceId} className="check">
                        <span className="check-mark dim">·</span>
                        <span>
                          <span className="check-label">{v.sourceName}</span>
                          <br />
                          <span className="check-detail small">{v.reason}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            <p className="small muted" style={{ marginTop: 12 }}>
              {evaluation.summary}
            </p>
          </Card>
        ))
      )}
    </div>
  );
}
