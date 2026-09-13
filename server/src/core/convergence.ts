import { getInstrument } from './instruments.ts';
import { minutesBetween } from './time.ts';
import type {
  ConvergenceSettings,
  CriterionCheck,
  Market,
  NonParticipant,
  Side,
  Signal,
  Source,
  Venue,
  VoteDetail,
} from './types.ts';

/**
 * Motor de convergencia.
 *
 * Principios aplicados aqui:
 *  1. Comparar so o que e comparavel: mesmo mercado, mesmo instrumento e mesmo
 *     ambiente de negociacao. OTC nunca entra no mesmo agrupamento que REGULAR.
 *  2. Um voto vigente por GRUPO DE INDEPENDENCIA, nao por fonte cadastrada.
 *     Salas com nomes diferentes que compartilham origem contam uma vez so.
 *  3. Denominador explicito: grupos de independencia com sinal valido e comparavel
 *     dentro da janela. Fontes que nao participaram sao listadas a parte.
 *  4. Concordancia e medida de corroboracao entre fontes. Nao e probabilidade de ganho.
 */

export interface ConvergenceEvaluation {
  clusterKey: string;
  market: Market;
  symbol: string;
  venue: Venue;
  side: Side;
  anchorAt: string;

  meetsCriteria: boolean;
  criteria: CriterionCheck[];

  agreeing: VoteDetail[];
  dissenting: VoteDetail[];
  notComparable: VoteDetail[];
  nonParticipants: NonParticipant[];

  participantCount: number;
  agreeingCount: number;
  agreementPercent: number;
  weightedAgreementPercent: number;
  registeredActiveSources: number;

  referenceEntry: number | null;
  suggestedStopLoss: number | null;
  suggestedTakeProfit: number | null;

  summary: string;
  signalIds: string[];
}

export interface ConvergenceInput {
  nowIso: string;
  settings: ConvergenceSettings;
  signals: Signal[];
  sources: Source[];
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const a = sorted[mid - 1];
  const b = sorted[mid];
  if (a === undefined || b === undefined) return null;
  return (a + b) / 2;
}

function sourceAllowed(source: Source, settings: ConvergenceSettings): boolean {
  if (!source.enabled) return false;
  if (settings.excludedSourceIds.includes(source.id)) return false;
  if (settings.includedSourceIds && !settings.includedSourceIds.includes(source.id)) return false;
  return true;
}

export function clusterKeyOf(symbol: string, venue: Venue, side: Side): string {
  return `FX_SPOT|${symbol}|${venue}|${side}`;
}

