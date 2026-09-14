import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  computeDailyResult,
  computeSizing,
  evaluateRisk,
  type DayState,
  type GlobalDayState,
  type RiskContext,
} from '../src/core/risk.ts';
import { cloneRiskDefaults, defaultGlobalRiskSettings } from '../src/core/settings.ts';
import type {
  AccountSnapshot,
  MarketId,
  Opportunity,
  Position,
  Quote,
  RiskSettings,
} from '../src/core/types.ts';

// Segunda-feira, 14:00 UTC = 11:00 em America/Sao_Paulo: dentro da janela de forex.
const NOW = '2026-09-14T14:00:00.000Z';

const account: AccountSnapshot = {
  accountId: 'SIM-PAPER',
  accountType: 'SIMULADA',
  brokerId: 'paper',
  brokerName: 'Conta simulada compartilhada',
  currency: 'USD',
  markets: ['FOREX', 'CRYPTO'],
  balance: 10_000,
  equity: 10_000,
  usedMargin: 0,
  reservedMargin: 0,
  freeMargin: 10_000,
  connected: true,
  lastUpdateAt: NOW,
};

const quote: Quote = { symbol: 'EURUSD', bid: 1.08495, ask: 1.08505, spreadPips: 1, at: NOW };
const cryptoQuote: Quote = { symbol: 'BTCUSDT', bid: 72_495, ask: 72_505, spreadPips: 0.4, at: NOW };

const day: DayState = {
  dayKey: '2026-09-14',
  baseEquity: 10_000,
  realizedNetPnl: 0,
  costs: 0,
  cashFlows: 0,
  tradesToday: 0,
  lastEntryAt: null,
  consecutiveLosses: 0,
  pausedUntil: null,
  dailyLimitHit: null,
};

const globalDay: GlobalDayState = {
  dayKey: '2026-09-14',
  baseEquity: 15_000,
  realizedNetPnl: 0,
  tradesToday: 0,
  dailyLimitHit: null,
  conversionNote: 'Consolidado em USD.',
};

function opportunity(marketId: MarketId = 'FOREX'): Opportunity {
  const crypto = marketId === 'CRYPTO';
  return {
    id: 'opp1',
    clusterKey: crypto ? 'CRYPTO|CRYPTO_SPOT|BTCUSDT|REGULAR|BUY' : 'FOREX|FX_SPOT|EURUSD|REGULAR|BUY',
    version: 1,
    marketId,
    productType: crypto ? 'CRYPTO_SPOT' : 'FX_SPOT',
    symbol: crypto ? 'BTCUSDT' : 'EURUSD',
    venue: 'REGULAR',
    quoteCurrency: crypto ? 'USDT' : 'USD',
    side: 'BUY',
    createdAt: NOW,
    updatedAt: NOW,
    validUntil: '2026-09-14T14:10:00.000Z',
    status: 'PUBLISHED',
    referenceEntry: crypto ? 72_500 : 1.085,
    suggestedStopLoss: crypto ? 71_400 : 1.083,
    suggestedTakeProfit: crypto ? 74_300 : 1.088,
    agreeing: [],
    dissenting: [],
    notComparable: [],
    nonParticipants: [],
    participantCount: 4,
    agreeingCount: 3,
    agreementPercent: 75,
    weightedAgreementPercent: 75,
    registeredActiveSources: 6,
    denominatorMode: 'COMPARABLE_SIGNALS',
    denominatorRule: 'Base: fontes com sinal comparavel.',
    criteria: [],
    summary: '',
    executionCount: 0,
    signalIds: [],
  };
}

const ctx = (
  patch: Partial<RiskContext> = {},
  settingsPatch: Partial<RiskSettings> = {},
  marketId: MarketId = 'FOREX',
): RiskContext => ({
  nowIso: NOW,
  marketId,
  origin: 'AUTO',
  mode: 'AUTO',
  automationEnabled: true,
  globalPaused: false,
  settings: { ...cloneRiskDefaults(marketId), ...settingsPatch },
  globalSettings: { ...defaultGlobalRiskSettings },
  account,
  quote: marketId === 'CRYPTO' ? cryptoQuote : quote,
  openPositions: [],
  allOpenPositions: [],
  globalExposureNotional: 0,
  day: { ...day },
  globalDay: { ...globalDay },
  accountSupportsSymbol: true,
  executionsForOpportunity: 0,
  ...patch,
});

