import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeDailyResult, computeSizing, evaluateRisk, type DayState, type RiskContext } from '../src/core/risk.ts';
import { defaultRiskSettings } from '../src/core/settings.ts';
import type { AccountSnapshot, Opportunity, Position, Quote, RiskSettings } from '../src/core/types.ts';

// Segunda-feira, 14:00 UTC = 11:00 em America/Sao_Paulo: dentro da janela padrao.
const NOW = '2026-09-14T14:00:00.000Z';

const account: AccountSnapshot = {
  accountId: 'SIM-0001',
  accountType: 'SIMULADA',
  brokerId: 'paper',
  currency: 'USD',
  balance: 10_000,
  equity: 10_000,
  usedMargin: 0,
  freeMargin: 10_000,
  connected: true,
  lastUpdateAt: NOW,
};

const quote: Quote = { symbol: 'EURUSD', bid: 1.08495, ask: 1.08505, spreadPips: 1, at: NOW };

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

const opportunity: Opportunity = {
  id: 'opp1',
  clusterKey: 'FX_SPOT|EURUSD|REGULAR|BUY',
  version: 1,
  market: 'FX_SPOT',
  symbol: 'EURUSD',
  venue: 'REGULAR',
  side: 'BUY',
  createdAt: NOW,
  updatedAt: NOW,
  validUntil: '2026-09-14T14:10:00.000Z',
  status: 'PUBLISHED',
  referenceEntry: 1.085,
  suggestedStopLoss: 1.083,
  suggestedTakeProfit: 1.088,
  agreeing: [],
  dissenting: [],
  notComparable: [],
  nonParticipants: [],
  participantCount: 4,
  agreeingCount: 3,
  agreementPercent: 75,
  weightedAgreementPercent: 75,
  registeredActiveSources: 6,
  criteria: [],
  summary: '',
  executionCount: 0,
  signalIds: [],
};

const ctx = (patch: Partial<RiskContext> = {}, settingsPatch: Partial<RiskSettings> = {}): RiskContext => ({
  nowIso: NOW,
  mode: 'AUTO',
  automationPaused: false,
  settings: { ...defaultRiskSettings, ...settingsPatch },
  account,
  quote,
  openPositions: [],
  day: { ...day },
  executionsForOpportunity: 0,
  ...patch,
});

test('cenario base aprovado no modo autonomo', () => {
  const decision = evaluateRisk(opportunity, ctx());
  assert.equal(decision.allowed, true, decision.blocks.map((b) => b.label).join('; '));
  assert.ok(decision.sizing);
});

test('modo observacao nunca envia ordem', () => {
  const decision = evaluateRisk(opportunity, ctx({ mode: 'OBSERVE' }));
  assert.equal(decision.allowed, false);
  assert.ok(decision.blocks.some((b) => b.code === 'MODO_OBSERVACAO'));
});

test('stop diario atingido bloqueia novas entradas mesmo no modo autonomo', () => {
  const decision = evaluateRisk(
    opportunity,
    ctx({ day: { ...day, realizedNetPnl: -250 } }),
  );
  assert.equal(decision.allowed, false);
  assert.ok(decision.blocks.some((b) => b.code === 'STOP_DIARIO'));
});

test('cotacao desatualizada bloqueia o envio', () => {
  const stale: Quote = { ...quote, at: '2026-09-14T13:58:00.000Z' };
  const decision = evaluateRisk(opportunity, ctx({ quote: stale }));
  assert.equal(decision.allowed, false);
  assert.ok(decision.blocks.some((b) => b.code === 'COTACAO_DESATUALIZADA'));
});

test('falta de conexao bloqueia o envio', () => {
  const decision = evaluateRisk(
    opportunity,
    ctx({ account: { ...account, connected: false }, quote: null }),
  );
  assert.equal(decision.allowed, false);
  assert.ok(decision.blocks.some((b) => b.code === 'SEM_CONEXAO'));
});

test('limite de execucoes por oportunidade impede entrada em atualizacao', () => {
  const decision = evaluateRisk(opportunity, ctx({ executionsForOpportunity: 1 }));
  assert.equal(decision.allowed, false);
  assert.ok(decision.blocks.some((b) => b.code === 'LIMITE_EXECUCOES_OPORTUNIDADE'));
});

