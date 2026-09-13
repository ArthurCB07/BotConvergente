import type { AccountSnapshot, Position, Quote, Side } from '../core/types.ts';

/**
 * Contrato unico de corretora.
 *
 * Toda integracao real futura (MetaTrader 5, cTrader, API propria de corretora)
 * implementa esta interface. A camada de execucao nao conhece nenhum detalhe de
 * protocolo. Credenciais ficam sempre no backend e nunca sao devolvidas por
 * `describe()` nem escritas em log.
 */

export type BrokerStatus = 'CONNECTED' | 'DISCONNECTED' | 'NOT_IMPLEMENTED' | 'ERROR';

export interface BrokerCapabilities {
  /** Consulta de saldo, patrimonio e margem. */
  account: boolean;
  /** Consulta de posicoes abertas. */
  positions: boolean;
  /** Envio de ordem a mercado. */
  marketOrders: boolean;
  /** Stop loss e take profit anexados a ordem. */
  attachedStops: boolean;
  /** Cancelamento de ordens pendentes. */
  cancelOrders: boolean;
  /** Reconciliacao por identificador de cliente. */
  clientOrderIdLookup: boolean;
  /** Ambiente de demonstracao oficial. */
  demoEnvironment: boolean;
  /** Exige terminal ou servico intermediario rodando. */
  requiresLocalTerminal: boolean;
}

export interface BrokerDescriptor {
  id: string;
  name: string;
  status: BrokerStatus;
  /** Mercados cobertos pelo adaptador. */
  markets: string[];
  capabilities: BrokerCapabilities;
  authentication: string;
  /** O que falta para habilitar a integracao. Vazio quando implementada. */
  requirements: string[];
  restrictions: string[];
  docsUrl: string;
  accountType: AccountSnapshot['accountType'];
}

export interface PlaceOrderRequest {
  clientOrderId: string;
  symbol: string;
  side: Side;
  lots: number;
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
  describe(): BrokerDescriptor;
  isConnected(): boolean;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getAccount(): AccountSnapshot;
  getQuote(symbol: string): Quote | null;
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