function openPosition(overrides: Partial<Position> = {}): Position {
  return {
    id: 'pos1',
    orderId: 'o1',
    opportunityId: null,
    marketId: 'FOREX',
    productType: 'FX_SPOT',
    accountId: 'SIM-PAPER',
    brokerId: 'paper',
    symbol: 'GBPUSD',
    side: 'BUY',
    quantity: 0.1,
    quantityLabel: 'lote',
    openPrice: 1.268,
    openedAt: NOW,
    stopLoss: null,
    takeProfit: null,
    closePrice: null,
    closedAt: null,
    closeReason: null,
    status: 'OPEN',
    grossPnl: 0,
    costs: 0,
    netPnl: 0,
    notionalValue: 12_680,
    riskedValue: 0,
    simulated: true,
    ...overrides,
  };
}

// --- Base -------------------------------------------------------------------

test('cenario base aprovado no modo autonomo com automacao ligada', () => {
  const decision = evaluateRisk(opportunity(), ctx());
  assert.equal(decision.allowed, true, decision.blocks.map((b) => b.label).join('; '));
  assert.ok(decision.sizing);
});

test('modo observacao nunca envia ordem', () => {
  const decision = evaluateRisk(opportunity(), ctx({ mode: 'OBSERVE' }));
  assert.equal(decision.allowed, false);
  assert.ok(decision.blocks.some((b) => b.code === 'MODO_OBSERVACAO'));
});

test('cotacao desatualizada bloqueia o envio', () => {
  const stale: Quote = { ...quote, at: '2026-09-14T13:58:00.000Z' };
  const decision = evaluateRisk(opportunity(), ctx({ quote: stale }));
  assert.equal(decision.allowed, false);
  assert.ok(decision.blocks.some((b) => b.code === 'COTACAO_DESATUALIZADA'));
});

test('falta de conexao bloqueia o envio', () => {
  const decision = evaluateRisk(
    opportunity(),
    ctx({ account: { ...account, connected: false }, quote: null }),
  );
  assert.equal(decision.allowed, false);
  assert.ok(decision.blocks.some((b) => b.code === 'SEM_CONEXAO'));
});

test('conexao que nao suporta o instrumento bloqueia o envio', () => {
  const decision = evaluateRisk(opportunity('CRYPTO'), ctx({ accountSupportsSymbol: false }, {}, 'CRYPTO'));
  assert.equal(decision.allowed, false);
  const block = decision.blocks.find((b) => b.code === 'INSTRUMENTO_NAO_SUPORTADO');
  assert.ok(block);
  assert.match(block.detail, /nao negocia/);
});

test('limite de execucoes por oportunidade impede entrada em atualizacao', () => {
  const decision = evaluateRisk(opportunity(), ctx({ executionsForOpportunity: 1 }));
  assert.equal(decision.allowed, false);
  assert.ok(decision.blocks.some((b) => b.code === 'LIMITE_EXECUCOES_OPORTUNIDADE'));
});

test('fora do horario permitido bloqueia em forex', () => {
  // 07:00 UTC = 04:00 em Sao Paulo, antes da janela padrao das 05:00.
  const at = '2026-09-14T07:00:00.000Z';
  const decision = evaluateRisk(
    opportunity(),
    ctx({ nowIso: at, quote: { ...quote, at } }),
  );
  assert.equal(decision.allowed, false);
  assert.ok(decision.blocks.some((b) => b.code === 'FORA_DE_HORARIO'));
});

test('cripto opera no mesmo horario em que forex esta fechado', () => {
  const at = '2026-09-14T07:00:00.000Z';
  const decision = evaluateRisk(
    opportunity('CRYPTO'),
    ctx({ nowIso: at, quote: { ...cryptoQuote, at } }, {}, 'CRYPTO'),
  );
  assert.equal(
    decision.checks.find((c) => c.code === 'FORA_DE_HORARIO')?.passed,
    true,
    'cripto negocia 24 horas, 7 dias',
  );
});

test('spread acima do limite bloqueia', () => {
  const decision = evaluateRisk(opportunity(), ctx({ quote: { ...quote, spreadPips: 9 } }));
  assert.equal(decision.allowed, false);
  assert.ok(decision.blocks.some((b) => b.code === 'SPREAD_ALTO'));
});

