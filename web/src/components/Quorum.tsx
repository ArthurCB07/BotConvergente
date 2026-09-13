/**
 * Barra de quorum.
 *
 * Desenha UMA celula por fonte, de modo que o denominador do percentual fique
 * visivel: concordantes, divergentes, nao comparaveis e as cadastradas que nao
 * participaram daquela janela. E a leitura que impede ler "75%" como chance de ganho.
 */

interface Vote {
  sourceId: string;
  signalId: string;
  sourceName: string;
  independenceGroupId: string;
  excludedReason: string | null;
}

interface Absent {
  sourceId: string;
  sourceName: string;
  reason: string;
}

export function Quorum({
  agreeing,
  dissenting,
  notComparable,
  nonParticipants,
  compact,
}: {
  agreeing: Vote[];
  dissenting: Vote[];
  notComparable: Vote[];
  nonParticipants: Absent[];
  compact?: boolean;
}) {
  const cells = [
    ...agreeing.map((v) => ({
      key: `a-${v.signalId ?? v.sourceId}`,
      className: 'quorum-agree',
      label: v.sourceName,
      title: `${v.sourceName}: concorda. Grupo de independencia "${v.independenceGroupId}".`,
    })),
    ...dissenting.map((v) => ({
      key: `d-${v.signalId ?? v.sourceId}`,
      className: 'quorum-dissent',
      label: v.sourceName,
      title: `${v.sourceName}: direcao contraria. Entra no denominador conforme a politica configurada.`,
    })),
    ...notComparable.map((v) => ({
      key: `n-${v.signalId ?? v.sourceId}`,
      className: 'quorum-incomparable',
      label: v.sourceName,
      title: `${v.sourceName}: fora do denominador. ${v.excludedReason ?? ''}`,
    })),
    ...nonParticipants.map((v) => ({
      key: `x-${v.sourceId}`,
      className: 'quorum-absent',
      label: v.sourceName,
      title: `${v.sourceName}: nao participou. ${v.reason}`,
    })),
  ];

  if (cells.length === 0) return null;

  return (
    <div className="quorum">
      <div className="quorum-track">
        {cells.map((cell) => (
          <span key={cell.key} className={`quorum-cell ${cell.className}`} title={cell.title}>
            {cell.label}
          </span>
        ))}
      </div>
      {!compact && (
        <div className="quorum-legend tiny dim">
          <span className="quorum-key">
            <span className="quorum-swatch" style={{ background: 'var(--ok)' }} />
            {agreeing.length} concordante(s)
          </span>
          <span className="quorum-key">
            <span className="quorum-swatch" style={{ background: 'var(--risk)' }} />
            {dissenting.length} contraria(s)
          </span>
          <span className="quorum-key">
            <span className="quorum-swatch quorum-incomparable" />
            {notComparable.length} nao comparavel(is)
          </span>
          <span className="quorum-key">
            <span className="quorum-swatch quorum-absent" />
            {nonParticipants.length} cadastrada(s) sem voto
          </span>
        </div>
      )}
    </div>
  );
}
