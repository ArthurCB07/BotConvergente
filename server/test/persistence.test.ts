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

const clockAt = () => new FakeClock('2026-09-14T14:00:00.000Z');

const forexSignal = {
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

const cryptoSignal = {
  sourceId: 'src_satoshi',
  raw: { text: 'COMPRA BTCUSDT M15 entrada: 72500', externalMessageId: 'm-crypto-1' },
  parsedBy: 'GENERATOR' as const,
  symbol: 'BTCUSDT',
  venue: 'REGULAR' as const,
  side: 'BUY' as const,
  timeframeMinutes: 15,
  horizonMinutes: 60,
  entryType: 'LIMIT' as const,
  entryPrice: 72_500,
  stopLoss: 71_400,
  takeProfit: 74_300,
};

test('banco vazio devolve hydrate false', () => {
  const store = new Store(dbPath('vazio'));
  const engine = new Engine({ store, clock: clockAt() });
  assert.equal(engine.hydrate(), false);
  store.close();
});

test('fontes com mercados, sinais e eventos sobrevivem ao reinicio', () => {
  const path = dbPath('reinicio');
  const store1 = new Store(path);
  const engine1 = new Engine({ store: store1, clock: clockAt() });
  seed(engine1);
  engine1.ingestSignal(forexSignal);
  engine1.ingestSignal(cryptoSignal);
  engine1.persistRuntime(true);
  store1.close();

  const store2 = new Store(path);
  const engine2 = new Engine({ store: store2, clock: clockAt() });
  assert.equal(engine2.hydrate(), true);
  assert.equal(engine2.sources.find((s) => s.id === 'src_alfa')?.name, 'Sala Alfa FX');
  assert.deepEqual(engine2.sources.find((s) => s.id === 'src_alfa')?.markets, ['FOREX']);
  assert.deepEqual(engine2.sources.find((s) => s.id === 'src_global')?.markets, ['FOREX', 'CRYPTO']);
  assert.equal(
    engine2.signals.find((s) => s.raw.externalMessageId === 'm-persist-1')?.marketId,
    'FOREX',
  );
  assert.equal(
    engine2.signals.find((s) => s.raw.externalMessageId === 'm-crypto-1')?.marketId,
    'CRYPTO',
  );
  store2.close();
});

test('configuracoes, modo e automacao de cada mercado sobrevivem separadamente', () => {
  const path = dbPath('config');
  const store1 = new Store(path);
  const engine1 = new Engine({ store: store1, clock: clockAt() });
  seed(engine1);
  engine1.setMode('FOREX', 'SEMI_AUTO');
  engine1.setMode('CRYPTO', 'AUTO');
  engine1.setAutomationEnabled('CRYPTO', true);
  engine1.updateConvergenceSettings('FOREX', { minAgreeingSources: 5 });
  engine1.updateConvergenceSettings('CRYPTO', { minAgreementPercent: 90 });
  engine1.updateRiskSettings('CRYPTO', { maxOpenPositions: 4 });
  engine1.updateGlobalRiskSettings({ maxOpenPositionsTotal: 7 });
  engine1.setGlobalPaused(true);
  store1.close();

  const store2 = new Store(path);
  const engine2 = new Engine({ store: store2, clock: clockAt() });
  engine2.hydrate();
  assert.equal(engine2.markets.FOREX.mode, 'SEMI_AUTO');
  assert.equal(engine2.markets.CRYPTO.mode, 'AUTO');
  assert.equal(engine2.markets.FOREX.automationEnabled, false);
  assert.equal(engine2.markets.CRYPTO.automationEnabled, true);
  assert.equal(engine2.markets.FOREX.convergence.minAgreeingSources, 5);
  assert.equal(engine2.markets.CRYPTO.convergence.minAgreeingSources, 3, 'nao vazou de um mercado para o outro');
  assert.equal(engine2.markets.CRYPTO.convergence.minAgreementPercent, 90);
  assert.equal(engine2.markets.CRYPTO.risk.maxOpenPositions, 4);
  assert.equal(engine2.markets.FOREX.risk.maxOpenPositions, 1);
  assert.equal(engine2.globalRisk.maxOpenPositionsTotal, 7);
  assert.equal(engine2.globalPaused, true);
  store2.close();
});

test('saldo, posicoes e resultado do dia sobrevivem ao reinicio', async () => {
  const path = dbPath('conta');
  const store1 = new Store(path);
  const engine1 = new Engine({ store: store1, clock: clockAt() });
  seed(engine1);
  await engine1.connectAll();
  engine1.markets.CRYPTO.automationEnabled = true;
  engine1.setMode('CRYPTO', 'AUTO');

  for (const sourceId of ['src_satoshi', 'src_altseason', 'src_onchain']) {
    engine1.ingestSignal({
      ...cryptoSignal,
      sourceId,
      raw: { ...cryptoSignal.raw, externalMessageId: `m-${sourceId}` },
    });
  }
  engine1.runPipeline();
  await engine1.flush();

  const openBefore = engine1.openPositionsOf('CRYPTO');
  assert.equal(openBefore.length, 1, 'o cenario precisa abrir exatamente uma posicao de cripto');
  const balanceBefore = engine1.brokerFor('CRYPTO').getAccount().balance;
  const tradesBefore = engine1.markets.CRYPTO.day.tradesToday;

  engine1.persistRuntime(true);
  store1.close();

  const store2 = new Store(path);
  const engine2 = new Engine({ store: store2, clock: clockAt() });
  engine2.hydrate();
  const openAfter = engine2.openPositionsOf('CRYPTO');
  assert.equal(openAfter.length, 1);
  assert.equal(openAfter[0]?.id, openBefore[0]?.id);
  assert.equal(openAfter[0]?.marketId, 'CRYPTO');
  assert.equal(engine2.brokerFor('CRYPTO').getAccount().balance, balanceBefore);
  assert.equal(engine2.markets.CRYPTO.day.tradesToday, tradesBefore);
  store2.close();
});

test('oportunidade vencida durante a parada volta como expirada', async () => {
  const path = dbPath('expira');
  const store1 = new Store(path);
  const engine1 = new Engine({ store: store1, clock: clockAt() });
  seed(engine1);
  await engine1.connectAll();
  for (const sourceId of ['src_alfa', 'src_beta', 'src_gama']) {
    engine1.ingestSignal({
      ...forexSignal,
      sourceId,
      raw: { ...forexSignal.raw, externalMessageId: `m-${sourceId}` },
    });
  }
  engine1.runPipeline();
  const published = engine1.opportunities[0];
  assert.ok(published);
  engine1.persistRuntime(true);
  store1.close();

  const store2 = new Store(path);
  const engine2 = new Engine({ store: store2, clock: new FakeClock('2026-09-14T15:00:00.000Z') });
  engine2.hydrate();
  assert.equal(engine2.opportunities.find((o) => o.id === published.id)?.status, 'EXPIRED');
  store2.close();
});

test('reinicio do ambiente apaga o banco e semeia os dois mercados', () => {
  const path = dbPath('reset');
  const store = new Store(path);
  const engine = new Engine({ store, clock: clockAt() });
  seed(engine);
  engine.ingestSignal(forexSignal);
  engine.updateConvergenceSettings('CRYPTO', { minAgreeingSources: 9 });

  engine.resetEnvironment(seed);

  assert.equal(engine.markets.CRYPTO.convergence.minAgreeingSources, 3, 'volta ao valor sugerido');
  assert.equal(engine.signals.length, 0);
  assert.ok(engine.sources.some((s) => s.markets.includes('CRYPTO')));
  assert.ok(engine.sources.some((s) => s.markets.includes('FOREX')));
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

// --- Migracao da versao 1 (um mercado) para a versao 2 (dois mercados) -------

test('banco da versao 1 migra para Forex preservando os dados', async () => {
  const path = dbPath('migracao');
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(path);
  raw.exec(`
    CREATE TABLE schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE sources (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, enabled INTEGER NOT NULL, independence_group_id TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE signals (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, symbol TEXT, venue TEXT, side TEXT, status TEXT NOT NULL, received_at TEXT NOT NULL, external_message_id TEXT, data TEXT NOT NULL);
    CREATE TABLE opportunities (id TEXT PRIMARY KEY, cluster_key TEXT NOT NULL, symbol TEXT NOT NULL, venue TEXT NOT NULL, side TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL, agreement_percent REAL NOT NULL, created_at TEXT NOT NULL, valid_until TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE orders (id TEXT PRIMARY KEY, client_order_id TEXT NOT NULL, opportunity_id TEXT, symbol TEXT NOT NULL, side TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE positions (id TEXT PRIMARY KEY, order_id TEXT NOT NULL, opportunity_id TEXT, symbol TEXT NOT NULL, side TEXT NOT NULL, status TEXT NOT NULL, opened_at TEXT NOT NULL, closed_at TEXT, close_reason TEXT, net_pnl REAL NOT NULL, data TEXT NOT NULL);
    CREATE TABLE events (id TEXT PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL, severity TEXT NOT NULL, title TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
  `);
  raw.prepare('INSERT INTO schema_meta (id, version, created_at) VALUES (1, 1, ?)').run('2026-09-13T00:00:00.000Z');
  raw
    .prepare('INSERT INTO sources (id, name, kind, enabled, independence_group_id, created_at, data) VALUES (?,?,?,?,?,?,?)')
    .run(
      'src_v1',
      'Sala Antiga',
      'GENERATOR',
      1,
      'g_v1',
      '2026-09-13T00:00:00.000Z',
      JSON.stringify({
        id: 'src_v1',
        name: 'Sala Antiga',
        kind: 'GENERATOR',
        enabled: true,
        tags: ['legado'],
        independenceGroupId: 'g_v1',
        weight: 2,
        notes: 'cadastro da versao 1',
        createdAt: '2026-09-13T00:00:00.000Z',
        stats: { received: 9, valid: 7, rejected: 2, lastSignalAt: null },
      }),
    );
  raw
    .prepare('INSERT INTO signals (id, source_id, symbol, venue, side, status, received_at, external_message_id, data) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(
      'sig_v1',
      'src_v1',
      'EURUSD',
      'REGULAR',
      'BUY',
      'VALID',
      '2026-09-13T12:00:00.000Z',
      'msg-v1',
      JSON.stringify({ id: 'sig_v1', sourceId: 'src_v1', symbol: 'EURUSD', market: 'FX_SPOT', raw: { text: 'x', externalMessageId: 'msg-v1' } }),
    );
  raw
    .prepare('INSERT INTO positions (id, order_id, opportunity_id, symbol, side, status, opened_at, closed_at, close_reason, net_pnl, data) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(
      'pos_v1',
      'ord_v1',
      null,
      'EURUSD',
      'BUY',
      'CLOSED',
      '2026-09-13T12:00:00.000Z',
      '2026-09-13T13:00:00.000Z',
      'TAKE_PROFIT',
      71,
      JSON.stringify({ id: 'pos_v1', symbol: 'EURUSD', lots: 0.25, netPnl: 71 }),
    );
  raw
    .prepare('INSERT INTO kv (key, value, updated_at) VALUES (?,?,?)')
    .run('settings.risk', JSON.stringify({ sizingMode: 'FIXED_LOTS', fixedLots: 0.07, maxOpenPositions: 2 }), '2026-09-13T00:00:00.000Z');
  raw
    .prepare('INSERT INTO kv (key, value, updated_at) VALUES (?,?,?)')
    .run('runtime.mode', JSON.stringify('SEMI_AUTO'), '2026-09-13T00:00:00.000Z');
  raw.close();

  const store = new Store(path);
  assert.ok(store.lastMigration, 'a migracao precisa ter rodado');
  assert.equal(store.lastMigration?.fromVersion, 1);
  assert.equal(store.lastMigration?.toVersion, 2);

  const migratedSource = store.loadSources()[0];
  assert.deepEqual(migratedSource?.markets, ['FOREX'], 'a base da versao 1 era toda de forex');
  assert.equal(migratedSource?.weightByMarket.FOREX, 2, 'o peso antigo foi preservado');
  assert.equal(migratedSource?.notes, 'cadastro da versao 1');
  assert.equal(migratedSource?.stats.received, 9);

  const migratedSignal = store.loadSignals()[0];
  assert.equal(migratedSignal?.marketId, 'FOREX');
  assert.equal(migratedSignal?.productType, 'FX_SPOT');

  const migratedPosition = store.loadPositions()[0];
  assert.equal(migratedPosition?.marketId, 'FOREX');
  assert.equal(migratedPosition?.quantity, 0.25, 'lots virou quantity sem perder o valor');

  const risk = store.get<Record<string, unknown>>('settings.risk.FOREX');
  assert.equal(risk?.fixedQuantity, 0.07);
  assert.equal(risk?.sizingMode, 'FIXED_QUANTITY');
  assert.equal(store.get('settings.risk'), undefined, 'a chave antiga sai do banco');

  const runtime = store.get<Record<string, unknown>>('runtime.market.FOREX');
  assert.equal(runtime?.mode, 'SEMI_AUTO');
  assert.equal(runtime?.automationEnabled, false, 'automacao nasce desligada apos migrar');

  // O motor carrega o banco migrado sem erro e com cripto zerado.
  const engine = new Engine({ store, clock: clockAt() });
  assert.equal(engine.hydrate(), true);
  assert.equal(engine.markets.FOREX.mode, 'SEMI_AUTO');
  assert.equal(engine.markets.CRYPTO.mode, 'OBSERVE');
  assert.equal(engine.markets.FOREX.risk.fixedQuantity, 0.07);
  store.close();
});

test('registro de mercado incerto fica sem classificacao em vez de ser descartado', async () => {
  const path = dbPath('incerto');
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(path);
  raw.exec(`
    CREATE TABLE schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE sources (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, enabled INTEGER NOT NULL, independence_group_id TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE signals (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, symbol TEXT, venue TEXT, side TEXT, status TEXT NOT NULL, received_at TEXT NOT NULL, external_message_id TEXT, data TEXT NOT NULL);
    CREATE TABLE opportunities (id TEXT PRIMARY KEY, cluster_key TEXT NOT NULL, symbol TEXT NOT NULL, venue TEXT NOT NULL, side TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL, agreement_percent REAL NOT NULL, created_at TEXT NOT NULL, valid_until TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE orders (id TEXT PRIMARY KEY, client_order_id TEXT NOT NULL, opportunity_id TEXT, symbol TEXT NOT NULL, side TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE positions (id TEXT PRIMARY KEY, order_id TEXT NOT NULL, opportunity_id TEXT, symbol TEXT NOT NULL, side TEXT NOT NULL, status TEXT NOT NULL, opened_at TEXT NOT NULL, closed_at TEXT, close_reason TEXT, net_pnl REAL NOT NULL, data TEXT NOT NULL);
    CREATE TABLE events (id TEXT PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL, severity TEXT NOT NULL, title TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
  `);
  raw.prepare('INSERT INTO schema_meta (id, version, created_at) VALUES (1, 1, ?)').run('2026-09-13T00:00:00.000Z');
  raw
    .prepare('INSERT INTO sources (id, name, kind, enabled, independence_group_id, created_at, data) VALUES (?,?,?,?,?,?,?)')
    .run(
      'src_duvida',
      'Sala Duvidosa',
      'GENERATOR',
      1,
      'g_duvida',
      '2026-09-13T00:00:00.000Z',
      JSON.stringify({ id: 'src_duvida', name: 'Sala Duvidosa', kind: 'GENERATOR', enabled: true, tags: [], independenceGroupId: 'g_duvida', weight: 1, notes: '', createdAt: '2026-09-13T00:00:00.000Z', stats: { received: 3, valid: 1, rejected: 2, lastSignalAt: null } }),
    );
  // Instrumento que nao existe em nenhum dos catalogos atuais.
  raw
    .prepare('INSERT INTO signals (id, source_id, symbol, venue, side, status, received_at, external_message_id, data) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('sig_x', 'src_duvida', 'XAUUSD', 'REGULAR', 'BUY', 'VALID', '2026-09-13T12:00:00.000Z', 'mx', JSON.stringify({ id: 'sig_x', symbol: 'XAUUSD' }));
  raw.close();

  const store = new Store(path);
  assert.deepEqual(store.lastMigration?.sourcesNeedingClassification, ['Sala Duvidosa']);
  const migrated = store.loadSources()[0];
  assert.deepEqual(migrated?.markets, [], 'sem mercado ate o usuario classificar');
  assert.equal(store.loadSignals().length, 1, 'o sinal nao foi descartado');
  store.close();
});
