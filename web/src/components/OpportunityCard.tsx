import { Quorum } from './Quorum.tsx';
import { Badge, Checks, SIDE_LABEL, countdown, money, pct } from './ui.tsx';

const STATUS: Record<string, { tone: 'ok' | 'block' | 'watch' | 'risk' | 'neutral'; label: string }> = {
  PUBLISHED: { tone: 'watch', label: 'Publicada' },
  UPDATED: { tone: 'watch', label: 'Atualizada' },
  EXECUTED: { tone: 'ok', label: 'Executada' },
  EXPIRED: { tone: 'neutral', label: 'Expirada' },
  BLOCKED: { tone: 'block', label: 'Bloqueada' },
  REJECTED_BY_USER: { tone: 'neutral', label: 'Descartada' },
  CANCELLED: { tone: 'neutral', label: 'Cancelada' },
};

export function OpportunityCard({
  opportunity,
  decision,
  now,
  mode,
  awaiting,
  onConfirm,
  onReject,
  busy,
}: {
  opportunity: any;
  decision: any;
  now: string;
  mode: string;
  awaiting: boolean;
  onConfirm: () => void;
  onReject: () => void;
  busy: boolean;
}) {
  const status = STATUS[opportunity.status] ?? STATUS.PUBLISHED!;
  const blocks = decision?.blocks ?? [];
  const allowed = decision?.allowed === true;
  const sizing = decision?.sizing;

  return (
    <article className="opp">
      <header className="opp-head">
        <span className="opp-symbol">{opportunity.symbol}</span>
        <Badge tone={opportunity.side === 'BUY' ? 'long' : 'short'}>
          {SIDE_LABEL[opportunity.side]}
        </Badge>
        <Badge tone={status.tone}>{status.label}</Badge>
        {opportunity.venue === 'OTC' && <Badge tone="risk">OTC</Badge>}
        <span className="tiny dim num">v{opportunity.version}</span>
        <span style={{ marginLeft: 'auto' }} className="tiny dim num">
          {countdown(opportunity.validUntil, now)}
        </span>
      </header>

      <div className="opp-body">
        <div className="row" style={{ gap: 22 }}>
          <div>
            <div className="eyebrow">Concordancia</div>
            <div className="figure">{pct(opportunity.agreementPercent, 0)}</div>
            <div className="tiny dim">
              {opportunity.agreeingCount} de {opportunity.participantCount} fontes participantes
            </div>
          </div>
          <div>
            <div className="eyebrow">Referencia de entrada</div>
            <div className="figure-sm">{opportunity.referenceEntry ?? 'a mercado'}</div>
            <div className="tiny dim">
              Stop {opportunity.suggestedStopLoss ?? '—'} · Alvo {opportunity.suggestedTakeProfit ?? '—'}
            </div>
          </div>
          {sizing && (
            <div>
              <div className="eyebrow">Dimensionamento</div>
              <div className="figure-sm">{sizing.lots} lote(s)</div>
              <div className="tiny dim">
                Ordem {money(sizing.notionalValue)} · Arriscado {money(sizing.riskedValue)}
              </div>
            </div>
          )}
        </div>

        <p className="small muted">{opportunity.summary}</p>

        <Quorum
          agreeing={opportunity.agreeing}
          dissenting={opportunity.dissenting}
          notComparable={opportunity.notComparable}
          nonParticipants={opportunity.nonParticipants}
        />

        <details>
          <summary className="small">Criterios da convergencia</summary>
          <div style={{ marginTop: 8 }}>
            <Checks items={opportunity.criteria} />
          </div>
        </details>

        {decision && (
          <details open={!allowed && blocks.length > 0}>
            <summary className="small">
              {allowed ? 'Regras de risco atendidas' : `Bloqueado por ${blocks.length} regra(s)`}
            </summary>
            <div style={{ marginTop: 8 }}>
              <Checks items={decision.checks} />
              {decision.warnings?.length > 0 && (
                <div className="notice notice-warn small" style={{ marginTop: 10 }}>
                  {decision.warnings.map((w: any) => (
                    <div key={w.code}>
                      <strong>{w.label}:</strong> {w.detail}
                    </div>
                  ))}
                </div>
              )}
              {sizing && <p className="tiny dim" style={{ marginTop: 8 }}>{sizing.explanation}</p>}
            </div>
          </details>
        )}
      </div>

      <footer className="opp-foot">
        {mode === 'OBSERVE' && (
          <span className="small muted">
            Modo Observacao: nenhuma ordem sai daqui. Troque o modo para operar.
          </span>
        )}
        {mode !== 'OBSERVE' && opportunity.status !== 'EXECUTED' && (
          <>
            <button
              className="btn btn-primary btn-sm"
              onClick={onConfirm}
              disabled={busy || !allowed}
              title={allowed ? 'Enviar ordem na conta simulada' : blocks.map((b: any) => b.label).join('; ')}
            >
              {mode === 'AUTO' ? 'Enviar agora' : 'Confirmar e enviar'}
            </button>
            <button className="btn btn-sm" onClick={onReject} disabled={busy}>
              Descartar
            </button>
            {awaiting && <Badge tone="watch">Aguardando confirmacao</Badge>}
          </>
        )}
        {!allowed && blocks.length > 0 && (
          <span className="small" style={{ color: 'var(--block)' }}>
            {blocks.map((b: any) => b.label).join(' · ')}
          </span>
        )}
      </footer>
    </article>
  );
}
