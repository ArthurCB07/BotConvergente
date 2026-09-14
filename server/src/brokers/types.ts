import type { AccountSnapshot, MarketId, Position, Quote, Side } from '../core/types.ts';

/**
 * Contrato unico de conexao, valido para corretora de forex e para exchange de
 * cripto. Toda integracao real futura implementa esta interface; a camada de
 * execucao nao conhece nenhum detalhe de protocolo.
 *
 * Uma conexao declara QUAIS mercados e quais instrumentos atende. O motor de risco
 * bloqueia o envio quando o instrumento nao e suportado: conexao de forex nao
 * opera cripto por presuncao.
 *
 * Credenciais ficam sempre no backend e nunca sao devolvidas por `describe()` nem
 * escritas em log.
 */

export type BrokerStatus = 'CONNECTED' | 'DISCONNECTED' | 'NOT_IMPLEMENTED' | 'ERROR';

export interface BrokerCapabilities {
  account: boolean;
  positions: boolean;
  marketOrders: boolean;
  attachedStops: boolean;
  cancelOrders: boolean;
  clientOrderIdLookup: boolean;
  demoEnvironment: boolean;
  requiresLocalTerminal: boolean;
}

export interface BrokerDescriptor {
  id: string;
  name: string;
  status: BrokerStatus;
  /** Mercados de topo atendidos. */
  markets: MarketId[];
  /** Classes de produto atendidas. */
  products: string[];
  capabilities: BrokerCapabilities;
  authentication: string;
  /** O que falta para habilitar a integracao. Vazio quando implementada. */
  requirements: string[];
  restrictions: string[];
  docsUrl: string;
  accountType: AccountSnapshot['accountType'];
  currency: string;
}

export interface PlaceOrderRequest {
  clientOrderId: string;
  symbol: string;
  side: Side;
  quantity: number;
  stopLoss: number | null;
  takeProfit: number | null;
  maxDeviationPips: number;
}

export type PlaceOrderResult =
  | { status: 'FILLED'; brokerOrderId: string; filledPrice: number; positionId: string }
  | { status: 'REJECTED'; reason: string }
  | { status: 'TIMEOUT'; reason: string }
  | { status: 'DUPLICATE'; brokerOrderId: string; filledPrice: number; positionId: string };

export interface BrokerAdapter {
  readonly id: string;
  describe(): BrokerDescriptor;
  /** A conexao negocia este instrumento? */
  supportsSymbol(symbol: string): boolean;
  isConnected(): boolean;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getAccount(): AccountSnapshot;
  getQuote(symbol: string): Quote | null;
  /**
   * Reserva margem de forma sincrona, antes de qualquer `await`. Devolve `false`
   * quando nao ha recurso livre. Sem isso, duas ordens simultaneas de mercados
   * diferentes na MESMA conta poderiam comprometer o mesmo saldo duas vezes.
   */
  reserveMargin(key: string, amount: number): boolean;
  releaseMargin(key: string): void;
  placeOrder(req: PlaceOrderRequest): Promise<PlaceOrderResult>;
  /**
   * Reconciliacao: consulta o estado de uma ordem pelo identificador de cliente.
   * Usada antes de qualquer reenvio apos timeout, para nao duplicar posicao.
   */
  findByClientOrderId(clientOrderId: string): Promise<PlaceOrderResult | null>;
  getPositions(): Position[];
  closePosition(positionId: string, reason: Position['closeReason']): Promise<void>;
  cancelAllPending(): Promise<number>;
}
