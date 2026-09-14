import {
  INSTRUMENTS,
  getInstrument,
  notionalValue,
  pipSizeFor,
  pipValue,
  requireInstrument,
  requiredMargin,
  roundPrice,
  type Instrument,
} from '../core/instruments.ts';
import { id } from '../core/ids.ts';
import type { Clock } from '../core/time.ts';
import type { AccountSnapshot, MarketId, Position, Quote } from '../core/types.ts';
import type {
  BrokerAdapter,
  BrokerDescriptor,
  PlaceOrderRequest,
  PlaceOrderResult,
} from './types.ts';

/**
 * Conta SIMULADA.
 *
 * Isto NAO e uma conexao com corretora nem com exchange. E um simulador local,
 * usado para exercitar o fluxo do produto sem enviar nada para fora. Os precos vem
 * de um passeio aleatorio com semente fixa; nao reproduzem o mercado e nao servem
 * para estimar resultado. A interface exibe o rotulo SIMULADA em todas as telas.
 *
 * Uma instancia representa UMA conta. Ela pode atender os dois mercados (saldo
 * compartilhado) ou apenas um (contas separadas), conforme a configuracao.
 */

/** Comissao explicita por unidade de quantidade, ida e volta, na moeda da conta. */
const COMMISSION_PER_UNIT_ROUND_TURN: Record<MarketId, number> = {
  // USD 7 por lote em forex.
  FOREX: 7,
  // Aproxima 0,1% do nocional; calculado sobre o nocional, nao sobre a quantidade.
  CRYPTO: 0,
};
const CRYPTO_COMMISSION_RATE = 0.001;

class SeededRandom {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0 || 1;
  }
  /** Exposto para que o passeio aleatorio continue de onde parou apos reiniciar. */
  getState(): number {
    return this.state;
  }
  setState(state: number): void {
    this.state = state >>> 0 || 1;
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
  id: string;
  name: string;
  currency: string;
  /** Mercados atendidos por esta conta. */
  markets: MarketId[];
  clock: Clock;
  initialBalance?: number;
  seed?: number;
  onPositionOpened?: (position: Position) => void;
  onPositionClosed?: (position: Position) => void;
}

/** Estado do simulador que precisa sobreviver a um reinicio do processo. */
export interface PaperBrokerState {
  balance: number;
  rngState: number;
  prices: Array<{ symbol: string; mid: number; at: string }>;
  positions: Position[];
  orders: Array<{ clientOrderId: string; result: PlaceOrderResult }>;
}

export class PaperBroker implements BrokerAdapter {
  readonly id: string;
  private name: string;
  private currency: string;
  private markets: MarketId[];
  private clock: Clock;
  private rng: SeededRandom;
  private prices = new Map<string, PriceState>();
  private positions: Position[] = [];
  /** Idempotencia: clientOrderId -> resultado ja produzido. */
  private ordersByClientId = new Map<string, PlaceOrderResult>();
  /** Margem reservada por ordens em voo. Chave = clientOrderId. */
  private reservations = new Map<string, number>();
  private connected = false;
  private balance: number;
  private initialBalance: number;
  private onPositionOpened?: (position: Position) => void;
  private onPositionClosed?: (position: Position) => void;

  /** Injecao de falha para os cenarios de demonstracao. */
  public failureMode: 'NONE' | 'TIMEOUT' | 'REJECT' | 'DISCONNECTED' = 'NONE';
  /** Congela o relogio das cotacoes, para simular dado desatualizado. */
  public freezeQuotes = false;
  /** Multiplicador de spread, para simular alargamento em noticia. */
  public spreadMultiplier = 1;