// --- Automacao por mercado e pausa global -----------------------------------

test('automacao do mercado desligada bloqueia o envio automatico', () => {
  const decision = evaluateRisk(opportunity(), ctx({ automationEnabled: false, origin: 'AUTO' }));
  assert.equal(decision.allowed, false);
  const block = decision.blocks.find((b) => b.code === 'AUTOMACAO_MERCADO_DESLIGADA');
  assert.ok(block);
  assert.equal(block.scope, 'MARKET');
});

test('automacao desligada NAO impede confirmacao manual', () => {
  const decision = evaluateRisk(opportunity(), ctx({ automationEnabled: false, origin: 'MANUAL' }));
  assert.equal(decision.allowed, true, decision.blocks.map((b) => b.label).join('; '));
  assert.ok(decision.warnings.some((w) => w.code === 'AUTOMACAO_MERCADO_DESLIGADA'));
});

test('pausa global bloqueia o envio automatico e marca escopo global', () => {
  const decision = evaluateRisk(opportunity(), ctx({ globalPaused: true, origin: 'AUTO' }));
  assert.equal(decision.allowed, false);
  const block = decision.blocks.find((b) => b.code === 'PAUSA_GLOBAL');
  assert.ok(block);
  assert.equal(block.scope, 'GLOBAL');
});

// --- Limites do mercado -----------------------------------------------------

test('stop diario do mercado bloqueia apenas com escopo de mercado', () => {
  const decision = evaluateRisk(opportunity(), ctx({ day: { ...day, realizedNetPnl: -250 } }));
  assert.equal(decision.allowed, false);
  const block = decision.blocks.find((b) => b.code === 'STOP_DIARIO');
  assert.ok(block);
  assert.equal(block.scope, 'MARKET');
});

test('limite de posicoes abertas do mercado respeitado', () => {
  const decision = evaluateRisk(opportunity(), ctx({ openPositions: [openPosition()] }));
  assert.equal(decision.allowed, false);
  assert.ok(decision.blocks.some((b) => b.code === 'MAX_POSICOES'));
});

// --- Limites globais --------------------------------------------------------

test('limite global de posicoes bloqueia mesmo com o individual livre', () => {
  const outroMercado = openPosition({ marketId: 'CRYPTO', symbol: 'BTCUSDT' });
  const decision = evaluateRisk(
    opportunity(),
    ctx({
      openPositions: [],
      allOpenPositions: [outroMercado],
      globalSettings: { ...defaultGlobalRiskSettings, maxOpenPositionsTotal: 1 },
    }),
  );
  assert.equal(decision.allowed, false);
  const block = decision.blocks.find((b) => b.code === 'MAX_POSICOES_GLOBAL');
  assert.ok(block);
  assert.equal(block.scope, 'GLOBAL');
  assert.equal(
    decision.checks.find((c) => c.code === 'MAX_POSICOES')?.passed,
    true,
    'o limite individual do mercado continua livre',
  );
});

test('exposicao global bloqueia os dois mercados', () => {
  const decision = evaluateRisk(
    opportunity(),
    ctx({
      globalExposureNotional: 99_000,
      globalSettings: { ...defaultGlobalRiskSettings, maxTotalExposureNotional: 100_000 },
    }),
  );
  assert.equal(decision.allowed, false);
  assert.ok(decision.blocks.some((b) => b.code === 'EXPOSICAO_GLOBAL' && b.scope === 'GLOBAL'));
});

test('stop diario global bloqueia mesmo com o limite do mercado livre', () => {
  const decision = evaluateRisk(
    opportunity(),
    ctx({
      day: { ...day, realizedNetPnl: -10 },
      globalDay: { ...globalDay, realizedNetPnl: -500 },
      globalSettings: { ...defaultGlobalRiskSettings, dailyLossLimitPercent: 3 },
    }),
  );
  assert.equal(decision.allowed, false);
  assert.ok(decision.blocks.some((b) => b.code === 'STOP_DIARIO_GLOBAL' && b.scope === 'GLOBAL'));
  assert.equal(decision.checks.find((c) => c.code === 'STOP_DIARIO')?.passed, true);
});

