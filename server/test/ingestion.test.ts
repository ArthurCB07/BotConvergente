import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ingest, parseFreeText, refreshSignalStatus, validateSignal } from '../src/core/ingestion.ts';
import type { Signal, Source } from '../src/core/types.ts';

const NOW = '2026-09-14T14:00:00.000Z';

const source: Source = {
  id: 'src1',
  name: 'Sala Teste',
  kind: 'GENERATOR',
  enabled: true,
  tags: [],
  independenceGroupId: 'g1',
  weight: 1,
  notes: '',
  createdAt: NOW,
  stats: { received: 0, valid: 0, rejected: 0, lastSignalAt: null },
};

const ctx = (existing: Signal[] = []) => ({
  nowIso: NOW,
  source,
  existing,
  defaultTimezone: 'America/Sao_Paulo',
});

const base = {
  sourceId: 'src1',
  parsedBy: 'GENERATOR' as const,
  symbol: 'EURUSD',
  venue: 'REGULAR' as const,
  side: 'BUY' as const,
  timeframeMinutes: 15,
  horizonMinutes: 60,
  entryType: 'LIMIT' as const,
  entryPrice: 1.085,
  stopLoss: 1.083,
  takeProfit: 1.088,
};

test('sinal completo e valido', () => {
  const outcome = ingest({ ...base, raw: { text: 'COMPRA EURUSD', externalMessageId: 'm1' } }, ctx());
  assert.equal(outcome.kind, 'ACCEPTED');
  if (outcome.kind === 'ACCEPTED') assert.equal(outcome.signal.status, 'VALID');
});

test('mesma mensagem duas vezes vira duplicata', () => {
  const first = ingest({ ...base, raw: { text: 'COMPRA EURUSD', externalMessageId: 'm1' } }, ctx());
  assert.equal(first.kind, 'ACCEPTED');
  if (first.kind !== 'ACCEPTED') return;
  const second = ingest(
    { ...base, raw: { text: 'COMPRA EURUSD', externalMessageId: 'm1' } },
    ctx([first.signal]),
  );
  assert.equal(second.kind, 'DUPLICATE');
});

test('sem id de mensagem, conteudo identico na janela vira duplicata', () => {
  const first = ingest({ ...base, raw: { text: 'COMPRA EURUSD', externalMessageId: null } }, ctx());
  assert.equal(first.kind, 'ACCEPTED');
  if (first.kind !== 'ACCEPTED') return;
  const second = ingest(
    { ...base, raw: { text: 'COMPRA EURUSD', externalMessageId: null } },
    ctx([first.signal]),
  );
  assert.equal(second.kind, 'DUPLICATE');
});

test('ids de mensagem distintos sao mensagens distintas, nao duplicatas', () => {
  const first = ingest({ ...base, raw: { text: 'COMPRA EURUSD', externalMessageId: 'm1' } }, ctx());
  assert.equal(first.kind, 'ACCEPTED');
  if (first.kind !== 'ACCEPTED') return;
  const second = ingest(
    { ...base, raw: { text: 'COMPRA EURUSD', externalMessageId: 'm2' } },
    ctx([first.signal]),
  );
  assert.equal(second.kind, 'ACCEPTED');
});

test('edicao da mesma mensagem gera nova versao e substitui a anterior', () => {
  const first = ingest({ ...base, raw: { text: 'COMPRA EURUSD', externalMessageId: 'm1' } }, ctx());
  assert.equal(first.kind, 'ACCEPTED');
  if (first.kind !== 'ACCEPTED') return;
  const edited = ingest(
    {
      ...base,
      side: 'SELL',
      stopLoss: 1.087,
      takeProfit: 1.082,
      raw: { text: 'CORRECAO: VENDA EURUSD', externalMessageId: 'm1' },
    },
    ctx([first.signal]),
  );
  assert.equal(edited.kind, 'ACCEPTED');
  if (edited.kind !== 'ACCEPTED') return;
  assert.equal(edited.signal.version, 2);
  assert.equal(edited.supersededId, first.signal.id);
});

