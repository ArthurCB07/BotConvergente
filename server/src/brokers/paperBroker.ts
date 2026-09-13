import {
  INSTRUMENTS,
  notionalValue,
  pipValueUsd,
  requireInstrument,
  requiredMargin,
  roundPrice,
  type Instrument,
} from '../core/instruments.ts';
import { id } from '../core/ids.ts';
import type { Clock } from '../core/time.ts';
import type { AccountSnapshot, Position, Quote } from '../core/types.ts';
import type {
  BrokerAdapter,
  BrokerDescriptor,
  PlaceOrderRequest,
  PlaceOrderResult,
} from './types.ts';

/**
 * Corretora SIMULADA.
 *
 * Isto NAO e uma conexao com corretora. E um simulador local, usado para exercitar
 * o fluxo completo do produto sem enviar nada para fora. Os precos vem de um
 * passeio aleatorio com semente fixa; nao reproduzem o mercado e nao servem para
 * estimar resultado. A interface exibe o rotulo SIMULADA em todas as telas.
 */

/** Comissao explicita por lote, ida e volta. Premissa de demonstracao. */
const COMMISSION_PER_LOT_ROUND_TURN = 7;

class SeededRandom {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0 || 1;
  }
  next(): number {
    // xorshift32
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state / 0xffffffff;
  }
  /** Normal padrao via Box-Muller. */
  gauss(): number {
    const u = Math.max(this.next(), 1e-9);
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}

interface PriceState {
  instrument: Instrument;
  mid: number;
  at: string;
}

export interface PaperBrokerOptions {
  clock: Clock;
  initialBalance?: number;
  seed?: number;
  onPositionClosed?: (position: Position) => void;
}

export class PaperBroker implements BrokerAdapter {
  private clock: Clock;
  private rng: SeededRandom;
  private prices = new Map<string, PriceState>();
  private positions: Position[] = [];
  /** Idempotencia: clientOrderId -> resultado ja produzido. */
  private ordersByClientId = new Map<string, PlaceOrderResult>();
  private connected = false;
  private balance: number;
  private onPositionClosed?: (position: Position) => void;

  /** Injecao de falha para os cenarios de demonstracao. */
  public failureMode: 'NONE' | 'TIMEOUT' | 'REJECT' | 'DISCONNECTED' = 'NONE';
  /** Congela o relogio das cotacoes, para simular dado desatualizado. */
  public freezeQuotes = false;
  /** Multiplicador de spread, para simular alargamento em noticia. */
  public spreadMultiplier = 1;

  constructor(options: PaperBrokerOptions) {
    this.clock = options.clock;
    this.rng = new SeededRandom(options.seed ?? 20260913);
    this.balance = options.initialBalance ?? 10_000;
    this.onPositionClosed = options.onPositionClosed;
    for (const instrument of INSTRUMENTS) {
      this.prices.set(instrument.symbol, {
        instrument,
        mid: instrument.referencePrice,
        at: this.clock.nowIso(),
      });
    }
  }

  describe(): BrokerDescriptor {
    return {
      id: 'paper',
      name: 'Simulador local (conta simulada)',
      status: this.connected ? 'CONNECTED' : 'DISCONNECTED',
      markets: ['FX_SPOT'],
      capabilities: {
        account: true,
        positions: true,
        marketOrders: true,
        attachedStops: true,
        cancelOrders: true,
        clientOrderIdLookup: true,
        demoEnvironment: true,
        requiresLocalTerminal: false,
      },
      authentication: 'Nenhuma. Executa dentro do proprio backend.',
      requirements: [],
      restrictions: [
        'Precos gerados localmente por passeio aleatorio com semente fixa.',
        'Nao reproduz liquidez, gaps de noticia nem rejeicoes reais de corretora.',
        'Resultados nao tem valor preditivo.',
      ],
      docsUrl: '',
      accountType: 'SIMULADA',
    };
  }

