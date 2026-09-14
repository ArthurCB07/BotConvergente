import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Engine } from '../src/engine/engine.ts';
import { seed } from '../src/seed.ts';
import { FakeClock } from '../src/core/time.ts';
import type { MarketId, Side } from '../src/core/types.ts';

/**
 * Validacoes ponta a ponta da separacao entre Forex e Cripto.
 *
 * Segunda-feira, 14:00 UTC = 11:00 em America/Sao_Paulo: dentro da janela padrao
 * de forex e, obviamente, dentro da janela de cripto (24 horas).
 */
const NOW = '2026-09-14T14:00:00.000Z';

const FOREX_TRIO = ['src_alfa', 'src_beta', 'src_gama'];
const CRYPTO_TRIO = ['src_satoshi', 'src_altseason', 'src_onchain'];

function buildEngine(options: { balance?: number } = {}): Engine {
  const engine = new Engine({
    clock: new FakeClock(NOW),
    initialBalance: options.balance ?? 10_000,
    cryptoInitialBalance: options.balance ?? 5_000,
  });
  seed(engine);
  return engine;
}

function emit(
  engine: Engine,
  sourceId: string,
  symbol: string,
  side: Side,
  overrides: Record<string, unknown> = {},
): void {
  const prices: Record<string, { entry: number; stop: number; target: number }> = {
    EURUSD: { entry: 1.085, stop: 1.083, target: 1.088 },
    GBPUSD: { entry: 1.268, stop: 1.266, target: 1.271 },
    BTCUSDT: { entry: 72_500, stop: 71_400, target: 74_300 },
    'BTCUSDT-PERP': { entry: 72_520, stop: 71_420, target: 74_320 },
    ETHUSDT: { entry: 3_850, stop: 3_790, target: 3_950 },
  };
  const p = prices[symbol];
  if (!p) throw new Error(`preco de teste ausente para ${symbol}`);
  const stop = side === 'BUY' ? p.stop : p.target;
  const target = side === 'BUY' ? p.target : p.stop;
  engine.ingestSignal({
    sourceId,
    raw: { text: `${side} ${symbol}`, externalMessageId: `m-${sourceId}-${symbol}-${side}` },
    parsedBy: 'GENERATOR',
    symbol,
    venue: 'REGULAR',
    side,
    emittedAt: NOW,
    timeframeMinutes: 15,
    horizonMinutes: 60,
    entryType: 'LIMIT',
    entryPrice: p.entry,
    stopLoss: stop,
    takeProfit: target,
    ...overrides,
  });
}

async function arm(engine: Engine, marketId: MarketId): Promise<void> {
  await engine.connectAll();
  engine.setMode(marketId, 'AUTO');
  engine.setAutomationEnabled(marketId, true);
}

// --- 1 e 2: isolamento da concordancia --------------------------------------

test('adicionar fontes e sinais de Cripto nao altera a concordancia de Forex', () => {
  const engine = buildEngine();
  for (const sourceId of ['src_alfa', 'src_beta']) emit(engine, sourceId, 'EURUSD', 'BUY');
  engine.runPipeline();
  const antes = engine.evaluations.FOREX.find((e) => e.symbol === 'EURUSD');
  assert.ok(antes);
  const participantesAntes = antes.participantCount;
  const concordantesAntes = antes.agreeingCount;

  for (const sourceId of [...CRYPTO_TRIO, 'src_cryptoscalp', 'src_whale']) {
    emit(engine, sourceId, 'BTCUSDT', 'BUY');
  }
  engine.runPipeline();

  const depois = engine.evaluations.FOREX.find((e) => e.symbol === 'EURUSD');
  assert.ok(depois);
  assert.equal(depois.participantCount, participantesAntes);
  assert.equal(depois.agreeingCount, concordantesAntes);
  assert.equal(depois.meetsCriteria, false, 'duas fontes seguem abaixo do minimo de tres');
  assert.ok(
    engine.evaluations.CRYPTO.some((e) => e.symbol === 'BTCUSDT' && e.meetsCriteria),
    'cripto publica a sua propria convergencia',
  );
});