test('cancelamento encontra o sinal original', () => {
  const first = ingest({ ...base, raw: { text: 'COMPRA EURUSD', externalMessageId: 'm1' } }, ctx());
  if (first.kind !== 'ACCEPTED') throw new Error('esperado ACCEPTED');
  const cancel = ingest(
    { sourceId: 'src1', parsedBy: 'GENERATOR', action: 'CANCEL', raw: { text: 'CANCELADO', externalMessageId: 'm1' } },
    ctx([first.signal]),
  );
  assert.equal(cancel.kind, 'CANCELLATION');
});

test('stop do lado errado torna o sinal ambiguo', () => {
  const outcome = ingest(
    { ...base, stopLoss: 1.09, raw: { text: 'COMPRA EURUSD', externalMessageId: 'm2' } },
    ctx(),
  );
  assert.equal(outcome.kind, 'ACCEPTED');
  if (outcome.kind !== 'ACCEPTED') return;
  assert.equal(outcome.signal.status, 'AMBIGUOUS');
  assert.ok(outcome.signal.issues.some((i) => i.code === 'STOP_INVERTIDO'));
});

test('interpretacao com confianca baixa nao produz sinal valido', () => {
  const outcome = ingest(
    {
      ...base,
      parsedBy: 'AI_ASSISTED',
      parserConfidence: 0.4,
      raw: { text: 'acho que da pra comprar ou vender', externalMessageId: 'm3' },
    },
    ctx(),
  );
  assert.equal(outcome.kind, 'ACCEPTED');
  if (outcome.kind !== 'ACCEPTED') return;
  assert.equal(outcome.signal.status, 'AMBIGUOUS');
});

test('instrumento fora do escopo e recusado', () => {
  const outcome = ingest(
    { ...base, symbol: 'PETR4', entryPrice: 38.2, stopLoss: 37, takeProfit: 40, raw: { text: 'COMPRA PETR4', externalMessageId: 'm4' } },
    ctx(),
  );
  assert.equal(outcome.kind, 'REJECTED');
});

test('idade maxima marca o sinal como expirado', () => {
  const outcome = ingest({ ...base, raw: { text: 'COMPRA EURUSD', externalMessageId: 'm5' } }, ctx());
  if (outcome.kind !== 'ACCEPTED') throw new Error('esperado ACCEPTED');
  const later = '2026-09-14T14:40:00.000Z';
  const refreshed = refreshSignalStatus(outcome.signal, later, 20);
  assert.equal(refreshed.status, 'EXPIRED');
});

test('parser de texto livre detecta contradicao e baixa a confianca', () => {
  const draft = parseFreeText('galera, pode comprar EURUSD mas quem quiser vender tambem serve');
  assert.equal(draft.side, null);
  assert.ok(draft.confidence < 0.75);
});

test('parser de texto livre extrai campos de uma mensagem tipica', () => {
  const draft = parseFreeText('COMPRA EURUSD M15 entrada: 1.0850 SL: 1.0830 TP: 1.0880');
  assert.equal(draft.side, 'BUY');
  assert.equal(draft.symbol, 'EURUSD');
  assert.equal(draft.entryPrice, 1.085);
  assert.equal(draft.stopLoss, 1.083);
  assert.equal(draft.takeProfit, 1.088);
  assert.equal(draft.timeframeMinutes, 15);
});

test('validacao e deterministica: mesma entrada, mesmo resultado', () => {
  const signal: Signal = {
    id: 'sig1',
    sourceId: 'src1',
    independenceGroupId: 'g1',
    raw: { text: 'x', externalMessageId: null },
    parsedBy: 'MANUAL',
    parserConfidence: null,
    market: 'FX_SPOT',
    symbol: 'EURUSD',
    venue: 'REGULAR',
    broker: null,
    side: 'BUY',
    emittedAt: NOW,
    receivedAt: NOW,
    entryAt: null,
    timezone: 'UTC',
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
  };
  const a = validateSignal(signal, NOW);
  const b = validateSignal(signal, NOW);
  assert.deepEqual(a, b);
});