  isConnected(): boolean {
    return this.connected && this.failureMode !== 'DISCONNECTED';
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  // --- Precos ---------------------------------------------------------------

  /** Avanca o passeio aleatorio. Chamado pelo laco do servidor. */
  tick(elapsedSeconds: number): void {
    if (!this.isConnected() || this.freezeQuotes) return;
    const now = this.clock.nowIso();
    for (const state of this.prices.values()) {
      const { instrument } = state;
      // Volatilidade diaria em pips distribuida ao longo de 24h de negociacao.
      const perSecondPips = instrument.dailyVolatilityPips / Math.sqrt(24 * 60 * 60);
      const deltaPips = this.rng.gauss() * perSecondPips * Math.sqrt(Math.max(elapsedSeconds, 0.001));
      state.mid = state.mid + deltaPips * instrument.pipSize;
      state.at = now;
    }
    this.settleStops();
    this.markToMarket();
  }

  getQuote(symbol: string): Quote | null {
    const state = this.prices.get(symbol.toUpperCase());
    if (!state || !this.isConnected()) return null;
    const spreadPips = state.instrument.typicalSpreadPips * this.spreadMultiplier;
    const half = (spreadPips * state.instrument.pipSize) / 2;
    return {
      symbol: state.instrument.symbol,
      bid: roundPrice(state.instrument, state.mid - half),
      ask: roundPrice(state.instrument, state.mid + half),
      spreadPips: Math.round(spreadPips * 10) / 10,
      at: state.at,
    };
  }

  getAllQuotes(): Quote[] {
    return INSTRUMENTS.map((i) => this.getQuote(i.symbol)).filter((q): q is Quote => q != null);
  }

  /** Empurra o preco em N pips. Usado apenas pelos cenarios de demonstracao. */
  nudge(symbol: string, pips: number): void {
    const state = this.prices.get(symbol.toUpperCase());
    if (!state) return;
    state.mid += pips * state.instrument.pipSize;
    state.at = this.clock.nowIso();
    this.settleStops();
    this.markToMarket();
  }

  // --- Conta ----------------------------------------------------------------

  getAccount(): AccountSnapshot {
    const open = this.positions.filter((p) => p.status === 'OPEN');
    const unrealized = open.reduce((s, p) => s + p.netPnl, 0);
    const usedMargin = open.reduce((s, p) => {
      const instrument = requireInstrument(p.symbol);
      return s + requiredMargin(instrument, p.lots, p.openPrice);
    }, 0);
    const equity = this.balance + unrealized;
    const lastAt =
      [...this.prices.values()].map((p) => p.at).sort().at(-1) ?? this.clock.nowIso();
    return {
      accountId: 'SIM-0001',
      accountType: 'SIMULADA',
      brokerId: 'paper',
      currency: 'USD',
      balance: Math.round(this.balance * 100) / 100,
      equity: Math.round(equity * 100) / 100,
      usedMargin: Math.round(usedMargin * 100) / 100,
      freeMargin: Math.round((equity - usedMargin) * 100) / 100,
      connected: this.isConnected(),
      lastUpdateAt: lastAt,
    };
  }

  /** Deposito ou saque: entra no saldo, fora do resultado operacional. */
  applyCashFlow(amount: number): void {
    this.balance += amount;
  }

  // --- Ordens ---------------------------------------------------------------

  async placeOrder(req: PlaceOrderRequest): Promise<PlaceOrderResult> {
    // Idempotencia: mesma chave de cliente devolve o resultado anterior.
    const existing = this.ordersByClientId.get(req.clientOrderId);
    if (existing) {
      if (existing.status === 'FILLED') {
        return { ...existing, status: 'DUPLICATE' };
      }
      return existing;
    }

    if (!this.isConnected()) {
      const result: PlaceOrderResult = {
        status: 'REJECTED',
        reason: 'Corretora desconectada no momento do envio.',
      };
      return result;
    }

    if (this.failureMode === 'REJECT') {
      const result: PlaceOrderResult = {
        status: 'REJECTED',
        reason: 'Rejeicao simulada pela corretora (modo de falha ativo).',
      };
      this.ordersByClientId.set(req.clientOrderId, result);
      return result;
    }

    const instrument = requireInstrument(req.symbol);
    const quote = this.getQuote(req.symbol);
    if (!quote) {
      return { status: 'REJECTED', reason: 'Sem cotacao para o instrumento.' };
    }

    if (this.failureMode === 'TIMEOUT') {
      /*
       * Timeout: a ordem PODE ter sido aceita do outro lado. Registramos o
       * preenchimento internamente e devolvemos timeout ao chamador. A camada de
       * execucao precisa reconciliar por clientOrderId antes de reenviar,
       * exatamente como em uma integracao real.
       */
      const filled = this.fill(req, instrument, quote.bid, quote.ask);
      this.ordersByClientId.set(req.clientOrderId, filled);
      return { status: 'TIMEOUT', reason: 'Sem resposta da corretora dentro do tempo limite.' };
    }

    const filled = this.fill(req, instrument, quote.bid, quote.ask);
    this.ordersByClientId.set(req.clientOrderId, filled);
    return filled;
  }

  private fill(
    req: PlaceOrderRequest,
    instrument: Instrument,
    bid: number,
    ask: number,
  ): PlaceOrderResult {
    // Deslizamento simulado: fracao do spread, sempre contra o operador.
    const slipPips = Math.abs(this.rng.gauss()) * 0.3;
    const raw = req.side === 'BUY' ? ask + slipPips * instrument.pipSize : bid - slipPips * instrument.pipSize;
    const price = roundPrice(instrument, raw);

    const position: Position = {
      id: id('pos'),
      orderId: req.clientOrderId,
      opportunityId: null,
      symbol: req.symbol,
      side: req.side,
      lots: req.lots,
      openPrice: price,
      openedAt: this.clock.nowIso(),
      stopLoss: req.stopLoss,
      takeProfit: req.takeProfit,
      closePrice: null,
      closedAt: null,
      closeReason: null,
      status: 'OPEN',
      grossPnl: 0,
      costs: Math.round(COMMISSION_PER_LOT_ROUND_TURN * req.lots * 100) / 100,
      netPnl: 0,
      notionalValue: Math.round(notionalValue(instrument, req.lots, price) * 100) / 100,
      riskedValue:
        req.stopLoss == null
          ? 0
          : Math.round(
              pipValueUsd(instrument, req.lots) *
                (Math.abs(price - req.stopLoss) / instrument.pipSize) *
                100,
            ) / 100,
      simulated: true,
    };
    position.netPnl = -position.costs;
    this.positions.push(position);

    return {
      status: 'FILLED',
      brokerOrderId: id('brk'),
      filledPrice: price,
      positionId: position.id,
    };
  }

  async findByClientOrderId(clientOrderId: string): Promise<PlaceOrderResult | null> {
    return this.ordersByClientId.get(clientOrderId) ?? null;
  }

  /** Vincula a posicao recem-criada a oportunidade que a originou. */
  tagPosition(positionId: string, opportunityId: string): void {
    const position = this.positions.find((p) => p.id === positionId);
    if (position) position.opportunityId = opportunityId;
  }

  getPositions(): Position[] {
    return this.positions.map((p) => ({ ...p }));
  }

  async closePosition(positionId: string, reason: Position['closeReason']): Promise<void> {
    const position = this.positions.find((p) => p.id === positionId && p.status === 'OPEN');
    if (!position) return;
    const quote = this.getQuote(position.symbol);
    if (!quote) return;
    this.close(position, position.side === 'BUY' ? quote.bid : quote.ask, reason);
  }

  async cancelAllPending(): Promise<number> {
    // O simulador executa tudo a mercado: nao existem ordens pendentes.
    return 0;
  }

  // --- Motor interno --------------------------------------------------------

  private pnlOf(position: Position, exitPrice: number): number {
    const instrument = requireInstrument(position.symbol);
    const pips =
      (position.side === 'BUY' ? exitPrice - position.openPrice : position.openPrice - exitPrice) /
      instrument.pipSize;
    return pipValueUsd(instrument, position.lots) * pips;
  }

  private markToMarket(): void {
    for (const position of this.positions) {
      if (position.status !== 'OPEN') continue;
      const quote = this.getQuote(position.symbol);
      if (!quote) continue;
      const exit = position.side === 'BUY' ? quote.bid : quote.ask;
      position.grossPnl = Math.round(this.pnlOf(position, exit) * 100) / 100;
      position.netPnl = Math.round((position.grossPnl - position.costs) * 100) / 100;
    }
  }

  private settleStops(): void {
    for (const position of this.positions) {
      if (position.status !== 'OPEN') continue;
      const quote = this.getQuote(position.symbol);
      if (!quote) continue;
      const exit = position.side === 'BUY' ? quote.bid : quote.ask;
      if (position.stopLoss != null) {
        const hit = position.side === 'BUY' ? exit <= position.stopLoss : exit >= position.stopLoss;
        if (hit) {
          this.close(position, position.stopLoss, 'STOP_LOSS');
          continue;
        }
      }
      if (position.takeProfit != null) {
        const hit = position.side === 'BUY' ? exit >= position.takeProfit : exit <= position.takeProfit;
        if (hit) this.close(position, position.takeProfit, 'TAKE_PROFIT');
      }
    }
  }

  private close(position: Position, exitPrice: number, reason: Position['closeReason']): void {
    position.grossPnl = Math.round(this.pnlOf(position, exitPrice) * 100) / 100;
    position.netPnl = Math.round((position.grossPnl - position.costs) * 100) / 100;
    position.closePrice = exitPrice;
    position.closedAt = this.clock.nowIso();
    position.closeReason = reason;
    position.status = 'CLOSED';
    this.balance += position.netPnl;
    this.onPositionClosed?.({ ...position });
  }
}