test('adicionar fontes e sinais de Forex nao altera a concordancia de Cripto', () => {
  const engine = buildEngine();
  for (const sourceId of ['src_satoshi', 'src_altseason']) emit(engine, sourceId, 'BTCUSDT', 'BUY');
  engine.runPipeline();
  const antes = engine.evaluations.CRYPTO.find((e) => e.symbol === 'BTCUSDT');
  assert.ok(antes);

  for (const sourceId of [...FOREX_TRIO, 'src_delta']) emit(engine, sourceId, 'EURUSD', 'BUY');
  engine.runPipeline();

  const depois = engine.evaluations.CRYPTO.find((e) => e.symbol === 'BTCUSDT');
  assert.ok(depois);
  assert.equal(depois.participantCount, antes.participantCount);
  assert.equal(depois.agreeingCount, antes.agreeingCount);
  assert.equal(depois.meetsCriteria, false);
});

// --- 3: produtos incompativeis ----------------------------------------------

test('sinais de produtos incompativeis nao convergem juntos', () => {
  const engine = buildEngine();
  emit(engine, 'src_satoshi', 'BTCUSDT', 'BUY');
  emit(engine, 'src_altseason', 'BTCUSDT', 'BUY');
  emit(engine, 'src_perpdesk', 'BTCUSDT-PERP', 'BUY');
  emit(engine, 'src_whale', 'BTCUSDT-PERP', 'BUY');
  engine.runPipeline();

  const spot = engine.evaluations.CRYPTO.find((e) => e.productType === 'CRYPTO_SPOT');
  const perp = engine.evaluations.CRYPTO.find((e) => e.productType === 'CRYPTO_PERP');
  assert.ok(spot && perp, 'dois agrupamentos distintos');
  assert.equal(spot.participantCount, 2);
  assert.equal(perp.participantCount, 2);
  assert.equal(spot.meetsCriteria, false);
  assert.equal(perp.meetsCriteria, false);
  assert.equal(engine.opportunities.length, 0);
});

test('sinal de mercado fora do cadastro da fonte nao vota em lugar nenhum', () => {
  const engine = buildEngine();
  // src_alfa e cadastrada apenas para Forex.
  emit(engine, 'src_alfa', 'BTCUSDT', 'BUY');
  emit(engine, 'src_satoshi', 'BTCUSDT', 'BUY');
  emit(engine, 'src_altseason', 'BTCUSDT', 'BUY');
  engine.runPipeline();

  const crypto = engine.evaluations.CRYPTO.find((e) => e.symbol === 'BTCUSDT');
  assert.ok(crypto);
  assert.equal(crypto.agreeingCount, 2, 'o voto da fonte de forex nao conta');
  const rejeitado = engine.signals.find((s) => s.sourceId === 'src_alfa' && s.symbol === 'BTCUSDT');
  assert.equal(rejeitado?.status, 'MARKET_MISMATCH');
  assert.equal(engine.evaluations.FOREX.length, 0, 'tambem nao vaza para forex');
});

test('classificar a fonte resgata sinais que estavam fora do mercado', () => {
  const engine = buildEngine();
  emit(engine, 'src_alfa', 'BTCUSDT', 'BUY');
  assert.equal(
    engine.signals.find((s) => s.sourceId === 'src_alfa' && s.symbol === 'BTCUSDT')?.status,
    'MARKET_MISMATCH',
  );
  engine.updateSource('src_alfa', { markets: ['FOREX', 'CRYPTO'] });
  assert.equal(
    engine.signals.find((s) => s.sourceId === 'src_alfa' && s.symbol === 'BTCUSDT')?.status,
    'VALID',
    'o sinal preservado volta a valer quando a fonte e classificada',
  );
});

// --- 4 e 7: automacao independente ------------------------------------------