test('limite de posicoes abertas respeitado', () => {
  const open: Position = {
    id: 'pos1',
    orderId: 'o1',
    opportunityId: null,
    symbol: 'GBPUSD',
    side: 'BUY',
    lots: 0.1,
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
  };
  const decision = evaluateRisk(opportunity, ctx({ openPositions: [open] }));
  assert.equal(decision.allowed, false);
  assert.ok(decision.blocks.some((b) => b.code === 'MAX_POSICOES'));
});

test('fora do horario permitido bloqueia', () => {
  // 07:00 UTC = 04:00 em Sao Paulo, antes da janela padrao das 05:00.
  const decision = evaluateRisk(opportunity, ctx({ nowIso: '2026-09-14T07:00:00.000Z', quote: { ...quote, at: '2026-09-14T07:00:00.000Z' }, }));
  assert.equal(decision.allowed, false);
  assert.ok(decision.blocks.some((b) => b.code === 'FORA_DE_HORARIO'));
});

test('spread acima do limite bloqueia', () => {
  const decision = evaluateRisk(opportunity, ctx({ quote: { ...quote, spreadPips: 9 } }));
  assert.equal(decision.allowed, false);
  assert.ok(decision.blocks.some((b) => b.code === 'SPREAD_ALTO'));
});

test('desvio de preco acima do limite bloqueia', () => {
  const decision = evaluateRisk(
    opportunity,
    ctx({ quote: { ...quote, bid: 1.0875, ask: 1.0876 } }),
  );
  assert.equal(decision.allowed, false);
  assert.ok(decision.blocks.some((b) => b.code === 'DESVIO_DE_PRECO'));
});

test('dimensionamento por risco separa valor da ordem de valor arriscado', () => {
  const sizing = computeSizing(
    'EURUSD',
    'BUY',
    1.085,
    1.083,
    1.088,
    { ...defaultRiskSettings, sizingMode: 'RISK_PERCENT', riskPercentPerTrade: 0.5 },
    account,
  );
  // 0,5% de USD 10.000 = USD 50. Stop de 20 pips a USD 10 por pip por lote = 0,25 lote.
  assert.equal(sizing.stopPips, 20);
  assert.equal(sizing.lots, 0.25);
  assert.equal(sizing.riskedValue, 50);
  assert.ok(sizing.notionalValue > sizing.riskedValue * 100);
});

test('dimensionamento por lote fixo ignora a distancia do stop', () => {
  const sizing = computeSizing(
    'EURUSD',
    'BUY',
    1.085,
    1.08,
    1.09,
    { ...defaultRiskSettings, sizingMode: 'FIXED_LOTS', fixedLots: 0.05 },
    account,
  );
  assert.equal(sizing.lots, 0.05);
  assert.equal(sizing.stopPips, 50);
});

test('resultado diario separa realizado, aberto e fluxos de caixa', () => {
  const open: Position = {
    id: 'pos1',
    orderId: 'o1',
    opportunityId: null,
    symbol: 'EURUSD',
    side: 'BUY',
    lots: 0.1,
    openPrice: 1.085,
    openedAt: NOW,
    stopLoss: null,
    takeProfit: null,
    closePrice: null,
    closedAt: null,
    closeReason: null,
    status: 'OPEN',
    grossPnl: 30,
    costs: 0.7,
    netPnl: 29.3,
    notionalValue: 10_850,
    riskedValue: 0,
    simulated: true,
  };
  const result = computeDailyResult(
    { ...day, realizedNetPnl: -40, costs: 2, cashFlows: 500 },
    [open],
    defaultRiskSettings,
  );
  assert.equal(result.limitBasisPnl, -40, 'limites diarios usam apenas o realizado');
  assert.equal(result.unrealizedPnl, 29.3);
  assert.equal(result.totalWithOpenPnl, -10.7);
  assert.equal(result.cashFlows, 500, 'deposito nao entra no resultado');
  assert.equal(result.lossLimitValue, -200);
});
