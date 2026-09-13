import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateConvergence } from '../src/core/convergence.ts';
import { defaultConvergenceSettings } from '../src/core/settings.ts';
import type { ConvergenceSettings, Signal, Source, Side } from '../src/core/types.ts';

const NOW = '2026-09-14T14:00:00.000Z';

function makeSource(id: string, groupId = id, weight = 1): Source {
  return {
    id,
    name: `Fonte ${id}`,
    kind: 'GENERATOR',
    enabled: true,
    tags: [],
    independenceGroupId: groupId,
    weight,
    notes: '',
    createdAt: NOW,
    stats: { received: 0, valid: 0, rejected: 0, lastSignalAt: null },
  };
}

function makeSignal(
  sourceId: string,
  side: Side,
  overrides: Partial<Signal> = {},
  groupId = sourceId,
): Signal {
  return {
    id: `sig_${sourceId}_${side}_${Math.random().toString(36).slice(2, 7)}`,
    sourceId,
    independenceGroupId: groupId,
    raw: { text: 'teste', externalMessageId: null },
    parsedBy: 'GENERATOR',
    parserConfidence: null,
    market: 'FX_SPOT',
    symbol: 'EURUSD',
    venue: 'REGULAR',
    broker: null,
    side,
    emittedAt: NOW,
    receivedAt: NOW,
    entryAt: null,
    timezone: 'America/Sao_Paulo',
    timeframeMinutes: 15,
    horizonMinutes: 60,
    validUntil: null,
    entryType: 'LIMIT',
    entryPrice: 1.085,
    entryMin: null,
    entryMax: null,
    stopLoss: 1.083,
    takeProfit: 1.088,
    status: 'VALID',
    issues: [],
    version: 1,
    supersedesSignalId: null,
    supersededBySignalId: null,
    ...overrides,
  };
}

const settings = (patch: Partial<ConvergenceSettings> = {}): ConvergenceSettings => ({
  ...defaultConvergenceSettings,
  ...patch,
});

test('tres concordantes e um contrario resultam em 3 de 4 participantes = 75%', () => {
  const sources = [makeSource('a'), makeSource('b'), makeSource('c'), makeSource('d')];
  const signals = [
    makeSignal('a', 'BUY'),
    makeSignal('b', 'BUY'),
    makeSignal('c', 'BUY'),
    makeSignal('d', 'SELL'),
  ];
  const [evaluation] = evaluateConvergence({ nowIso: NOW, settings: settings(), signals, sources });
  assert.ok(evaluation);
  assert.equal(evaluation.side, 'BUY');
  assert.equal(evaluation.agreeingCount, 3);
  assert.equal(evaluation.participantCount, 4);
  assert.equal(evaluation.agreementPercent, 75);
  assert.equal(evaluation.meetsCriteria, true);
});

test('fontes do mesmo grupo de independencia contam um voto so', () => {
  const sources = [
    makeSource('a', 'grupo1'),
    makeSource('a_mirror', 'grupo1'),
    makeSource('b', 'grupo2'),
    makeSource('c', 'grupo3'),
  ];
  const signals = [
    makeSignal('a', 'BUY', {}, 'grupo1'),
    makeSignal('a_mirror', 'BUY', {}, 'grupo1'),
    makeSignal('b', 'BUY', {}, 'grupo2'),
    makeSignal('c', 'BUY', {}, 'grupo3'),
  ];
  const [evaluation] = evaluateConvergence({ nowIso: NOW, settings: settings(), signals, sources });
  assert.ok(evaluation);
  assert.equal(evaluation.agreeingCount, 3, 'quatro fontes, tres grupos de independencia');
  assert.equal(evaluation.participantCount, 3);
  assert.equal(
    evaluation.nonParticipants.some((n) => n.reason.includes('grupo de independencia')),
    true,
  );
});

test('OTC nao e comparado com mercado regular', () => {
  const sources = [makeSource('a'), makeSource('b'), makeSource('c')];
  const signals = [
    makeSignal('a', 'BUY'),
    makeSignal('b', 'BUY'),
    makeSignal('c', 'BUY', { symbol: 'EURUSD-OTC', venue: 'OTC' }),
  ];
  const evaluations = evaluateConvergence({ nowIso: NOW, settings: settings(), signals, sources });
  assert.equal(evaluations.length, 2, 'dois agrupamentos separados');
  for (const evaluation of evaluations) {
    assert.ok(evaluation.agreeingCount <= 2);
    assert.equal(evaluation.meetsCriteria, false, 'nenhum atinge o minimo de 3 fontes');
  }
});