test('cada automacao liga e desliga sem afetar a outra', async () => {
  const engine = buildEngine();
  await engine.connectAll();
  engine.setMode('FOREX', 'AUTO');
  engine.setMode('CRYPTO', 'AUTO');
  engine.setAutomationEnabled('FOREX', false);
  engine.setAutomationEnabled('CRYPTO', true);

  for (const sourceId of FOREX_TRIO) emit(engine, sourceId, 'EURUSD', 'BUY');
  for (const sourceId of CRYPTO_TRIO) emit(engine, sourceId, 'BTCUSDT', 'BUY');
  engine.runPipeline();
  await engine.flush();

  const forexOpp = engine.opportunities.find((o) => o.marketId === 'FOREX');
  const cryptoOpp = engine.opportunities.find((o) => o.marketId === 'CRYPTO');
  assert.ok(forexOpp, 'Forex continua publicando oportunidade com a automacao desligada');
  assert.ok(cryptoOpp);

  assert.equal(
    engine.decisions.get(forexOpp.id)?.blocks.some((b) => b.code === 'AUTOMACAO_MERCADO_DESLIGADA'),
    true,
  );
  assert.equal(engine.orders.filter((o) => o.marketId === 'FOREX').length, 0);
  assert.equal(engine.orders.filter((o) => o.marketId === 'CRYPTO').length, 1);
});

test('desligar a automacao mantem a gestao das posicoes ja abertas', async () => {
  const engine = buildEngine();
  await arm(engine, 'CRYPTO');
  for (const sourceId of CRYPTO_TRIO) emit(engine, sourceId, 'BTCUSDT', 'BUY');
  engine.runPipeline();
  await engine.flush();
  assert.equal(engine.openPositionsOf('CRYPTO').length, 1);

  engine.setAutomationEnabled('CRYPTO', false);
  assert.equal(engine.openPositionsOf('CRYPTO').length, 1, 'a posicao nao e encerrada');

  // O alvo e atingido: a gestao continua rodando mesmo com a automacao desligada.
  engine.brokerFor('CRYPTO').nudge('BTCUSDT', 300);
  engine.tick(1);
  const fechada = engine
    .brokerFor('CRYPTO')
    .getPositions()
    .find((p) => p.status === 'CLOSED');
  assert.ok(fechada, 'a posicao foi encerrada pelo alvo');
  assert.equal(fechada.closeReason, 'TAKE_PROFIT');
  assert.ok(engine.markets.CRYPTO.day.realizedNetPnl > 0);
});

test('pausa global bloqueia os dois e nao encerra posicoes', async () => {
  const engine = buildEngine();
  await arm(engine, 'FOREX');
  await arm(engine, 'CRYPTO');
  for (const sourceId of CRYPTO_TRIO) emit(engine, sourceId, 'BTCUSDT', 'BUY');
  engine.runPipeline();
  await engine.flush();
  const abertasAntes = engine.allOpenPositions().length;
  assert.equal(abertasAntes, 1);

  engine.setGlobalPaused(true);
  for (const sourceId of FOREX_TRIO) emit(engine, sourceId, 'EURUSD', 'BUY');
  engine.runPipeline();
  await engine.flush();

  const forexOpp = engine.opportunities.find((o) => o.marketId === 'FOREX');
  assert.ok(forexOpp);
  assert.equal(
    engine.decisions.get(forexOpp.id)?.blocks.some((b) => b.code === 'PAUSA_GLOBAL'),
    true,
  );
  assert.equal(engine.orders.filter((o) => o.marketId === 'FOREX').length, 0);
  assert.equal(engine.allOpenPositions().length, abertasAntes, 'a pausa nao encerra posicoes');
});

// --- 5: execucao simultanea --------------------------------------------------

test('os dois mercados executam operacoes simuladas simultaneamente', async () => {
  const engine = buildEngine();
  await arm(engine, 'FOREX');
  await arm(engine, 'CRYPTO');
  engine.updateGlobalRiskSettings({ maxOpenPositionsTotal: 2 });

  for (const sourceId of FOREX_TRIO) emit(engine, sourceId, 'EURUSD', 'BUY');
  for (const sourceId of CRYPTO_TRIO) emit(engine, sourceId, 'BTCUSDT', 'BUY');
  engine.runPipeline();
  await engine.flush();

  const forexOrders = engine.orders.filter((o) => o.marketId === 'FOREX' && o.status === 'FILLED');
  const cryptoOrders = engine.orders.filter((o) => o.marketId === 'CRYPTO' && o.status === 'FILLED');
  assert.equal(forexOrders.length, 1);
  assert.equal(cryptoOrders.length, 1);
  assert.equal(forexOrders[0]?.quantityLabel, 'lote');
  assert.equal(cryptoOrders[0]?.quantityLabel, 'BTC');
  assert.equal(engine.allOpenPositions().length, 2);
  // Cada posicao carrega mercado, conta e oportunidade de origem.
  for (const position of engine.allOpenPositions()) {
    assert.ok(position.marketId);
    assert.ok(position.accountId);
    assert.ok(position.opportunityId);
  }
});

