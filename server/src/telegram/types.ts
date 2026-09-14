import type { MarketId } from '../core/types.ts';

/**
 * Tipos da integracao com o Telegram via MTProto (conta de usuario).
 *
 * A conta e sua: a integracao le as salas as quais voce ja tem acesso. Nao exige
 * bot adicionado pelos administradores, nao entra em salas novas sozinha e nunca
 * envia mensagem.
 */

export type TelegramAuthState =
  /** TELEGRAM_API_ID / TELEGRAM_API_HASH ausentes no ambiente do backend. */
  | 'SEM_CREDENCIAIS'
  /** Credenciais presentes, nenhuma sessao valida. */
  | 'DESCONECTADO'
  | 'CONECTANDO'
  /** Codigo enviado, aguardando o usuario digitar. */
  | 'AGUARDANDO_CODIGO'
  /** Conta com verificacao em duas etapas. */
  | 'AGUARDANDO_SENHA'
  | 'CONECTADO'
  | 'ERRO';

/** Como o Telegram entregou o codigo. Nunca prometemos SMS por conta propria. */
export type CodeDeliveryMethod =
  | 'APP'
  | 'SMS'
  | 'CHAMADA'
  | 'CHAMADA_PERDIDA'
  | 'EMAIL'
  | 'FRAGMENT'
  | 'PALAVRA'
  | 'FRASE'
  | 'OUTRO';

export interface CodeDelivery {
  method: CodeDeliveryMethod;
  /** Frase pronta para a interface, com o metodo real informado pelo servico. */
  label: string;
  /** Comprimento do codigo, quando informado. */
  length: number | null;
  /** Segundos ate poder pedir reenvio, quando informado. */
  timeoutSeconds: number | null;
  /** Proximo metodo que o servico tentaria, quando informado. */
  nextMethod: CodeDeliveryMethod | null;
}

export interface TelegramAccount {
  /** Identificador do usuario no Telegram. */
  userId: string;
  firstName: string | null;
  lastName: string | null;
  username: string | null;
  /** Telefone sempre mascarado. O numero completo nunca sai do backend. */
  phoneMasked: string | null;
  connectedAt: string;
}

/** Perfil de interpretacao aplicado as mensagens de uma sala. */
export type ParseProfile = 'GENERICO' | 'FOREX_CLASSICO' | 'CRIPTO_CLASSICO' | 'SOMENTE_MANUAL';

export type RoomMonitorState =
  | 'MONITORANDO'
  | 'PAUSADA'
  | 'ACESSO_PERDIDO'
  | 'ERRO_INTERPRETACAO'
  | 'NAO_SELECIONADA';

/** Sala do Telegram, identificada pelo ID estavel — nunca apenas pelo titulo. */
export interface TelegramRoom {
  /** ID estavel do peer no Telegram. Chave de tudo. */
  peerId: string;
  /** Titulo atual, apenas informativo: pode mudar a qualquer momento. */
  title: string;
  /** Nome escolhido pelo usuario para exibicao. */
  displayName: string;
  username: string | null;
  kind: 'GRUPO' | 'CANAL' | 'PRIVADO' | 'DESCONHECIDO';
  /** Mercados que esta sala alimenta. Vazio = nao classificada. */
  markets: MarketId[];
  /** Ingestao ligada. Listar uma conversa nao habilita a leitura dela. */
  monitoring: boolean;
  profile: ParseProfile;
  /** Participa da contagem de convergencia do mercado. */
  participatesInConvergence: boolean;
  /**
   * Salas que replicam a mesma origem compartilham este valor e contam como UM
   * voto, igual ao resto do sistema.
   */
  independenceGroupId: string;
  /** Topicos selecionados, quando a sala tem foruns. Vazio = todos. */
  topicIds: number[];
  /** Fonte correspondente no motor de convergencia. */
  sourceId: string | null;
  state: RoomMonitorState;
  stateDetail: string | null;
  lastMessageAt: string | null;
  lastValidSignalAt: string | null;
  /** Ultimo id de mensagem processado, para recuperar lacunas apos queda. */
  lastMessageId: number | null;
  validSignals: number;
  ignoredMessages: number;
  createdAt: string;
}

export type TelegramActivityKind =
  | 'MENSAGEM_RECEBIDA'
  | 'SINAL_RECONHECIDO'
  | 'MENSAGEM_IGNORADA'
  | 'SINAL_PENDENTE'
  | 'SINAL_ATUALIZADO'
  | 'SINAL_CANCELADO'
  | 'FORMATO_NAO_SUPORTADO'
  | 'CONEXAO_PERDIDA'
  | 'CONEXAO_RECUPERADA'
  | 'ACESSO_PERDIDO'
  | 'LACUNA_RECEBIMENTO';

export interface TelegramActivity {
  id: string;
  at: string;
  kind: TelegramActivityKind;
  severity: 'INFO' | 'WARN' | 'BLOCK' | 'SUCCESS';
  peerId: string | null;
  roomName: string | null;
  marketId: MarketId | null;
  title: string;
  detail: string;
  /** Mensagem original preservada, para conferencia lado a lado. */
  originalText: string | null;
  /** Id da mensagem no Telegram. */
  messageId: number | null;
  /** Versao da mensagem: edicoes incrementam. */
  messageVersion: number;
  /** Horario de publicacao informado pelo Telegram. */
  publishedAt: string | null;
  /** Horario em que este sistema recebeu. */
  receivedAt: string;
  /** Campos interpretados, para exibir ao lado do texto original. */
  parsed: Record<string, unknown> | null;
  signalId: string | null;
}

/** Conversa acessivel a conta, antes de virar sala monitorada. */
export interface TelegramDialog {
  peerId: string;
  title: string;
  username: string | null;
  kind: TelegramRoom['kind'];
  participants: number | null;
  /** Ja esta na lista de salas configuradas. */
  configured: boolean;
  monitoring: boolean;
}