  constructor(options: PaperBrokerOptions) {
    this.id = options.id;
    this.name = options.name;
    this.currency = options.currency;
    this.markets = options.markets;
    this.clock = options.clock;
    this.rng = new SeededRandom(options.seed ?? 20260913);
    this.initialBalance = options.initialBalance ?? 10_000;
    this.balance = this.initialBalance;
    this.onPositionOpened = options.onPositionOpened;
    this.onPositionClosed = options.onPositionClosed;
    for (const instrument of INSTRUMENTS) {
      if (!this.markets.includes(instrument.marketId)) continue;
      this.prices.set(instrument.symbol, {
        instrument,
        mid: instrument.referencePrice,
        at: this.clock.nowIso(),
      });
    }
  }

  supportsSymbol(symbol: string): boolean {
    const instrument = getInstrument(symbol);
    return instrument != null && this.markets.includes(instrument.marketId);
  }

  describe(): BrokerDescriptor {
    return {
      id: this.id,
      name: this.name,
      status: this.isConnected() ? 'CONNECTED' : 'DISCONNECTED',
      markets: [...this.markets],
      products: [
        ...new Set(
          INSTRUMENTS.filter((i) => this.markets.includes(i.marketId)).map((i) => i.productType),
        ),
      ],
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
        'Nao reproduz liquidez, gaps de noticia, funding de perpetuo nem rejeicoes reais.',
        'Resultados nao tem valor preditivo.',
      ],
      docsUrl: '',
      accountType: 'SIMULADA',
      currency: this.currency,
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
      // Volatilidade diaria em pips distribuida ao longo de 24h.
      const perSecondPips = instrument.dailyVolatilityPips / Math.sqrt(24 * 60 * 60);
      const deltaPips = this.rng.gauss() * perSecondPips * Math.sqrt(Math.max(elapsedSeconds, 0.001));
      state.mid = state.mid + deltaPips * pipSizeFor(instrument, state.mid);
      state.at = now;
    }
    this.settleStops();
    this.markToMarket();
  }

  getQuote(symbol: string): Quote | null {
    const state = this.prices.get(symbol.toUpperCase());
    if (!state || !this.isConnected()) return null;
    const spreadPips = state.instrument.typicalSpreadPips * this.spreadMultiplier;
    const half = (spreadPips * pipSizeFor(state.instrument, state.mid)) / 2;
    return {
      symbol: state.instrument.symbol,
      bid: roundPrice(state.instrument, state.mid - half),
      ask: roundPrice(state.instrument, state.mid + half),
      spreadPips: Math.round(spreadPips * 10) / 10,
      at: state.at,
    };
  }

  getAllQuotes(): Quote[] {
    return [...this.prices.keys()]
      .map((symbol) => this.getQuote(symbol))
      .filter((q): q is Quote => q != null);
  }

  /**
   * Ancora o preco simulado em uma referencia externa.
   *
   * Recusa se houver posicao aberta no instrumento: um salto de preco com posicao
   * viva dispararia stop ou alvo por um motivo que nao e movimento de mercado.
   * Entre ancoras, o passeio aleatorio continua — o preco do simulador nunca e
   * apresentado como cotacao real.
   */
  anchorPrice(symbol: string, mid: number): { applied: boolean; reason: string } {
    const state = this.prices.get(symbol.toUpperCase());
    if (!state) return { applied: false, reason: 'Instrumento fora desta conta.' };
    if (!Number.isFinite(mid) || mid <= 0) return { applied: false, reason: 'Preco invalido.' };
    if (this.positions.some((p) => p.status === 'OPEN' && p.symbol === state.instrument.symbol)) {
      return { applied: false, reason: 'Posicao aberta no instrumento: ancoragem adiada.' };
    }
    const before = state.mid;
    state.mid = mid;
    state.at = this.clock.nowIso();
    this.markToMarket();
    return {
      applied: true,
      reason: `Preco simulado de ${state.instrument.symbol} reancorado de ${before.toFixed(state.instrument.digits)} para ${mid.toFixed(state.instrument.digits)}.`,
    };
  }

  /** Empurra o preco em N pips. Usado apenas pelos cenarios de demonstracao. */
  nudge(symbol: string, pips: number): void {
    const state = this.prices.get(symbol.toUpperCase());
    if (!state) return;
    state.mid += pips * pipSizeFor(state.instrument, state.mid);
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
      return s + requiredMargin(instrument, p.quantity, p.openPrice);
    }, 0);
    const reserved = [...this.reservations.values()].reduce((s, v) => s + v, 0);
    const equity = this.balance + unrealized;
    const lastAt = [...this.prices.values()].map((p) => p.at).sort().at(-1) ?? this.clock.nowIso();
    return {
      accountId: `SIM-${this.id.toUpperCase()}`,
      accountType: 'SIMULADA',
      brokerId: this.id,
      brokerName: this.name,
      currency: this.currency,
      markets: [...this.markets],
      balance: Math.round(this.balance * 100) / 100,
      equity: Math.round(equity * 100) / 100,
      usedMargin: Math.round(usedMargin * 100) / 100,
      reservedMargin: Math.round(reserved * 100) / 100,
      freeMargin: Math.round((equity - usedMargin - reserved) * 100) / 100,
      connected: this.isConnected(),
      lastUpdateAt: lastAt,
    };
  }

  /** Deposito ou saque: entra no saldo, fora do resultado operacional. */
  applyCashFlow(amount: number): void {
    this.balance += amount;
  }

  // --- Reserva de margem ----------------------------------------------------

  /**
   * Sincrono de proposito. O motor reserva ANTES de qualquer `await`, entao duas
   * ordens de mercados diferentes na mesma conta nunca enxergam a mesma margem
   * livre como disponivel.
   */
  reserveMargin(key: string, amount: number): boolean {
    if (this.reservations.has(key)) return true;
    if (amount <= 0) {
      this.reservations.set(key, 0);
      return true;
    }
    const account = this.getAccount();
    if (amount > account.freeMargin) return false;
    this.reservations.set(key, amount);
    return true;
  }

  releaseMargin(key: string): void {
    this.reservations.delete(key);
  }

  // --- Ordens ---------------------------------------------------------------

  async placeOrder(req: PlaceOrderRequest): Promise<PlaceOrderResult> {
    // Idempotencia: mesma chave de cliente devolve o resultado anterior.
    const existing = this.ordersByClientId.get(req.clientOrderId);
    if (existing) {
      if (existing.status === 'FILLED') return { ...existing, status: 'DUPLICATE' };
      return existing;
    }

    if (!this.isConnected()) {
      return { status: 'REJECTED', reason: 'Conexao indisponivel no momento do envio.' };
    }

    if (!this.supportsSymbol(req.symbol)) {
      return {
        status: 'REJECTED',
        reason: `${this.name} nao negocia ${req.symbol}.`,
      };
    }

    if (this.failureMode === 'REJECT') {
      const result: PlaceOrderResult = {
        status: 'REJECTED',
        reason: 'Rejeicao simulada pela conexao (modo de falha ativo).',
      };
      this.ordersByClientId.set(req.clientOrderId, result);
      return result;
    }

    const instrument = requireInstrument(req.symbol);
    const quote = this.getQuote(req.symbol);
    if (!quote) return { status: 'REJECTED', reason: 'Sem cotacao para o instrumento.' };

    if (req.quantity < instrument.minQuantity) {
      return {
        status: 'REJECTED',
        reason: `Quantidade ${req.quantity} abaixo do minimo ${instrument.minQuantity} ${instrument.quantityLabel}.`,
      };
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
      return { status: 'TIMEOUT', reason: 'Sem resposta da conexao dentro do tempo limite.' };
    }

    const filled = this.fill(req, instrument, quote.bid, quote.ask);
    this.ordersByClientId.set(req.clientOrderId, filled);
    return filled;
  }

  private commissionFor(instrument: Instrument, quantity: number, price: number): number {
    if (instrument.marketId === 'CRYPTO') {
      return notionalValue(instrument, quantity, price) * CRYPTO_COMMISSION_RATE * 2;
    }
    return COMMISSION_PER_UNIT_ROUND_TURN[instrument.marketId] * quantity;
  }

  private fill(
    req: PlaceOrderRequest,
    instrument: Instrument,
    bid: number,
    ask: number,
  ): PlaceOrderResult {
    // Deslizamento simulado: fracao do spread, sempre contra o operador.
    const slipPips = Math.abs(this.rng.gauss()) * 0.3;
    const pip = pipSizeFor(instrument, (bid + ask) / 2);
    const raw = req.side === 'BUY' ? ask + slipPips * pip : bid - slipPips * pip;
    const price = roundPrice(instrument, raw);

    const position: Position = {
      id: id('pos'),
      orderId: req.clientOrderId,
      opportunityId: null,
      marketId: instrument.marketId,
      productType: instrument.productType,
      accountId: `SIM-${this.id.toUpperCase()}`,
      brokerId: this.id,
      symbol: req.symbol,
      side: req.side,
      quantity: req.quantity,
      quantityLabel: instrument.quantityLabel,
      openPrice: price,
      openedAt: this.clock.nowIso(),
      stopLoss: req.stopLoss,
      takeProfit: req.takeProfit,
      closePrice: null,
      closedAt: null,
      closeReason: null,
      status: 'OPEN',
      grossPnl: 0,
      costs: Math.round(this.commissionFor(instrument, req.quantity, price) * 100) / 100,
      netPnl: 0,
      notionalValue: Math.round(notionalValue(instrument, req.quantity, price) * 100) / 100,
      riskedValue:
        req.stopLoss == null
          ? 0
          : Math.round(
              pipValue(instrument, req.quantity, price) *
                (Math.abs(price - req.stopLoss) / pipSizeFor(instrument, price)) *
                100,
            ) / 100,
      simulated: true,
    };
    position.netPnl = -position.costs;
    this.positions.push(position);
    this.onPositionOpened?.({ ...position });

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
      pipSizeFor(instrument, position.openPrice);
    return pipValue(instrument, position.quantity, position.openPrice) * pips;
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

  // --- Persistencia ---------------------------------------------------------

  serialize(): PaperBrokerState {
    return {
      balance: this.balance,
      rngState: this.rng.getState(),
      prices: [...this.prices.values()].map((p) => ({
        symbol: p.instrument.symbol,
        mid: p.mid,
        at: p.at,
      })),
      positions: this.positions.map((p) => ({ ...p })),
      orders: [...this.ordersByClientId.entries()].map(([clientOrderId, result]) => ({
        clientOrderId,
        result,
      })),
    };
  }

  /** Volta ao estado inicial. Usado pelo reinicio do ambiente de demonstracao. */
  reset(balance: number, seed: number): void {
    this.balance = balance;
    this.rng.setState(seed);
    this.positions = [];
    this.ordersByClientId = new Map();
    this.reservations = new Map();
    this.failureMode = 'NONE';
    this.freezeQuotes = false;
    this.spreadMultiplier = 1;
    for (const state of this.prices.values()) {
      state.mid = state.instrument.referencePrice;
      state.at = this.clock.nowIso();
    }
  }

  /**
   * Recarrega o estado salvo. Nao dispara `onPositionClosed`: as posicoes ja
   * fechadas antes do reinicio ja foram contabilizadas no dia em que fecharam.
   */
  restore(state: PaperBrokerState): void {
    this.balance = state.balance;
    this.rng.setState(state.rngState);
    for (const price of state.prices) {
      const current = this.prices.get(price.symbol);
      if (current) {
        current.mid = price.mid;
        current.at = price.at;
      }
    }
    this.positions = state.positions.map((p) => ({ ...p }));
    this.ordersByClientId = new Map(state.orders.map((o) => [o.clientOrderId, o.result]));
    this.reservations = new Map();
  }
}