test('uma oportunidade de um mercado nunca dispara ordem no outro', async () => {
  const engine = buildEngine();
  await arm(engine, 'CRYPTO');
  engine.setAutomationEnabled('FOREX', false);
  for (const sourceId of CRYPTO_TRIO) emit(engine, sourceId, 'BTCUSDT', 'BUY');
  engine.runPipeline();
  await engine.flush();

  for (const order of engine.orders) {
    const opportunity = engine.opportunities.find((o) => o.id === order.opportunityId);
    assert.equal(order.marketId, opportunity?.marketId);
    assert.equal(order.marketId, 'CRYPTO');
  }
});

// --- 6: limites individuais e globais ---------------------------------------

test('limite individual bloqueia so o mercado dele', async () => {
  const engine = buildEngine();
  await arm(engine, 'FOREX');
  await arm(engine, 'CRYPTO');
  engine.updateGlobalRiskSettings({ enabled: false });

  // Stop diario de Forex atingido.
  engine.markets.FOREX.day.realizedNetPnl = -500;

  for (const sourceId of FOREX_TRIO) emit(engine, sourceId, 'EURUSD', 'BUY');
  for (const sourceId of CRYPTO_TRIO) emit(engine, sourceId, 'BTCUSDT', 'BUY');
  engine.runPipeline();
  await engine.flush();

  const forexOpp = engine.opportunities.find((o) => o.marketId === 'FOREX');
  assert.ok(forexOpp);
  assert.equal(
    engine.decisions.get(forexOpp.id)?.blocks.some((b) => b.code === 'STOP_DIARIO'),
    true,
  );
  assert.equal(engine.orders.filter((o) => o.marketId === 'FOREX').length, 0);
  assert.equal(
    engine.orders.filter((o) => o.marketId === 'CRYPTO' && o.status === 'FILLED').length,
    1,
    'cripto segue operando',
  );
});

test('limite global bloqueia os dois mercados', async () => {
  const engine = buildEngine();
  await arm(engine, 'FOREX');
  await arm(engine, 'CRYPTO');
  engine.updateGlobalRiskSettings({ enabled: true, maxOpenPositionsTotal: 1 });

  for (const sourceId of FOREX_TRIO) emit(engine, sourceId, 'EURUSD', 'BUY');
  engine.runPipeline();
  await engine.flush();
  assert.equal(engine.allOpenPositions().length, 1);

  for (const sourceId of CRYPTO_TRIO) emit(engine, sourceId, 'BTCUSDT', 'BUY');
  engine.runPipeline();
  await engine.flush();

  const cryptoOpp = engine.opportunities.find((o) => o.marketId === 'CRYPTO');
  assert.ok(cryptoOpp);
  const decision = engine.decisions.get(cryptoOpp.id);
  assert.ok(decision);
  const global = decision.blocks.find((b) => b.code === 'MAX_POSICOES_GLOBAL');
  assert.ok(global, 'bloqueio global presente');
  assert.equal(global.scope, 'GLOBAL');
  assert.equal(
    decision.checks.find((c) => c.code === 'MAX_POSICOES')?.passed,
    true,
    'o limite individual de cripto continua livre',
  );
  assert.equal(engine.allOpenPositions().length, 1);
});

// --- 8: saldo compartilhado --------------------------------------------------

test('reserva de margem impede comprometer o mesmo saldo duas vezes', () => {
  const engine = buildEngine({ balance: 1_000 });
  const broker = engine.brokerFor('FOREX');
  assert.equal(broker.reserveMargin('ordem-a', 700), true);
  assert.equal(broker.getAccount().reservedMargin, 700);
  assert.equal(broker.getAccount().freeMargin, 300);
  assert.equal(broker.reserveMargin('ordem-b', 700), false, 'a segunda nao cabe no que sobrou');
  broker.releaseMargin('ordem-a');
  assert.equal(broker.reserveMargin('ordem-b', 700), true, 'liberada a primeira, a segunda cabe');
});

