import { MARKET_LABEL, PRODUCT_LABEL, type MarketSlice } from '../api.ts';
import { Quorum } from '../components/Quorum.tsx';
import { Badge, Card, Checks, Empty, MarketChip, SIDE_LABEL, clock, pct } from '../components/ui.tsx';

/**
 * Tela Convergencias: mostra TODOS os agrupamentos avaliados do mercado
 * selecionado, inclusive os que nao viraram oportunidade. O valor aqui esta no
 * "por que nao".
 */
export function Convergencias({ market }: { market: MarketSlice }) {
  const settings = market.convergenceSettings;
  const marketId = market.marketId;
  const evaluations = [...market.evaluations].sort(
    (a: any, b: any) =>
      Number(b.meetsCriteria) - Number(a.meetsCriteria) || b.agreementPercent - a.agreementPercent,
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
          <div className="eyebrow">Convergencias · {MARKET_LABEL[marketId]}</div>
          <h1>Agrupamentos avaliados agora</h1>
        </div>
        <div className="row">
          <MarketChip marketId={marketId} />
          <Badge tone="neutral">corte: {criteriaLabel}</Badge>
          <Badge tone="neutral">janela: {settings.groupingWindowMinutes} min</Badge>
          <Badge tone="neutral">tolerancia: {settings.entryTolerancePips} pips</Badge>
          <Badge tone="neutral">
            base: {settings.denominatorMode === 'ENABLED_SOURCES' ? 'habilitadas' : 'com sinal'}
          </Badge>
        </div>
      </header>

      <div className="notice small">
        <strong>Como ler o percentual.</strong> A regra do denominador aparece em cada agrupamento,
        junto do numerador. "3 de 4 fontes participantes — 75% de concordancia" descreve quantas
        fontes disseram a mesma coisa. Nao e probabilidade de ganho.{' '}
        <strong>Fontes de {MARKET_LABEL[marketId === 'FOREX' ? 'CRYPTO' : 'FOREX']} nunca entram
        nesta conta.</strong>
      </div>

      {evaluations.length === 0 ? (
        <Card title="Nenhum agrupamento">
          <Empty>
            Nenhum instrumento de {MARKET_LABEL[marketId]} tem sinais validos na janela atual. Gere
            uma rodada na tela Fontes ou rode um cenario.
          </Empty>
        </Card>
      ) : (
        evaluations.map((evaluation: any) => (
          <Card
            key={evaluation.clusterKey + evaluation.anchorAt}
            title={
              <span className="row" style={{ gap: 8 }}>
                <MarketChip marketId={evaluation.marketId} />
                <span className="num" style={{ fontSize: 15 }}>
                  {evaluation.symbol}
                </span>
                <Badge tone={evaluation.side === 'BUY' ? 'long' : 'short'}>
                  {SIDE_LABEL[evaluation.side]}
                </Badge>
                <Badge tone="neutral">
                  {PRODUCT_LABEL[evaluation.productType] ?? evaluation.productType}
                </Badge>
                {evaluation.venue === 'OTC' && <Badge tone="risk">OTC</Badge>}
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
                <div className="tiny dim num">
                  {evaluation.agreeingCount} / {evaluation.participantCount}
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
                <div className="eyebrow">Habilitadas no mercado</div>
                <div className="figure-sm">{evaluation.registeredActiveSources}</div>
                <div className="tiny dim">{evaluation.nonParticipants.length} sem voto nesta janela</div>
              </div>
              <div>
                <div className="eyebrow">Referencia</div>
                <div className="figure-sm">{evaluation.referenceEntry ?? 'mercado'}</div>
                <div className="tiny dim">mediana das entradas concordantes</div>
              </div>
              <div>
                <div className="eyebrow">Cotacao do par</div>
                <div className="figure-sm">{evaluation.quoteCurrency}</div>
                <div className="tiny dim">moeda de cotacao preservada</div>
              </div>
            </div>

            <div className="notice small" style={{ marginBottom: 12 }}>
              <strong>Base do percentual.</strong> {evaluation.denominatorRule}
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
                  Fora do numerador
                </div>
                {evaluation.notComparable.length === 0 && evaluation.nonParticipants.length === 0 ? (
                  <p className="small dim">Todas as fontes habilitadas participaram.</p>
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
                          <span className="check-label">{v.sourceName}</span>{' '}
                          {v.countedInDenominator && (
                            <Badge tone="block">conta no denominador</Badge>
                          )}
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