test('limites globais desligados nao bloqueiam', () => {
  const decision = evaluateRisk(
    opportunity(),
    ctx({
      globalExposureNotional: 10_000_000,
      globalSettings: { ...defaultGlobalRiskSettings, enabled: false },
    }),
  );
  assert.equal(decision.allowed, true, decision.blocks.map((b) => b.label).join('; '));
});

// --- Dimensionamento --------------------------------------------------------

test('dimensionamento por risco em forex separa valor da ordem de valor arriscado', () => {
  const sizing = computeSizing(
    'EURUSD',
    'BUY',
    1.085,
    1.083,
    1.088,
    { ...cloneRiskDefaults('FOREX'), sizingMode: 'RISK_PERCENT', riskPercentPerTrade: 0.5 },
    account,
  );
  // 0,5% de USD 10.000 = USD 50. Stop de 20 pips a USD 10 por pip por lote = 0,25 lote.
  assert.equal(sizing.stopPips, 20);
  assert.equal(sizing.quantity, 0.25);
  assert.equal(sizing.riskedValue, 50);
  assert.equal(sizing.quantityLabel, 'lote');
  assert.ok(sizing.notionalValue > sizing.riskedValue * 100);
});

test('dimensionamento por risco em cripto usa a unidade do ativo', () => {
  const sizing = computeSizing(
    'BTCUSDT',
    'BUY',
    72_500,
    71_412.5,
    74_300,
    { ...cloneRiskDefaults('CRYPTO'), sizingMode: 'RISK_PERCENT', riskPercentPerTrade: 0.3 },
    account,
  );
  // 1 pip = 7,25 USD (0,01% de 72.500). Stop de 1.087,5 = 150 pips.
  assert.equal(sizing.stopPips, 150);
  assert.equal(sizing.quantityLabel, 'BTC');
  // 0,3% de 10.000 = 30 USD de risco; 150 pips x 7,25 = 1.087,5 por BTC -> ~0,0275 BTC.
  assert.ok(sizing.quantity > 0.027 && sizing.quantity < 0.028, `quantidade ${sizing.quantity}`);
  assert.ok(Math.abs(sizing.riskedValue - 30) < 1, `arriscado ${sizing.riskedValue}`);
});

test('cripto a vista exige o nocional cheio de margem', () => {
  const decision = evaluateRisk(
    opportunity('CRYPTO'),
    ctx(
      { account: { ...account, currency: 'USDT', equity: 500, freeMargin: 500 } },
      { riskPercentPerTrade: 5 },
      'CRYPTO',
    ),
  );
  const margem = decision.checks.find((c) => c.code === 'MARGEM_INSUFICIENTE');
  assert.ok(margem);
  assert.equal(margem.passed, false, 'sem alavancagem, o nocional inteiro precisa caber na conta');
});

test('quantidade abaixo do minimo do instrumento bloqueia', () => {
  const decision = evaluateRisk(
    opportunity('CRYPTO'),
    ctx({ account: { ...account, equity: 1 } }, { riskPercentPerTrade: 0.05 }, 'CRYPTO'),
  );
  assert.equal(decision.allowed, false);
  assert.ok(decision.blocks.some((b) => b.code === 'QUANTIDADE_INVALIDA'));
});

test('margem reservada por outra ordem reduz a margem livre visivel', () => {
  const comReserva: AccountSnapshot = {
    ...account,
    reservedMargin: 9_900,
    freeMargin: 100,
  };
  const decision = evaluateRisk(opportunity(), ctx({ account: comReserva }));
  assert.equal(decision.allowed, false);
  const block = decision.blocks.find((b) => b.code === 'MARGEM_INSUFICIENTE');
  assert.ok(block);
  assert.match(block.detail, /reserva/);
});

test('resultado diario separa realizado, aberto e fluxos de caixa', () => {
  const aberta = openPosition({ symbol: 'EURUSD', grossPnl: 30, costs: 0.7, netPnl: 29.3 });
  const result = computeDailyResult(
    { ...day, realizedNetPnl: -40, costs: 2, cashFlows: 500 },
    [aberta],
    2,
    3,
  );
  assert.equal(result.limitBasisPnl, -40, 'limites diarios usam apenas o realizado');
  assert.equal(result.unrealizedPnl, 29.3);
  assert.equal(result.totalWithOpenPnl, -10.7);
  assert.equal(result.cashFlows, 500, 'deposito nao entra no resultado');
  assert.equal(result.lossLimitValue, -200);
});