export function evaluateConvergence(input: ConvergenceInput): ConvergenceEvaluation[] {
  const { nowIso, settings, signals, sources } = input;
  const sourceById = new Map(sources.map((s) => [s.id, s]));
  const eligibleSources = sources.filter((s) => sourceAllowed(s, settings));

  // --- 1. Sinais que podem votar --------------------------------------------
  type Candidate = { signal: Signal; source: Source };
  const candidates: Candidate[] = [];
  /** Motivo de nao participacao por fonte, para exibir na oportunidade. */
  const exclusionBySource = new Map<string, string>();

  for (const source of sources) {
    if (!source.enabled) {
      exclusionBySource.set(source.id, 'Fonte desativada.');
      continue;
    }
    if (settings.excludedSourceIds.includes(source.id)) {
      exclusionBySource.set(source.id, 'Fonte excluida na configuracao de convergencia.');
      continue;
    }
    if (settings.includedSourceIds && !settings.includedSourceIds.includes(source.id)) {
      exclusionBySource.set(source.id, 'Fonte fora da lista de inclusao.');
      continue;
    }
    exclusionBySource.set(source.id, 'Sem sinal valido na janela.');
  }

  for (const signal of signals) {
    const source = sourceById.get(signal.sourceId);
    if (!source || !sourceAllowed(source, settings)) continue;
    if (signal.status !== 'VALID') {
      const label: Record<string, string> = {
        EXPIRED: 'Sinal expirado.',
        CANCELLED: 'Sinal cancelado pela fonte.',
        SUPERSEDED: 'Sinal substituido por uma edicao.',
        AMBIGUOUS: 'Sinal ambiguo: nao vota.',
        INCOMPLETE: 'Sinal incompleto.',
        DUPLICATE: 'Mensagem duplicada.',
        REJECTED: 'Sinal recusado na validacao.',
      };
      exclusionBySource.set(source.id, label[signal.status] ?? 'Sinal invalido.');
      continue;
    }
    if (!signal.side) continue;
    if (minutesBetween(signal.receivedAt, nowIso) > settings.maxSignalAgeMinutes) {
      exclusionBySource.set(source.id, 'Sinal alem da idade maxima configurada.');
      continue;
    }
    candidates.push({ signal, source });
  }

  // --- 2. Agrupar por instrumento e ambiente --------------------------------
  const buckets = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const key = `${c.signal.market}|${c.signal.symbol}|${c.signal.venue}`;
    const list = buckets.get(key) ?? [];
    list.push(c);
    buckets.set(key, list);
  }

  const evaluations: ConvergenceEvaluation[] = [];

  for (const [bucketKey, bucket] of buckets) {
    const parts = bucketKey.split('|');
    const symbol = parts[1] ?? '';
    const venue = (parts[2] ?? 'REGULAR') as Venue;
    const instrument = getInstrument(symbol);
    if (!instrument) continue;

    // --- 3. Um voto vigente por grupo de independencia ---------------------
    const byGroup = new Map<string, Candidate>();
    for (const c of bucket) {
      const groupId = c.source.independenceGroupId;
      const current = byGroup.get(groupId);
      if (!current || Date.parse(c.signal.receivedAt) > Date.parse(current.signal.receivedAt)) {
        if (current) {
          exclusionBySource.set(
            current.source.id,
            `Voto substituido por ${c.source.name}, do mesmo grupo de independencia "${groupId}".`,
          );
        }
        byGroup.set(groupId, c);
      } else {
        exclusionBySource.set(
          c.source.id,
          `Voto ja representado por ${current.source.name}, do mesmo grupo de independencia "${groupId}".`,
        );
      }
    }
    const votes = [...byGroup.values()];
    if (votes.length === 0) continue;

    // --- 4. Janela de agrupamento ancorada no sinal mais recente -----------
    const anchor = votes.reduce((acc, v) =>
      Date.parse(v.signal.receivedAt) > Date.parse(acc.signal.receivedAt) ? v : acc,
    );
    const anchorAt = anchor.signal.receivedAt;
    const inWindow: Candidate[] = [];
    for (const v of votes) {
      const deltaMin = Math.abs(minutesBetween(v.signal.receivedAt, anchorAt));
      if (deltaMin <= settings.groupingWindowMinutes) inWindow.push(v);
      else {
        exclusionBySource.set(
          v.source.id,
          `Sinal fora da janela de agrupamento de ${settings.groupingWindowMinutes} min.`,
        );
      }
    }
    if (inWindow.length === 0) continue;

    // --- 5. Direcao candidata ---------------------------------------------
    const weightOf = (c: Candidate) => (settings.useSourceWeights ? c.source.weight : 1);
    const buyWeight = inWindow.filter((c) => c.signal.side === 'BUY').reduce((s, c) => s + weightOf(c), 0);
    const sellWeight = inWindow.filter((c) => c.signal.side === 'SELL').reduce((s, c) => s + weightOf(c), 0);
    let side: Side;
    if (buyWeight > sellWeight) side = 'BUY';
    else if (sellWeight > buyWeight) side = 'SELL';
    else side = anchor.signal.side ?? 'BUY';

    const sameSide = inWindow.filter((c) => c.signal.side === side);
    const oppositeSide = inWindow.filter((c) => c.signal.side !== side);

    // --- 6. Preco de referencia -------------------------------------------
    const referenceEntry = median(
      sameSide.map((c) => c.signal.entryPrice).filter((p): p is number => p != null),
    );

    // --- 7. Horizonte de referencia ---------------------------------------
    const horizonReference = median(
      sameSide.map((c) => c.signal.horizonMinutes).filter((h): h is number => h != null),
    );

    const toVote = (c: Candidate, excludedReason: string | null): VoteDetail => ({
      sourceId: c.source.id,
      sourceName: c.source.name,
      independenceGroupId: c.source.independenceGroupId,
      signalId: c.signal.id,
      side: c.signal.side as Side,
      entryPrice: c.signal.entryPrice,
      emittedAt: c.signal.emittedAt,
      receivedAt: c.signal.receivedAt,
      weight: c.source.weight,
      excludedReason,
    });

    const agreeing: VoteDetail[] = [];
    const notComparable: VoteDetail[] = [];

    for (const c of sameSide) {
      // Compatibilidade de preco: aplica-se apenas a sinais com preco declarado.
      if (referenceEntry != null && c.signal.entryPrice != null) {
        const deltaPips = Math.abs(c.signal.entryPrice - referenceEntry) / instrument.pipSize;
        if (deltaPips > settings.entryTolerancePips) {
          notComparable.push(
            toVote(
              c,
              `Entrada a ${deltaPips.toFixed(1)} pips da referencia, acima da tolerancia de ${settings.entryTolerancePips} pips.`,
            ),
          );
          exclusionBySource.set(c.source.id, 'Preco de entrada fora da tolerancia do agrupamento.');
          continue;
        }
      }
      // Compatibilidade de horizonte.
      if (
        settings.requireCompatibleTimeframe &&
        horizonReference != null &&
        c.signal.horizonMinutes != null
      ) {
        const ratio =
          Math.max(c.signal.horizonMinutes, horizonReference) /
          Math.max(1, Math.min(c.signal.horizonMinutes, horizonReference));
        if (ratio > settings.horizonRatioTolerance) {
          notComparable.push(
            toVote(
              c,
              `Horizonte de ${c.signal.horizonMinutes} min contra referencia de ${horizonReference} min (razao ${ratio.toFixed(1)}x).`,
            ),
          );
          exclusionBySource.set(c.source.id, 'Horizonte incompativel com o agrupamento.');
          continue;
        }
      }
      agreeing.push(toVote(c, null));
      exclusionBySource.delete(c.source.id);
    }

    const dissenting: VoteDetail[] = [];
    for (const c of oppositeSide) {
      if (
        settings.requireCompatibleTimeframe &&
        horizonReference != null &&
        c.signal.horizonMinutes != null
      ) {
        const ratio =
          Math.max(c.signal.horizonMinutes, horizonReference) /
          Math.max(1, Math.min(c.signal.horizonMinutes, horizonReference));
        if (ratio > settings.horizonRatioTolerance) {
          notComparable.push(toVote(c, 'Direcao contraria, porem com horizonte incompativel.'));
          exclusionBySource.set(c.source.id, 'Horizonte incompativel com o agrupamento.');
          continue;
        }
      }
      dissenting.push(toVote(c, null));
      exclusionBySource.delete(c.source.id);
    }

    // --- 8. Denominador ----------------------------------------------------
    const countOpposing = settings.opposingPolicy !== 'IGNORE_IN_DENOMINATOR';
    const denominatorVotes = countOpposing ? [...agreeing, ...dissenting] : agreeing;
    const participantCount = denominatorVotes.length;
    const agreeingCount = agreeing.length;
    const agreementPercent = participantCount === 0 ? 0 : (agreeingCount / participantCount) * 100;

    const sumWeights = (v: VoteDetail[]) => v.reduce((s, x) => s + x.weight, 0);
    const weightedDen = sumWeights(denominatorVotes);
    const weightedAgreementPercent = weightedDen === 0 ? 0 : (sumWeights(agreeing) / weightedDen) * 100;

    const effectivePercent = settings.useSourceWeights ? weightedAgreementPercent : agreementPercent;

    // --- 9. Fontes cadastradas que nao participaram ------------------------
    const participatingSourceIds = new Set(denominatorVotes.map((v) => v.sourceId));
    const nonParticipants: NonParticipant[] = eligibleSources
      .filter((s) => !participatingSourceIds.has(s.id))
      .map((s) => ({
        sourceId: s.id,
        sourceName: s.name,
        reason: exclusionBySource.get(s.id) ?? 'Sem sinal valido na janela.',
      }));

    // --- 10. Criterios -----------------------------------------------------
    const criteria: CriterionCheck[] = [];
    const useCount = settings.criteriaMode === 'COUNT' || settings.criteriaMode === 'BOTH';
    const usePercent = settings.criteriaMode === 'PERCENT' || settings.criteriaMode === 'BOTH';

    if (useCount) {
      criteria.push({
        code: 'MIN_FONTES',
        label: `Minimo de ${settings.minAgreeingSources} fontes concordantes`,
        passed: agreeingCount >= settings.minAgreeingSources,
        detail: `${agreeingCount} grupo(s) de independencia concordando com ${side === 'BUY' ? 'compra' : 'venda'}.`,
      });
    }
    if (usePercent) {
      criteria.push({
        code: 'MIN_PERCENT',
        label: `Concordancia minima de ${settings.minAgreementPercent}%`,
        passed: effectivePercent >= settings.minAgreementPercent,
        detail: `${agreeingCount} de ${participantCount} fontes participantes = ${effectivePercent.toFixed(0)}% de concordancia.`,
      });
    }

    let opposingBlocked = false;
    if (settings.opposingPolicy === 'BLOCK_IF_ANY' && dissenting.length > 0) {
      opposingBlocked = true;
    }
    if (settings.opposingPolicy === 'BLOCK_ABOVE_RATIO' && participantCount > 0) {
      const ratio = dissenting.length / participantCount;
      if (ratio > settings.opposingBlockRatio) opposingBlocked = true;
    }
    if (settings.opposingPolicy === 'BLOCK_IF_ANY' || settings.opposingPolicy === 'BLOCK_ABOVE_RATIO') {
      criteria.push({
        code: 'CONTRARIOS',
        label: 'Politica de sinais contrarios',
        passed: !opposingBlocked,
        detail:
          dissenting.length === 0
            ? 'Nenhum sinal contrario comparavel na janela.'
            : `${dissenting.length} fonte(s) na direcao oposta.`,
      });
    }

    criteria.push({
      code: 'AMBIENTE',
      label: 'Ambiente de negociacao homogeneo',
      passed: true,
      detail: `Todos os sinais deste agrupamento sao ${venue === 'OTC' ? 'OTC' : 'de mercado regular'}. Agrupamentos OTC e regular nunca se misturam.`,
    });

    const meetsCriteria = criteria.every((c) => c.passed);

    // --- 11. Stops sugeridos ----------------------------------------------
    const suggestedStopLoss = median(
      agreeing
        .map((v) => signals.find((s) => s.id === v.signalId)?.stopLoss)
        .filter((p): p is number => p != null),
    );
    const suggestedTakeProfit = median(
      agreeing
        .map((v) => signals.find((s) => s.id === v.signalId)?.takeProfit)
        .filter((p): p is number => p != null),
    );

    const sideLabel = side === 'BUY' ? 'compra' : 'venda';
    const summary = meetsCriteria
      ? `${agreeingCount} de ${participantCount} fontes participantes concordam com ${sideLabel} em ${symbol} (${effectivePercent.toFixed(0)}% de concordancia entre fontes). Isso mede corroboracao entre fontes, nao probabilidade de ganho.`
      : `Convergencia insuficiente em ${symbol}: ${criteria.filter((c) => !c.passed).map((c) => c.label).join('; ')}.`;

    evaluations.push({
      clusterKey: clusterKeyOf(symbol, venue, side),
      market: 'FX_SPOT',
      symbol,
      venue,
      side,
      anchorAt,
      meetsCriteria,
      criteria,
      agreeing,
      dissenting,
      notComparable,
      nonParticipants,
      participantCount,
      agreeingCount,
      agreementPercent: Math.round(agreementPercent * 10) / 10,
      weightedAgreementPercent: Math.round(weightedAgreementPercent * 10) / 10,
      registeredActiveSources: eligibleSources.length,
      referenceEntry,
      suggestedStopLoss,
      suggestedTakeProfit,
      summary,
      signalIds: [...agreeing, ...dissenting, ...notComparable].map((v) => v.signalId),
    });
  }

  return evaluations;
}