test('ordens simultaneas na mesma conta nao reutilizam o mesmo saldo', async () => {
  // Conta unica e apertada: as duas ordens juntas nao cabem.
  const engine = buildEngine({ balance: 2_000 });
  engine.setAccountForMarket('CRYPTO', 'paper');
  await arm(engine, 'FOREX');
  await arm(engine, 'CRYPTO');
  engine.updateGlobalRiskSettings({ enabled: false });
  engine.updateRiskSettings('CRYPTO', { sizingMode: 'FIXED_QUANTITY', fixedQuantity: 0.026 });

  assert.equal(engine.markets.FOREX.accountId, engine.markets.CRYPTO.accountId, 'mesma conta');

  for (const sourceId of FOREX_TRIO) emit(engine, sourceId, 'EURUSD', 'BUY');
  for (const sourceId of CRYPTO_TRIO) emit(engine, sourceId, 'BTCUSDT', 'BUY');
  engine.runPipeline();
  await engine.flush();

  const filled = engine.orders.filter((o) => o.status === 'FILLED');
  assert.equal(filled.length, 1, 'apenas uma ordem cabe na conta compartilhada');

  const account = engine.brokerFor('FOREX').getAccount();
  assert.ok(
    account.usedMargin <= account.equity,
    `margem usada ${account.usedMargin} nao pode passar do patrimonio ${account.equity}`,
  );

  const bloqueada = engine.opportunities.find(
    (o) => !filled.some((f) => f.opportunityId === o.id),
  );
  assert.ok(bloqueada);
  const decision = engine.decisions.get(bloqueada.id);
  assert.equal(
    decision?.blocks.some((b) => b.code === 'MARGEM_INSUFICIENTE'),
    true,
    'a segunda ve a margem ja comprometida',
  );
});

test('contas separadas por mercado exibem saldos proprios', async () => {
  const engine = buildEngine();
  const result = engine.setAccountForMarket('CRYPTO', 'paper-crypto');
  assert.equal(result.ok, true, result.message);
  await engine.connectAll();

  const snapshot = engine.snapshot();
  assert.equal(snapshot.consolidated.sharedAccount, false);
  assert.equal(snapshot.consolidated.accounts.length, 2);
  assert.equal(snapshot.markets.FOREX.account.currency, 'USD');
  assert.equal(snapshot.markets.CRYPTO.account.currency, 'USDT');
  assert.match(snapshot.consolidated.conversionNote, /USDT/);
  assert.equal(snapshot.consolidated.referenceCurrency, 'USD');
});

test('conta de cripto nao pode ser escolhida para forex', () => {
  const engine = buildEngine();
  const result = engine.setAccountForMarket('FOREX', 'paper-crypto');
  assert.equal(result.ok, false);
  assert.match(result.message, /nao atende/);
});

test('o instantaneo separa dados por mercado', async () => {
  const engine = buildEngine();
  await arm(engine, 'CRYPTO');
  for (const sourceId of CRYPTO_TRIO) emit(engine, sourceId, 'BTCUSDT', 'BUY');
  for (const sourceId of ['src_alfa', 'src_beta']) emit(engine, sourceId, 'EURUSD', 'BUY');
  engine.runPipeline();
  await engine.flush();

  const snapshot = engine.snapshot();
  assert.ok(snapshot.markets.CRYPTO.opportunities.length >= 1);
  assert.equal(snapshot.markets.FOREX.opportunities.length, 0);
  assert.ok(snapshot.markets.FOREX.signals.every((s) => s.marketId === 'FOREX'));
  assert.ok(snapshot.markets.CRYPTO.signals.every((s) => s.marketId === 'CRYPTO'));
  assert.ok(snapshot.markets.FOREX.sources.every((s) => s.markets.includes('FOREX')));
  assert.ok(snapshot.markets.CRYPTO.quotes.every((q) => q.symbol.includes('USDT')));
});
