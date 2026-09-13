import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Engine } from '../src/engine/engine.ts';
import { Store } from '../src/infra/store.ts';
import { seed } from '../src/seed.ts';
import { FakeClock } from '../src/core/time.ts';

const dir = mkdtempSync(join(tmpdir(), 'conv-'));
after(() => {
  // No Windows o arquivo pode continuar preso por um instante apos o close.
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    // Sobra de arquivo temporario nao invalida o teste.
  }
});

function dbPath(name: string): string {
  return join(dir, `${name}.db`);
}

const signalPayload = {
  sourceId: 'src_alfa',
  raw: { text: 'COMPRA EURUSD M15 entrada: 1.0850', externalMessageId: 'm-persist-1' },
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

test('banco vazio devolve hydrate false', () => {
  const store = new Store(dbPath('vazio'));
  const engine = new Engine({ store, clock: new FakeClock('2026-09-14T14:00:00.000Z') });
  assert.equal(engine.hydrate(), false);
  store.close();
});

test('fontes, sinais e eventos sobrevivem ao reinicio', () => {
  const path = dbPath('reinicio');
  const clock = new FakeClock('2026-09-14T14:00:00.000Z');

  const store1 = new Store(path);
  const engine1 = new Engine({ store: store1, clock });
  seed(engine1);
  engine1.ingestSignal(signalPayload);
  engine1.ingestSignal({ ...signalPayload, sourceId: 'src_beta', raw: { ...signalPayload.raw, externalMessageId: 'm-persist-2' } });
  engine1.persistRuntime(true);
  store1.close();

  const store2 = new Store(path);
  const engine2 = new Engine({ store: store2, clock });
  assert.equal(engine2.hydrate(), true);
  assert.equal(engine2.sources.length, 7);
  assert.equal(engine2.sources.find((s) => s.id === 'src_alfa')?.name, 'Sala Alfa FX');
  assert.ok(engine2.signals.some((s) => s.raw.externalMessageId === 'm-persist-1'));
  assert.ok(engine2.signals.some((s) => s.raw.externalMessageId === 'm-persist-2'));
  assert.ok(engine2.events.length > 0);
  store2.close();
});

test('configuracoes e modo sobrevivem ao reinicio', () => {
  const path = dbPath('config');
  const clock = new FakeClock('2026-09-14T14:00:00.000Z');

  const store1 = new Store(path);
  const engine1 = new Engine({ store: store1, clock });
  seed(engine1);
  engine1.setMode('SEMI_AUTO');
  engine1.updateConvergenceSettings({ minAgreeingSources: 5, minAgreementPercent: 90 });
  engine1.updateRiskSettings({ maxOpenPositions: 4 });
  engine1.setAutomationPaused(true);
  store1.close();

  const store2 = new Store(path);
  const engine2 = new Engine({ store: store2, clock });
  engine2.hydrate();
  assert.equal(engine2.mode, 'SEMI_AUTO');
  assert.equal(engine2.automationPaused, true);
  assert.equal(engine2.convergenceSettings.minAgreeingSources, 5);
  assert.equal(engine2.convergenceSettings.minAgreementPercent, 90);
  assert.equal(engine2.riskSettings.maxOpenPositions, 4);
  store2.close();
});

test('saldo, posicoes e resultado do dia sobrevivem ao reinicio', async () => {
  const path = dbPath('conta');
  const clock = new FakeClock('2026-09-14T14:00:00.000Z');

  const store1 = new Store(path);
  const engine1 = new Engine({ store: store1, clock });
  seed(engine1);
  await engine1.setConnected(true);
  engine1.riskSettings = { ...engine1.riskSettings, tradingDays: [1, 2, 3, 4, 5, 6, 7] };
  engine1.setMode('AUTO');

  for (const sourceId of ['src_alfa', 'src_beta', 'src_gama']) {
    engine1.ingestSignal({
      ...signalPayload,
      sourceId,
      raw: { ...signalPayload.raw, externalMessageId: `m-${sourceId}` },
    });
  }
  engine1.runPipeline();
  await engine1.flush();

  const openBefore = engine1.broker.getPositions().filter((p) => p.status === 'OPEN');
  assert.equal(openBefore.length, 1, 'o cenario precisa abrir exatamente uma posicao');
  const balanceBefore = engine1.broker.getAccount().balance;
  const tradesBefore = engine1.day.tradesToday;
  const ordersBefore = engine1.orders.length;

  engine1.persistRuntime(true);
  store1.close();

  const store2 = new Store(path);
  const engine2 = new Engine({ store: store2, clock });
  engine2.hydrate();
  const openAfter = engine2.broker.getPositions().filter((p) => p.status === 'OPEN');

  assert.equal(openAfter.length, 1);
  assert.equal(openAfter[0]?.id, openBefore[0]?.id);
  assert.equal(openAfter[0]?.openPrice, openBefore[0]?.openPrice);
  assert.equal(engine2.broker.getAccount().balance, balanceBefore);
  assert.equal(engine2.day.tradesToday, tradesBefore);
  assert.equal(engine2.orders.length, ordersBefore);
  store2.close();
});

test('idempotencia da ordem sobrevive ao reinicio', async () => {
  const path = dbPath('idempotencia');
  const clock = new FakeClock('2026-09-14T14:00:00.000Z');

  const store1 = new Store(path);
  const engine1 = new Engine({ store: store1, clock });
  seed(engine1);
  await engine1.setConnected(true);
  engine1.riskSettings = { ...engine1.riskSettings, tradingDays: [1, 2, 3, 4, 5, 6, 7] };
  engine1.setMode('AUTO');
  for (const sourceId of ['src_alfa', 'src_beta', 'src_gama']) {
    engine1.ingestSignal({
      ...signalPayload,
      sourceId,
      raw: { ...signalPayload.raw, externalMessageId: `m-${sourceId}` },
    });
  }
  engine1.runPipeline();
  await engine1.flush();
  const clientOrderId = engine1.orders[0]?.clientOrderId;
  assert.ok(clientOrderId);
  engine1.persistRuntime(true);
  store1.close();

  const store2 = new Store(path);
  const engine2 = new Engine({ store: store2, clock });
  engine2.hydrate();
  await engine2.setConnected(true);
  const known = await engine2.broker.findByClientOrderId(clientOrderId);
  assert.ok(known, 'a chave de cliente precisa continuar conhecida apos o reinicio');
  assert.ok(known.status === 'FILLED' || known.status === 'DUPLICATE');
  store2.close();
});

test('oportunidade vencida durante a parada volta como expirada', async () => {
  const path = dbPath('expira');
  const clock = new FakeClock('2026-09-14T14:00:00.000Z');

  const store1 = new Store(path);
  const engine1 = new Engine({ store: store1, clock });
  seed(engine1);
  await engine1.setConnected(true);
  for (const sourceId of ['src_alfa', 'src_beta', 'src_gama']) {
    engine1.ingestSignal({
      ...signalPayload,
      sourceId,
      raw: { ...signalPayload.raw, externalMessageId: `m-${sourceId}` },
    });
  }
  engine1.runPipeline();
  const published = engine1.opportunities[0];
  assert.ok(published);
  assert.ok(published.status === 'PUBLISHED' || published.status === 'UPDATED');
  engine1.persistRuntime(true);
  store1.close();

  // O processo fica fora do ar por uma hora.
  const later = new FakeClock('2026-09-14T15:00:00.000Z');
  const store2 = new Store(path);
  const engine2 = new Engine({ store: store2, clock: later });
  engine2.hydrate();
  assert.equal(engine2.opportunities.find((o) => o.id === published.id)?.status, 'EXPIRED');
  store2.close();
});

test('reinicio do ambiente apaga o banco e semeia de novo', () => {
  const path = dbPath('reset');
  const clock = new FakeClock('2026-09-14T14:00:00.000Z');
  const store = new Store(path);
  const engine = new Engine({ store, clock });
  seed(engine);
  engine.ingestSignal(signalPayload);
  engine.updateConvergenceSettings({ minAgreeingSources: 9 });

  engine.resetEnvironment(seed);

  assert.equal(engine.convergenceSettings.minAgreeingSources, 3, 'volta ao valor sugerido');
  assert.equal(engine.sources.length, 7);
  assert.equal(engine.signals.length, 0);
  assert.equal(store.counts().signals, 0);
  store.close();
});

test('esquema mais novo que o codigo e recusado', async () => {
  const path = dbPath('versao');
  const store = new Store(path);
  store.close();

  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(path);
  raw.prepare('UPDATE schema_meta SET version = 999 WHERE id = 1').run();
  raw.close();

  assert.throws(() => new Store(path), /versao 999/);
});