test('preco fora da tolerancia sai do agrupamento com motivo', () => {
  const sources = [makeSource('a'), makeSource('b'), makeSource('c')];
  const signals = [
    makeSignal('a', 'BUY', { entryPrice: 1.085 }),
    makeSignal('b', 'BUY', { entryPrice: 1.0851 }),
    makeSignal('c', 'BUY', { entryPrice: 1.095 }),
  ];
  const [evaluation] = evaluateConvergence({
    nowIso: NOW,
    settings: settings({ entryTolerancePips: 8 }),
    signals,
    sources,
  });
  assert.ok(evaluation);
  assert.equal(evaluation.agreeingCount, 2);
  assert.equal(evaluation.notComparable.length, 1);
  assert.match(evaluation.notComparable[0]?.excludedReason ?? '', /tolerancia/);
});

test('horizonte muito diferente nao entra no denominador', () => {
  const sources = [makeSource('a'), makeSource('b'), makeSource('c')];
  const signals = [
    makeSignal('a', 'BUY', { horizonMinutes: 20 }),
    makeSignal('b', 'BUY', { horizonMinutes: 25 }),
    makeSignal('c', 'BUY', { horizonMinutes: 2880 }),
  ];
  const [evaluation] = evaluateConvergence({
    nowIso: NOW,
    settings: settings({ requireCompatibleTimeframe: true, horizonRatioTolerance: 3 }),
    signals,
    sources,
  });
  assert.ok(evaluation);
  assert.equal(evaluation.participantCount, 2);
  assert.equal(evaluation.notComparable.length, 1);
});

test('sinal ambiguo ou expirado nao vota', () => {
  const sources = [makeSource('a'), makeSource('b'), makeSource('c')];
  const signals = [
    makeSignal('a', 'BUY'),
    makeSignal('b', 'BUY', { status: 'AMBIGUOUS' }),
    makeSignal('c', 'BUY', { status: 'EXPIRED' }),
  ];
  const [evaluation] = evaluateConvergence({ nowIso: NOW, settings: settings(), signals, sources });
  assert.ok(evaluation);
  assert.equal(evaluation.agreeingCount, 1);
  assert.equal(evaluation.meetsCriteria, false);
});

test('criterio BOTH rejeita 2 de 2 mesmo com 100% de concordancia', () => {
  const sources = [makeSource('a'), makeSource('b')];
  const signals = [makeSignal('a', 'BUY'), makeSignal('b', 'BUY')];
  const [evaluation] = evaluateConvergence({
    nowIso: NOW,
    settings: settings({ criteriaMode: 'BOTH', minAgreeingSources: 3, minAgreementPercent: 75 }),
    signals,
    sources,
  });
  assert.ok(evaluation);
  assert.equal(evaluation.agreementPercent, 100);
  assert.equal(evaluation.meetsCriteria, false);
  assert.equal(evaluation.criteria.find((c) => c.code === 'MIN_FONTES')?.passed, false);
});

test('politica de ignorar contrarios muda o denominador', () => {
  const sources = [makeSource('a'), makeSource('b'), makeSource('c'), makeSource('d')];
  const signals = [
    makeSignal('a', 'BUY'),
    makeSignal('b', 'BUY'),
    makeSignal('c', 'BUY'),
    makeSignal('d', 'SELL'),
  ];
  const [ignored] = evaluateConvergence({
    nowIso: NOW,
    settings: settings({ opposingPolicy: 'IGNORE_IN_DENOMINATOR' }),
    signals,
    sources,
  });
  assert.ok(ignored);
  assert.equal(ignored.participantCount, 3);
  assert.equal(ignored.agreementPercent, 100);

  const [blocking] = evaluateConvergence({
    nowIso: NOW,
    settings: settings({ opposingPolicy: 'BLOCK_IF_ANY' }),
    signals,
    sources,
  });
  assert.ok(blocking);
  assert.equal(blocking.meetsCriteria, false);
});

test('fonte excluida na configuracao aparece como nao participante', () => {
  const sources = [makeSource('a'), makeSource('b'), makeSource('c'), makeSource('d')];
  const signals = [
    makeSignal('a', 'BUY'),
    makeSignal('b', 'BUY'),
    makeSignal('c', 'BUY'),
    makeSignal('d', 'BUY'),
  ];
  const [evaluation] = evaluateConvergence({
    nowIso: NOW,
    settings: settings({ excludedSourceIds: ['d'] }),
    signals,
    sources,
  });
  assert.ok(evaluation);
  assert.equal(evaluation.agreeingCount, 3);
  assert.equal(evaluation.registeredActiveSources, 3);
});
