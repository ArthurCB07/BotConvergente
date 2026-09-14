import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateConvergence } from '../src/core/convergence.ts';
import { cloneConvergenceDefaults } from '../src/core/settings.ts';
import type {
  ConvergenceSettings,
  MarketId,
  Signal,
  Source,
  Side,
} from '../src/core/types.ts';

const NOW = '2026-09-14T14:00:00.000Z';

function makeSource(
  id: string,
  markets: MarketId[] = ['FOREX'],
  groupId = id,
  weight = 1,
): Source {
  return {
    id,
    name: `Fonte ${id}`,
    kind: 'GENERATOR',
    enabled: true,
    markets,
    tags: [],
    independenceGroupId: groupId,
    weightByMarket: { FOREX: weight, CRYPTO: weight },
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
    marketId: 'FOREX',
    productType: 'FX_SPOT',
    symbol: 'EURUSD',
    venue: 'REGULAR',
    quoteCurrency: 'USD',
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

/** Atalho para um sinal de cripto a vista. */
function cryptoSignal(sourceId: string, side: Side, overrides: Partial<Signal> = {}): Signal {
  return makeSignal(sourceId, side, {
    marketId: 'CRYPTO',
    productType: 'CRYPTO_SPOT',
    symbol: 'BTCUSDT',
    quoteCurrency: 'USDT',
    entryPrice: 72_500,
    stopLoss: 71_400,
    takeProfit: 74_300,
    ...overrides,
  });
}

const settings = (
  marketId: MarketId,
  patch: Partial<ConvergenceSettings> = {},
): ConvergenceSettings => ({ ...cloneConvergenceDefaults(marketId), ...patch });

const run = (
  marketId: MarketId,
  sources: Source[],
  signals: Signal[],
  patch: Partial<ConvergenceSettings> = {},
) => evaluateConvergence({ nowIso: NOW, marketId, settings: settings(marketId, patch), signals, sources });

// --- Comportamento base (preservado da versao so de forex) ------------------

test('tres concordantes e um contrario resultam em 3 de 4 participantes = 75%', () => {
  const sources = [makeSource('a'), makeSource('b'), makeSource('c'), makeSource('d')];
  const signals = [
    makeSignal('a', 'BUY'),
    makeSignal('b', 'BUY'),
    makeSignal('c', 'BUY'),
    makeSignal('d', 'SELL'),
  ];
  const [evaluation] = run('FOREX', sources, signals);
  assert.ok(evaluation);
  assert.equal(evaluation.marketId, 'FOREX');
  assert.equal(evaluation.side, 'BUY');
  assert.equal(evaluation.agreeingCount, 3);
  assert.equal(evaluation.participantCount, 4);
  assert.equal(evaluation.agreementPercent, 75);
  assert.equal(evaluation.meetsCriteria, true);
});

test('fontes do mesmo grupo de independencia contam um voto so', () => {
  const sources = [
    makeSource('a', ['FOREX'], 'grupo1'),
    makeSource('a_mirror', ['FOREX'], 'grupo1'),
    makeSource('b', ['FOREX'], 'grupo2'),
    makeSource('c', ['FOREX'], 'grupo3'),
  ];
  const signals = [
    makeSignal('a', 'BUY', {}, 'grupo1'),
    makeSignal('a_mirror', 'BUY', {}, 'grupo1'),
    makeSignal('b', 'BUY', {}, 'grupo2'),
    makeSignal('c', 'BUY', {}, 'grupo3'),
  ];
  const [evaluation] = run('FOREX', sources, signals);
  assert.ok(evaluation);
  assert.equal(evaluation.agreeingCount, 3, 'quatro fontes, tres grupos de independencia');
  assert.equal(evaluation.participantCount, 3);
});

test('OTC nao e comparado com mercado regular', () => {
  const sources = [makeSource('a'), makeSource('b'), makeSource('c')];
  const signals = [
    makeSignal('a', 'BUY'),
    makeSignal('b', 'BUY'),
    makeSignal('c', 'BUY', { symbol: 'EURUSD-OTC', venue: 'OTC' }),
  ];
  const evaluations = run('FOREX', sources, signals);
  assert.equal(evaluations.length, 2, 'dois agrupamentos separados');
  for (const evaluation of evaluations) assert.equal(evaluation.meetsCriteria, false);
});

test('preco fora da tolerancia sai do agrupamento com motivo', () => {
  const sources = [makeSource('a'), makeSource('b'), makeSource('c')];
  const signals = [
    makeSignal('a', 'BUY', { entryPrice: 1.085 }),
    makeSignal('b', 'BUY', { entryPrice: 1.0851 }),
    makeSignal('c', 'BUY', { entryPrice: 1.095 }),
  ];
  const [evaluation] = run('FOREX', sources, signals, { entryTolerancePips: 8 });
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
  const [evaluation] = run('FOREX', sources, signals);
  assert.ok(evaluation);
  assert.equal(evaluation.participantCount, 2);
  assert.equal(evaluation.notComparable.length, 1);
});

test('sinal ambiguo, expirado ou de mercado nao cadastrado nao vota', () => {
  const sources = [makeSource('a'), makeSource('b'), makeSource('c'), makeSource('d')];
  const signals = [
    makeSignal('a', 'BUY'),
    makeSignal('b', 'BUY', { status: 'AMBIGUOUS' }),
    makeSignal('c', 'BUY', { status: 'EXPIRED' }),
    makeSignal('d', 'BUY', { status: 'MARKET_MISMATCH' }),
  ];
  const [evaluation] = run('FOREX', sources, signals);
  assert.ok(evaluation);
  assert.equal(evaluation.agreeingCount, 1);
  assert.equal(evaluation.meetsCriteria, false);
});

test('criterio BOTH rejeita 2 de 2 mesmo com 100% de concordancia', () => {
  const sources = [makeSource('a'), makeSource('b')];
  const signals = [makeSignal('a', 'BUY'), makeSignal('b', 'BUY')];
  const [evaluation] = run('FOREX', sources, signals, {
    criteriaMode: 'BOTH',
    minAgreeingSources: 3,
    minAgreementPercent: 75,
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
  const [ignored] = run('FOREX', sources, signals, { opposingPolicy: 'IGNORE_IN_DENOMINATOR' });
  assert.ok(ignored);
  assert.equal(ignored.participantCount, 3);
  assert.equal(ignored.agreementPercent, 100);

  const [blocking] = run('FOREX', sources, signals, { opposingPolicy: 'BLOCK_IF_ANY' });
  assert.ok(blocking);
  assert.equal(blocking.meetsCriteria, false);
});

test('fonte excluida na configuracao do mercado nao participa', () => {
  const sources = [makeSource('a'), makeSource('b'), makeSource('c'), makeSource('d')];
  const signals = [
    makeSignal('a', 'BUY'),
    makeSignal('b', 'BUY'),
    makeSignal('c', 'BUY'),
    makeSignal('d', 'BUY'),
  ];
  const [evaluation] = run('FOREX', sources, signals, { excludedSourceIds: ['d'] });
  assert.ok(evaluation);
  assert.equal(evaluation.agreeingCount, 3);
  assert.equal(evaluation.registeredActiveSources, 3);
});

// --- Separacao entre mercados ----------------------------------------------

test('fontes de Cripto nao alteram a concordancia de Forex', () => {
  const sources = [
    makeSource('fx1'),
    makeSource('fx2'),
    makeSource('c1', ['CRYPTO']),
    makeSource('c2', ['CRYPTO']),
    makeSource('c3', ['CRYPTO']),
    makeSource('c4', ['CRYPTO']),
  ];
  const forexSignals = [makeSignal('fx1', 'BUY'), makeSignal('fx2', 'BUY')];
  const cryptoSignals = [
    cryptoSignal('c1', 'BUY'),
    cryptoSignal('c2', 'BUY'),
    cryptoSignal('c3', 'BUY'),
    cryptoSignal('c4', 'BUY'),
  ];

  const semCripto = run('FOREX', sources, forexSignals);
  const comCripto = run('FOREX', sources, [...forexSignals, ...cryptoSignals]);

  assert.equal(comCripto.length, 1, 'a avaliacao de Forex so enxerga o agrupamento de Forex');
  assert.equal(comCripto[0]?.agreeingCount, semCripto[0]?.agreeingCount);
  assert.equal(comCripto[0]?.participantCount, semCripto[0]?.participantCount);
  assert.equal(comCripto[0]?.participantCount, 2);
  assert.equal(comCripto[0]?.registeredActiveSources, 2, 'so as fontes de Forex sao habilitadas');
});

test('fontes de Forex nao alteram a concordancia de Cripto', () => {
  const sources = [
    makeSource('c1', ['CRYPTO']),
    makeSource('c2', ['CRYPTO']),
    makeSource('fx1'),
    makeSource('fx2'),
    makeSource('fx3'),
  ];
  const cryptoSignals = [cryptoSignal('c1', 'BUY'), cryptoSignal('c2', 'BUY')];
  const forexSignals = [makeSignal('fx1', 'BUY'), makeSignal('fx2', 'BUY'), makeSignal('fx3', 'BUY')];

  const [evaluation] = run('CRYPTO', sources, [...cryptoSignals, ...forexSignals]);
  assert.ok(evaluation);
  assert.equal(evaluation.marketId, 'CRYPTO');
  assert.equal(evaluation.participantCount, 2);
  assert.equal(evaluation.meetsCriteria, false, 'duas fontes nao atingem o minimo de tres');
});

test('cripto a vista e perpetuo geram agrupamentos separados', () => {
  const sources = [
    makeSource('c1', ['CRYPTO']),
    makeSource('c2', ['CRYPTO']),
    makeSource('c3', ['CRYPTO']),
    makeSource('c4', ['CRYPTO']),
  ];
  const signals = [
    cryptoSignal('c1', 'BUY'),
    cryptoSignal('c2', 'BUY'),
    cryptoSignal('c3', 'BUY', {
      symbol: 'BTCUSDT-PERP',
      productType: 'CRYPTO_PERP',
      entryPrice: 72_520,
      stopLoss: 71_420,
      takeProfit: 74_320,
    }),
    cryptoSignal('c4', 'BUY', {
      symbol: 'BTCUSDT-PERP',
      productType: 'CRYPTO_PERP',
      entryPrice: 72_520,
      stopLoss: 71_420,
      takeProfit: 74_320,
    }),
  ];
  const evaluations = run('CRYPTO', sources, signals);
  assert.equal(evaluations.length, 2);
  const produtos = evaluations.map((e) => e.productType).sort();
  assert.deepEqual(produtos, ['CRYPTO_PERP', 'CRYPTO_SPOT']);
  for (const evaluation of evaluations) {
    assert.equal(evaluation.participantCount, 2);
    assert.equal(evaluation.meetsCriteria, false);
  }
});

test('fonte nao cadastrada no mercado nao entra na avaliacao dele', () => {
  const sources = [makeSource('c1', ['CRYPTO']), makeSource('c2', ['CRYPTO']), makeSource('fx1')];
  // O sinal existe e e de cripto, porem a fonte so atende forex.
  const signals = [cryptoSignal('c1', 'BUY'), cryptoSignal('c2', 'BUY'), cryptoSignal('fx1', 'BUY')];
  const [evaluation] = run('CRYPTO', sources, signals);
  assert.ok(evaluation);
  assert.equal(evaluation.agreeingCount, 2, 'o voto da fonte de forex nao conta em cripto');
  assert.equal(evaluation.registeredActiveSources, 2);
});

test('fonte dos dois mercados vale um voto em cada, nunca dois no mesmo', () => {
  const sources = [
    makeSource('dual', ['FOREX', 'CRYPTO'], 'grupo_dual'),
    makeSource('fx1'),
    makeSource('c1', ['CRYPTO']),
  ];
  const signals = [
    makeSignal('dual', 'BUY', {}, 'grupo_dual'),
    makeSignal('fx1', 'BUY'),
    cryptoSignal('dual', 'BUY', { independenceGroupId: 'grupo_dual' }),
    cryptoSignal('c1', 'BUY'),
  ];

  const [forex] = run('FOREX', sources, signals);
  const [crypto] = run('CRYPTO', sources, signals);
  assert.equal(forex?.agreeingCount, 2);
  assert.equal(crypto?.agreeingCount, 2);
  assert.equal(
    forex?.agreeing.filter((v) => v.sourceId === 'dual').length,
    1,
    'um voto por mercado, nunca duplicado',
  );
});

test('instrumento fora da lista permitida do mercado nao vota', () => {
  const sources = [makeSource('a'), makeSource('b'), makeSource('c')];
  const signals = [
    makeSignal('a', 'BUY'),
    makeSignal('b', 'BUY'),
    makeSignal('c', 'BUY', { symbol: 'GBPUSD', entryPrice: 1.268, stopLoss: 1.266, takeProfit: 1.271 }),
  ];
  const evaluations = run('FOREX', sources, signals, { allowedSymbols: ['EURUSD'] });
  assert.equal(evaluations.length, 1);
  assert.equal(evaluations[0]?.symbol, 'EURUSD');
});

// --- Base do percentual -----------------------------------------------------

test('base "fontes habilitadas" conta o silencio no denominador', () => {
  const sources = [makeSource('a'), makeSource('b'), makeSource('c'), makeSource('d'), makeSource('e')];
  const signals = [makeSignal('a', 'BUY'), makeSignal('b', 'BUY'), makeSignal('c', 'BUY')];

  const [comparaveis] = run('FOREX', sources, signals, { denominatorMode: 'COMPARABLE_SIGNALS' });
  assert.equal(comparaveis?.participantCount, 3);
  assert.equal(comparaveis?.agreementPercent, 100);

  const [habilitadas] = run('FOREX', sources, signals, { denominatorMode: 'ENABLED_SOURCES' });
  assert.equal(habilitadas?.participantCount, 5, 'as cinco fontes habilitadas entram no denominador');
  assert.equal(habilitadas?.agreeingCount, 3);
  assert.equal(habilitadas?.agreementPercent, 60);
  assert.match(habilitadas?.denominatorRule ?? '', /fontes habilitadas/);
  const silenciosas = habilitadas?.nonParticipants.filter((n) => n.countedInDenominator) ?? [];
  assert.equal(silenciosas.length, 2, 'quem nao mandou sinal aparece contado no denominador');
});

test('quantidade minima de confirmacoes e independente da base do percentual', () => {
  const sources = [makeSource('a'), makeSource('b'), makeSource('c'), makeSource('d')];
  const signals = [makeSignal('a', 'BUY'), makeSignal('b', 'BUY'), makeSignal('c', 'BUY')];
  const [evaluation] = run('FOREX', sources, signals, {
    denominatorMode: 'ENABLED_SOURCES',
    criteriaMode: 'COUNT',
    minAgreeingSources: 3,
  });
  assert.ok(evaluation);
  assert.equal(evaluation.agreementPercent, 75);
  assert.equal(evaluation.meetsCriteria, true, 'o corte por quantidade nao olha o percentual');
});

test('a chave do agrupamento carrega mercado e produto', () => {
  const sources = [makeSource('c1', ['CRYPTO'])];
  const [evaluation] = run('CRYPTO', sources, [cryptoSignal('c1', 'BUY')]);
  assert.equal(evaluation?.clusterKey, 'CRYPTO|CRYPTO_SPOT|BTCUSDT|REGULAR|BUY');
});
