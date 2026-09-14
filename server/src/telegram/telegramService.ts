import { Api, TelegramClient, password as passwordHelper, utils } from 'teleproto';
import { StringSession } from 'teleproto/sessions';
import { EditedMessage, NewMessage } from 'teleproto/events';
import { getInstrument } from '../core/instruments.ts';
import { id as newId } from '../core/ids.ts';
import type { SignalInput } from '../core/ingestion.ts';
import type { MarketId } from '../core/types.ts';
import { MARKET_LABEL } from '../core/types.ts';
import type { Clock } from '../core/time.ts';
import { systemClock } from '../core/time.ts';
import type { Store } from '../infra/store.ts';
import { applyProfile, sanitizeIncomingText } from './parseProfiles.ts';
import type {
  CodeDelivery,
  CodeDeliveryMethod,
  ParseProfile,
  TelegramAccount,
  TelegramActivity,
  TelegramActivityKind,
  TelegramAuthState,
  TelegramDialog,
  TelegramRoom,
} from './types.ts';

/**
 * Integracao com o Telegram via MTProto, usando a CONTA DO USUARIO.
 *
 * Le as salas as quais a conta ja tem acesso. Nao exige bot adicionado pelos
 * administradores, nao depende do Telegram Desktop aberto, nunca entra em salas
 * novas e NUNCA envia mensagem.
 *
 * Segredos: `TELEGRAM_API_ID` e `TELEGRAM_API_HASH` vem do ambiente do backend e
 * nunca saem dele. O codigo de verificacao e a senha de duas etapas existem apenas
 * como argumento de funcao — nao sao gravados em lugar nenhum. A sessao e guardada
 * no banco local para sobreviver a reinicios.
 *
 * Conteudo recebido e DADO, nunca instrucao: nada vindo de uma mensagem altera
 * configuracao, executa codigo ou toca em credencial.
 */

const KV_SESSION = 'telegram.session';
const KV_ACCOUNT = 'telegram.account';

/** Intervalo minimo entre pedidos de reenvio, para nao virar rajada. */
const RESEND_COOLDOWN_SECONDS = 60;
/** Quantas mensagens buscar por sala ao recuperar uma lacuna. */
const GAP_RECOVERY_LIMIT = 50;
/** Frequencia com que a conexao e conferida. */
const WATCHDOG_INTERVAL_MS = 60_000;

/** O motor visto pelo servico. Interface estreita, para poder testar sem rede. */
export interface TelegramEngineBridge {
  nowIso(): string;
  /** Cria ou atualiza a fonte correspondente a sala. Devolve o id da fonte. */
  upsertSource(room: TelegramRoom): string;
  removeSource(sourceId: string): void;
  ingestSignal(input: SignalInput): { ok: boolean; message: string; signalId?: string };
}

export interface TelegramServiceOptions {
  apiId: string | undefined;
  apiHash: string | undefined;
  store: Store | null;
  bridge: TelegramEngineBridge;
  clock?: Clock;
  /** Injetavel para teste: evita abrir conexao real. */
  clientFactory?: (session: StringSession, apiId: number, apiHash: string) => TelegramClient;
  onUpdate?: () => void;
}

function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 5) return '•••';
  return `+${digits.slice(0, 2)} ••••• ${digits.slice(-4)}`;
}

/** Traduz o tipo de entrega informado pelo servico. Nao prometemos SMS. */
function deliveryOf(type: unknown): { method: CodeDeliveryMethod; label: string } {
  const name = (type as { className?: string })?.className ?? '';
  if (name.includes('SentCodeTypeApp')) {
    return { method: 'APP', label: 'Codigo enviado no proprio Telegram, em outro dispositivo conectado.' };
  }
  if (name.includes('SentCodeTypeSms')) return { method: 'SMS', label: 'Codigo enviado por SMS.' };
  if (name.includes('SentCodeTypeSmsWord')) {
    return { method: 'PALAVRA', label: 'O servico enviou uma PALAVRA por SMS, nao um numero.' };
  }
  if (name.includes('SentCodeTypeSmsPhrase')) {
    return { method: 'FRASE', label: 'O servico enviou uma FRASE por SMS, nao um numero.' };
  }
  if (name.includes('SentCodeTypeMissedCall')) {
    return {
      method: 'CHAMADA_PERDIDA',
      label: 'Voce recebera uma chamada perdida. O codigo sao os ultimos digitos do numero que ligou.',
    };
  }
  if (name.includes('SentCodeTypeCall')) {
    return { method: 'CHAMADA', label: 'Voce recebera uma chamada ditando o codigo.' };
  }
  if (name.includes('SentCodeTypeEmailCode')) {
    return { method: 'EMAIL', label: 'Codigo enviado para o e-mail cadastrado na conta.' };
  }
  if (name.includes('SentCodeTypeFragment')) {
    return { method: 'FRAGMENT', label: 'Codigo enviado pelo Fragment.' };
  }
  return { method: 'OUTRO', label: 'O servico escolheu outro metodo de entrega.' };
}

function peerIdOf(entity: unknown): string {
  try {
    return String(utils.getPeerId(entity as never));
  } catch {
    return '';
  }
}

function kindOf(entity: unknown): TelegramRoom['kind'] {
  const e = entity as { className?: string; broadcast?: boolean; megagroup?: boolean };
  if (e?.className === 'Channel') return e.broadcast ? 'CANAL' : 'GRUPO';
  if (e?.className === 'Chat') return 'GRUPO';
  if (e?.className === 'User') return 'PRIVADO';
  return 'DESCONHECIDO';
}

export class TelegramService {
  private readonly apiId: number | null;
  private readonly apiHash: string | undefined;
  private readonly store: Store | null;
  private readonly bridge: TelegramEngineBridge;
  private readonly clock: Clock;
  private readonly clientFactory?: TelegramServiceOptions['clientFactory'];
  private readonly onUpdate?: () => void;

  private client: TelegramClient | null = null;
  private session: StringSession | null = null;

  state: TelegramAuthState;
  account: TelegramAccount | null = null;
  private lastError: { code: string; message: string; waitSeconds: number | null } | null = null;

  /** Estado do login em andamento. Vive apenas em memoria. */
  private pending: {
    phone: string;
    phoneCodeHash: string;
    delivery: CodeDelivery;
    sentAt: number;
    resendCount: number;
  } | null = null;

  private rooms = new Map<string, TelegramRoom>();
  private activity: TelegramActivity[] = [];
  private dialogsCache: TelegramDialog[] = [];
  private dialogsFetchedAt: string | null = null;
  private handlersBound = false;
  private lastConnectionLossAt: string | null = null;
  private connectionLost = false;
  private watchdog: ReturnType<typeof setInterval> | null = null;

  constructor(options: TelegramServiceOptions) {
    const parsedId = Number(options.apiId);
    this.apiId = Number.isFinite(parsedId) && parsedId > 0 ? parsedId : null;
    this.apiHash = options.apiHash?.trim() || undefined;
    this.store = options.store;
    this.bridge = options.bridge;
    this.clock = options.clock ?? systemClock;
    this.clientFactory = options.clientFactory;
    this.onUpdate = options.onUpdate;
    this.state = this.configured ? 'DESCONECTADO' : 'SEM_CREDENCIAIS';
    this.loadRooms();
  }

  /** As duas variaveis existem? Isso NAO significa conectado. */
  get configured(): boolean {
    return this.apiId != null && this.apiHash != null;
  }

  // --- Persistencia ----------------------------------------------------------

  private loadRooms(): void {
    if (!this.store) return;
    for (const room of this.store.loadTelegramRooms()) this.rooms.set(room.peerId, room);
    this.activity = this.store.loadTelegramActivity(200);
    this.account = this.store.get<TelegramAccount>(KV_ACCOUNT) ?? null;
  }

  private saveRoom(room: TelegramRoom): void {
    this.rooms.set(room.peerId, room);
    this.store?.saveTelegramRoom(room);
  }

  private log(
    kind: TelegramActivityKind,
    severity: TelegramActivity['severity'],
    title: string,
    detail: string,
    extra: Partial<TelegramActivity> = {},
  ): TelegramActivity {
    const entry: TelegramActivity = {
      id: newId('tga'),
      at: this.clock.nowIso(),
      kind,
      severity,
      peerId: null,
      roomName: null,
      marketId: null,
      title,
      detail,
      originalText: null,
      messageId: null,
      messageVersion: 1,
      publishedAt: null,
      receivedAt: this.clock.nowIso(),
      parsed: null,
      signalId: null,
      ...extra,
    };
    this.activity.unshift(entry);
    if (this.activity.length > 400) this.activity.length = 400;
    this.store?.saveTelegramActivity(entry);
    this.onUpdate?.();
    return entry;
  }

  // --- Ciclo de vida do cliente ----------------------------------------------

  private buildClient(): TelegramClient {
    const saved = this.store?.get<string>(KV_SESSION) ?? '';
    this.session = new StringSession(saved);
    if (this.clientFactory) {
      return this.clientFactory(this.session, this.apiId as number, this.apiHash as string);
    }
    return new TelegramClient(this.session, this.apiId as number, this.apiHash as string, {
      connectionRetries: 5,
      autoReconnect: true,
      retryDelay: 2000,
      // A biblioteca ja registra o suficiente; nada de credencial vai para o log.
      baseLogger: undefined,
    });
  }

  private persistSession(): void {
    if (!this.session || !this.store) return;
    const saved = this.session.save();
    if (saved) this.store.put(KV_SESSION, saved);
  }

  /** Sobe o cliente e reaproveita a sessao salva, quando houver. */
  async init(): Promise<void> {
    if (!this.configured) return;
    try {
      this.state = 'CONECTANDO';
      this.onUpdate?.();
      this.client = this.buildClient();
      await this.client.connect();
      const authorized = await this.client.isUserAuthorized();
      if (authorized) {
        await this.afterLogin();
      } else {
        this.state = 'DESCONECTADO';
      }
    } catch (error) {
      this.captureError(error, 'Falha ao iniciar a conexao com o Telegram.');
    }
    this.onUpdate?.();
  }

  private captureError(error: unknown, fallback: string): void {
    const err = error as { errorMessage?: string; message?: string; seconds?: number };
    const code = err?.errorMessage ?? 'ERRO';
    let message = fallback;
    let waitSeconds: number | null = null;

    if (code === 'API_ID_INVALID' || code === 'API_ID_PUBLISHED_FLOOD') {
      message =
        'O Telegram recusou as credenciais da aplicacao. Confira TELEGRAM_API_ID e TELEGRAM_API_HASH no .env da raiz (os valores de my.telegram.org, do mesmo par) e reinicie o backend.';
    } else if (code === 'PHONE_CODE_INVALID') message = 'Codigo incorreto. Confira e digite de novo.';
    else if (code === 'PHONE_CODE_EXPIRED') {
      message = 'Codigo expirado. Peca um novo codigo para continuar.';
    } else if (code === 'PHONE_NUMBER_INVALID') message = 'Numero de telefone invalido.';
    else if (code === 'PASSWORD_HASH_INVALID') message = 'Senha de duas etapas incorreta.';
    else if (code === 'SESSION_PASSWORD_NEEDED') {
      message = 'Esta conta usa verificacao em duas etapas.';
    } else if (code === 'FLOOD' || code?.startsWith('FLOOD_WAIT')) {
      waitSeconds = err?.seconds ?? null;
      message = waitSeconds
        ? `O Telegram pediu para aguardar ${waitSeconds} s antes de tentar de novo.`
        : 'O Telegram pediu uma espera antes da proxima tentativa.';
    } else if (err?.message) {
      message = `${fallback} (${err.message})`;
    }

    this.lastError = { code, message, waitSeconds };
    if (this.state !== 'AGUARDANDO_CODIGO' && this.state !== 'AGUARDANDO_SENHA') {
      this.state = 'ERRO';
    }
  }

  // --- Fluxo de login --------------------------------------------------------

  /** Passo 1: pede o codigo. O telefone fica so em memoria. */
  async startLogin(phone: string): Promise<{ ok: boolean; message: string; delivery?: CodeDelivery }> {
    if (!this.configured) {
      return {
        ok: false,
        message:
          'Configuracao pendente: defina TELEGRAM_API_ID e TELEGRAM_API_HASH no ambiente do backend e reinicie o servico.',
      };
    }
    const cleaned = phone.replace(/[^\d+]/g, '');
    if (cleaned.replace(/\D/g, '').length < 8) {
      return { ok: false, message: 'Informe o telefone com codigo do pais, por exemplo +55 11 90000-0000.' };
    }

    try {
      this.lastError = null;
      this.state = 'CONECTANDO';
      if (!this.client) {
        this.client = this.buildClient();
        await this.client.connect();
      }

      const result = (await this.client.invoke(
        new Api.auth.SendCode({
          phoneNumber: cleaned,
          apiId: this.apiId as number,
          apiHash: this.apiHash as string,
          settings: new Api.CodeSettings({}),
        }),
      )) as unknown as {
        phoneCodeHash?: string;
        type?: unknown;
        timeout?: number;
        nextType?: unknown;
      };

      if (!result?.phoneCodeHash) {
        this.state = 'DESCONECTADO';
        return { ok: false, message: 'O Telegram nao devolveu um identificador de codigo.' };
      }

      const info = deliveryOf(result.type);
      const delivery: CodeDelivery = {
        method: info.method,
        label: info.label,
        length: (result.type as { length?: number })?.length ?? null,
        timeoutSeconds: result.timeout ?? null,
        nextMethod: result.nextType ? deliveryOf(result.nextType).method : null,
      };

      this.pending = {
        phone: cleaned,
        phoneCodeHash: result.phoneCodeHash,
        delivery,
        sentAt: Date.now(),
        resendCount: 0,
      };
      this.state = 'AGUARDANDO_CODIGO';
      this.onUpdate?.();
      return { ok: true, message: delivery.label, delivery };
    } catch (error) {
      this.captureError(error, 'Nao foi possivel pedir o codigo ao Telegram.');
      this.onUpdate?.();
      return { ok: false, message: this.lastError?.message ?? 'Falha ao pedir o codigo.' };
    }
  }

  /** Reenvio com carencia, para nao virar rajada de pedidos. */
  async resendCode(): Promise<{ ok: boolean; message: string; delivery?: CodeDelivery }> {
    if (!this.pending || !this.client) {
      return { ok: false, message: 'Nenhum login em andamento. Comece pelo telefone.' };
    }
    const elapsed = (Date.now() - this.pending.sentAt) / 1000;
    const minimum = this.pending.delivery.timeoutSeconds ?? RESEND_COOLDOWN_SECONDS;
    if (elapsed < minimum) {
      return {
        ok: false,
        message: `Aguarde ${Math.ceil(minimum - elapsed)} s antes de pedir outro codigo.`,
      };
    }
    if (this.pending.resendCount >= 3) {
      return {
        ok: false,
        message: 'Limite de reenvios atingido nesta tentativa. Recomece o login pelo telefone.',
      };
    }

    try {
      const result = (await this.client.invoke(
        new Api.auth.ResendCode({
          phoneNumber: this.pending.phone,
          phoneCodeHash: this.pending.phoneCodeHash,
        }),
      )) as unknown as { phoneCodeHash?: string; type?: unknown; timeout?: number };

      const info = deliveryOf(result.type);
      this.pending = {
        ...this.pending,
        phoneCodeHash: result.phoneCodeHash ?? this.pending.phoneCodeHash,
        delivery: {
          method: info.method,
          label: info.label,
          length: (result.type as { length?: number })?.length ?? null,
          timeoutSeconds: result.timeout ?? null,
          nextMethod: null,
        },
        sentAt: Date.now(),
        resendCount: this.pending.resendCount + 1,
      };
      this.onUpdate?.();
      return { ok: true, message: info.label, delivery: this.pending.delivery };
    } catch (error) {
      this.captureError(error, 'Falha ao pedir novo codigo.');
      return { ok: false, message: this.lastError?.message ?? 'Falha ao reenviar.' };
    }
  }

  /** Passo 2: confere o codigo. O codigo nao e guardado em lugar nenhum. */
  async submitCode(code: string): Promise<{ ok: boolean; message: string; needsPassword?: boolean }> {
    if (!this.pending || !this.client) {
      return { ok: false, message: 'Nenhum login em andamento. Comece pelo telefone.' };
    }
    const cleaned = code.trim();
    if (!cleaned) return { ok: false, message: 'Digite o codigo recebido.' };

    try {
      this.lastError = null;
      await this.client.invoke(
        new Api.auth.SignIn({
          phoneNumber: this.pending.phone,
          phoneCodeHash: this.pending.phoneCodeHash,
          phoneCode: cleaned,
        }),
      );
      await this.afterLogin();
      return { ok: true, message: 'Conta conectada.' };
    } catch (error) {
      const err = error as { errorMessage?: string };
      if (err?.errorMessage === 'SESSION_PASSWORD_NEEDED') {
        this.state = 'AGUARDANDO_SENHA';
        this.lastError = null;
        this.onUpdate?.();
        return {
          ok: true,
          needsPassword: true,
          message: 'Esta conta usa verificacao em duas etapas. Digite a senha para concluir.',
        };
      }
      this.captureError(error, 'Nao foi possivel validar o codigo.');
      this.onUpdate?.();
      return { ok: false, message: this.lastError?.message ?? 'Codigo recusado.' };
    }
  }

  /** Passo 3, apenas quando a conta pede: senha de duas etapas. Nunca gravada. */
  async submitPassword(password: string): Promise<{ ok: boolean; message: string }> {
    if (!this.client) return { ok: false, message: 'Nenhum login em andamento.' };
    if (!password) return { ok: false, message: 'Digite a senha de duas etapas.' };

    try {
      this.lastError = null;
      const passwordInfo = await this.client.invoke(new Api.account.GetPassword());
      const check = await passwordHelper.computeCheck(passwordInfo, password);
      await this.client.invoke(new Api.auth.CheckPassword({ password: check }));
      await this.afterLogin();
      return { ok: true, message: 'Conta conectada.' };
    } catch (error) {
      this.state = 'AGUARDANDO_SENHA';
      this.captureError(error, 'Nao foi possivel validar a senha.');
      this.onUpdate?.();
      return { ok: false, message: this.lastError?.message ?? 'Senha recusada.' };
    }
  }

  /** Encerra SOMENTE a sessao desta integracao. */
  async logout(): Promise<{ ok: boolean; message: string }> {
    try {
      if (this.client) {
        try {
          await this.client.invoke(new Api.auth.LogOut());
        } catch {
          // Mesmo sem confirmacao do servidor, a sessao local sai daqui.
        }
        await this.client.disconnect();
      }
    } finally {
      this.stopWatchdog();
      this.client = null;
      this.session = null;
      this.handlersBound = false;
      this.connectionLost = false;
      this.account = null;
      this.pending = null;
      this.state = this.configured ? 'DESCONECTADO' : 'SEM_CREDENCIAIS';
      this.store?.remove(KV_SESSION);
      this.store?.remove(KV_ACCOUNT);
      this.log(
        'CONEXAO_PERDIDA',
        'WARN',
        'Sessao do Telegram encerrada',
        'A sessao desta integracao foi encerrada. Suas outras sessoes do Telegram nao foram afetadas.',
      );
    }
    this.onUpdate?.();
    return { ok: true, message: 'Sessao encerrada.' };
  }

  /** Reconecta usando a sessao salva. */
  async reconnect(): Promise<{ ok: boolean; message: string }> {
    if (!this.configured) return { ok: false, message: 'Configuracao pendente.' };
    try {
      if (this.client) await this.client.disconnect().catch(() => undefined);
      this.client = null;
      this.handlersBound = false;
      await this.init();
      return this.state === 'CONECTADO'
        ? { ok: true, message: 'Conexao restabelecida.' }
        : { ok: false, message: this.lastError?.message ?? 'Nao foi possivel reconectar.' };
    } catch (error) {
      this.captureError(error, 'Falha ao reconectar.');
      return { ok: false, message: this.lastError?.message ?? 'Falha ao reconectar.' };
    }
  }

  private async afterLogin(): Promise<void> {
    if (!this.client) return;
    this.persistSession();
    this.pending = null;
    this.lastError = null;
    this.state = 'CONECTADO';

    try {
      const me = (await this.client.getMe()) as unknown as {
        id?: unknown;
        firstName?: string;
        lastName?: string;
        username?: string;
        phone?: string;
      };
      this.account = {
        userId: String(me?.id ?? ''),
        firstName: me?.firstName ?? null,
        lastName: me?.lastName ?? null,
        username: me?.username ?? null,
        phoneMasked: me?.phone ? maskPhone(me.phone) : null,
        connectedAt: this.clock.nowIso(),
      };
      this.store?.put(KV_ACCOUNT, this.account);
    } catch {
      // Sem os dados do perfil a conexao segue valida.
    }

    this.bindHandlers();
    this.startWatchdog();
    this.log(
      'CONEXAO_RECUPERADA',
      'SUCCESS',
      'Conta do Telegram conectada',
      `Sessao ativa${this.account?.phoneMasked ? ` para ${this.account.phoneMasked}` : ''}. Somente leitura das salas selecionadas.`,
    );
    void this.recoverGaps();
    this.onUpdate?.();
  }

  /**
   * Vigia a conexao. A biblioteca reconecta sozinha, porem uma queda silenciosa
   * faria a tela continuar dizendo "conectado" sem receber nada. O vigia separa
   * as duas situacoes: conectado e quieto, ou fora do ar.
   */
  private startWatchdog(): void {
    if (this.watchdog) return;
    this.watchdog = setInterval(() => {
      if (!this.client || this.state !== 'CONECTADO') return;
      const connected = (this.client as unknown as { connected?: boolean }).connected;
      if (connected === false && !this.connectionLost) {
        this.connectionLost = true;
        this.lastConnectionLossAt = this.clock.nowIso();
        this.log(
          'CONEXAO_PERDIDA',
          'BLOCK',
          'Conexao com o Telegram caiu',
          'Nenhuma mensagem esta sendo recebida agora. A reconexao e tentada automaticamente; as mensagens perdidas sao buscadas quando a conexao voltar.',
        );
      } else if (connected !== false && this.connectionLost) {
        this.connectionLost = false;
        this.log(
          'CONEXAO_RECUPERADA',
          'SUCCESS',
          'Conexao com o Telegram restabelecida',
          'Buscando as mensagens publicadas enquanto a conexao esteve fora.',
        );
        void this.recoverGaps();
      }
    }, WATCHDOG_INTERVAL_MS);
    this.watchdog.unref?.();
  }

  /** Encerra o vigia. Usado ao sair da sessao e no desligamento do processo. */
  stopWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
  }

  // --- Salas -----------------------------------------------------------------

  /** Conversas acessiveis a conta. Listar NAO habilita a leitura. */
  async listDialogs(force = false): Promise<TelegramDialog[]> {
    if (this.state !== 'CONECTADO' || !this.client) return this.dialogsCache;
    if (!force && this.dialogsFetchedAt) {
      const age = Date.parse(this.clock.nowIso()) - Date.parse(this.dialogsFetchedAt);
      if (age < 60_000) return this.dialogsCache;
    }
    try {
      const dialogs = await this.client.getDialogs({ limit: 300 });
      this.dialogsCache = dialogs
        .map((dialog) => {
          const entity = dialog.entity as unknown as { title?: string; username?: string; participantsCount?: number };
          const peerId = peerIdOf(dialog.entity);
          if (!peerId) return null;
          const configured = this.rooms.get(peerId);
          return {
            peerId,
            title: entity?.title ?? dialog.name ?? '(sem titulo)',
            username: entity?.username ?? null,
            kind: kindOf(dialog.entity),
            participants: entity?.participantsCount ?? null,
            configured: configured != null,
            monitoring: configured?.monitoring ?? false,
          } satisfies TelegramDialog;
        })
        .filter((d): d is TelegramDialog => d != null && d.kind !== 'PRIVADO');
      this.dialogsFetchedAt = this.clock.nowIso();
    } catch (error) {
      this.captureError(error, 'Nao foi possivel listar as conversas.');
    }
    this.onUpdate?.();
    return this.dialogsCache;
  }

  /** Adiciona ou atualiza a configuracao de uma sala. */
  configureRoom(input: {
    peerId: string;
    title?: string;
    displayName?: string;
    markets?: MarketId[];
    monitoring?: boolean;
    profile?: ParseProfile;
    participatesInConvergence?: boolean;
    independenceGroupId?: string;
    topicIds?: number[];
  }): { ok: boolean; message: string; room?: TelegramRoom } {
    const dialog = this.dialogsCache.find((d) => d.peerId === input.peerId);
    const existing = this.rooms.get(input.peerId);
    if (!dialog && !existing) {
      return { ok: false, message: 'Sala desconhecida. Atualize a lista de conversas.' };
    }

    const title = input.title ?? existing?.title ?? dialog?.title ?? '(sem titulo)';
    const room: TelegramRoom = {
      peerId: input.peerId,
      title,
      displayName: input.displayName ?? existing?.displayName ?? title,
      username: existing?.username ?? dialog?.username ?? null,
      kind: existing?.kind ?? dialog?.kind ?? 'DESCONHECIDO',
      markets: input.markets ?? existing?.markets ?? [],
      monitoring: input.monitoring ?? existing?.monitoring ?? false,
      profile: input.profile ?? existing?.profile ?? 'GENERICO',
      participatesInConvergence:
        input.participatesInConvergence ?? existing?.participatesInConvergence ?? true,
      independenceGroupId:
        input.independenceGroupId ?? existing?.independenceGroupId ?? `tg_${input.peerId}`,
      topicIds: input.topicIds ?? existing?.topicIds ?? [],
      sourceId: existing?.sourceId ?? null,
      state: 'NAO_SELECIONADA',
      stateDetail: existing?.stateDetail ?? null,
      lastMessageAt: existing?.lastMessageAt ?? null,
      lastValidSignalAt: existing?.lastValidSignalAt ?? null,
      lastMessageId: existing?.lastMessageId ?? null,
      validSignals: existing?.validSignals ?? 0,
      ignoredMessages: existing?.ignoredMessages ?? 0,
      createdAt: existing?.createdAt ?? this.clock.nowIso(),
    };

    if (room.monitoring && room.markets.length === 0) {
      return {
        ok: false,
        message: 'Escolha ao menos um mercado (Forex, Cripto ou ambos) antes de ligar o monitoramento.',
      };
    }

    room.state = room.monitoring ? 'MONITORANDO' : 'PAUSADA';
    // A fonte no motor existe enquanto a sala estiver classificada.
    room.sourceId = room.markets.length > 0 ? this.bridge.upsertSource(room) : room.sourceId;
    this.saveRoom(room);
    this.onUpdate?.();
    return { ok: true, message: 'Sala configurada.', room };
  }

  /** Pausar NAO apaga historico nem mexe em posicoes abertas. */
  setMonitoring(peerId: string, monitoring: boolean): { ok: boolean; message: string } {
    const room = this.rooms.get(peerId);
    if (!room) return { ok: false, message: 'Sala nao configurada.' };
    if (monitoring && room.markets.length === 0) {
      return { ok: false, message: 'Classifique o mercado da sala antes de ligar o monitoramento.' };
    }
    room.monitoring = monitoring;
    room.state = monitoring ? 'MONITORANDO' : 'PAUSADA';
    if (room.markets.length > 0) room.sourceId = this.bridge.upsertSource(room);
    this.saveRoom(room);
    this.onUpdate?.();
    return {
      ok: true,
      message: monitoring
        ? 'Monitoramento ligado.'
        : 'Monitoramento pausado. O historico e as posicoes abertas nao foram afetados.',
    };
  }

  removeRoom(peerId: string): { ok: boolean; message: string } {
    const room = this.rooms.get(peerId);
    if (!room) return { ok: false, message: 'Sala nao configurada.' };
    if (room.sourceId) this.bridge.removeSource(room.sourceId);
    this.rooms.delete(peerId);
    this.store?.deleteTelegramRoom(peerId);
    this.onUpdate?.();
    return { ok: true, message: 'Sala removida da integracao. O historico de atividade permanece.' };
  }

  // --- Recebimento -----------------------------------------------------------

  private bindHandlers(): void {
    if (!this.client || this.handlersBound) return;
    this.handlersBound = true;
    this.client.addEventHandler(
      (event: unknown) => void this.handleMessage(event, false),
      new NewMessage({}),
    );
    this.client.addEventHandler(
      (event: unknown) => void this.handleMessage(event, true),
      new EditedMessage({}),
    );
  }

  /** Processa uma mensagem recebida. Somente salas selecionadas chegam aqui. */
  private async handleMessage(event: unknown, edited: boolean): Promise<void> {
    const message = (event as { message?: Record<string, unknown> })?.message;
    if (!message) return;

    const peerId = peerIdOf((message as { peerId?: unknown }).peerId);
    const room = this.rooms.get(peerId);
    // Conversa nao selecionada: nada e lido, registrado ou exibido.
    if (!room || !room.monitoring) return;

    const receivedAt = this.clock.nowIso();
    const messageId = Number((message as { id?: number }).id ?? 0);
    const publishedAt = (message as { date?: number }).date
      ? new Date(Number((message as { date?: number }).date) * 1000).toISOString()
      : null;

    room.lastMessageAt = receivedAt;
    if (!edited && messageId > (room.lastMessageId ?? 0)) room.lastMessageId = messageId;

    const rawText = String(
      (message as { message?: string; text?: string }).message ??
        (message as { text?: string }).text ??
        '',
    );
    const text = sanitizeIncomingText(rawText);

    const base = {
      peerId,
      roomName: room.displayName,
      messageId,
      publishedAt,
      receivedAt,
      originalText: text || null,
      messageVersion: edited ? 2 : 1,
    };

    /*
     * Foruns: quando o usuario escolheu topicos, so os escolhidos sao lidos.
     * Lista vazia significa a sala inteira.
     */
    if (room.topicIds.length > 0) {
      const replyTo = (message as { replyTo?: Record<string, unknown> }).replyTo;
      const topicId = replyTo?.forumTopic
        ? Number(replyTo.replyToTopId ?? replyTo.replyToMsgId ?? 0)
        : 0;
      if (!room.topicIds.includes(topicId)) {
        room.ignoredMessages += 1;
        this.saveRoom(room);
        this.log(
          'MENSAGEM_IGNORADA',
          'INFO',
          `Mensagem fora dos topicos escolhidos em ${room.displayName}`,
          topicId
            ? `A mensagem veio do topico ${topicId}, que nao esta na selecao desta sala.`
            : 'A mensagem nao veio de um dos topicos selecionados desta sala.',
          base,
        );
        return;
      }
    }

    if (!text.trim()) {
      const hasMedia = (message as { media?: unknown }).media != null;
      room.ignoredMessages += 1;
      this.saveRoom(room);
      this.log(
        'FORMATO_NAO_SUPORTADO',
        'WARN',
        `Formato ainda nao suportado em ${room.displayName}`,
        hasMedia
          ? 'Mensagem com imagem ou audio. A leitura comeca por texto e legenda; outros formatos ainda nao sao interpretados.'
          : 'Mensagem sem texto.',
        base,
      );
      return;
    }

    const { draft, skipReason } = applyProfile(room.profile, text);

    if (!draft || skipReason) {
      room.ignoredMessages += 1;
      this.saveRoom(room);
      this.log(
        draft && draft.symbol ? 'SINAL_PENDENTE' : 'MENSAGEM_IGNORADA',
        'WARN',
        draft && draft.symbol
          ? `Sinal pendente de revisao em ${room.displayName}`
          : `Mensagem ignorada em ${room.displayName}`,
        skipReason ?? 'Mensagem sem conteudo operacional reconhecido.',
        { ...base, parsed: draft ? { ...draft } : null },
      );
      return;
    }

    const instrument = getInstrument(draft.symbol as string);
    if (!instrument) return;
    const marketId = instrument.marketId;

    // Sala mista: o mercado sai do INSTRUMENTO, sinal a sinal.
    if (!room.markets.includes(marketId)) {
      room.ignoredMessages += 1;
      this.saveRoom(room);
      this.log(
        'SINAL_PENDENTE',
        'WARN',
        `Mercado fora do cadastro da sala em ${room.displayName}`,
        `${instrument.symbol} e de ${MARKET_LABEL[marketId]}, e a sala esta cadastrada para ${
          room.markets.map((m) => MARKET_LABEL[m]).join(' e ') || 'nenhum mercado'
        }. O sinal fica pendente.`,
        { ...base, marketId, parsed: { ...draft } },
      );
      return;
    }

    if (!room.sourceId) {
      room.sourceId = this.bridge.upsertSource(room);
      this.saveRoom(room);
    }

    /*
     * O id da mensagem do Telegram vira o identificador externo do sinal. Com isso
     * a deduplicacao e o versionamento de edicao ja existentes no motor valem aqui:
     * reenvio da mesma mensagem nao cria voto novo, e edicao atualiza o sinal.
     */
    const externalMessageId = `tg:${peerId}:${messageId}`;
    const result = this.bridge.ingestSignal({
      sourceId: room.sourceId,
      raw: { text, externalMessageId, payload: { peerId, messageId, edited } },
      parsedBy: 'AI_ASSISTED',
      parserConfidence: draft.confidence,
      action: edited ? 'EDIT' : 'NEW',
      marketId,
      symbol: draft.symbol,
      venue: instrument.venue,
      side: draft.side,
      emittedAt: publishedAt,
      timeframeMinutes: draft.timeframeMinutes,
      horizonMinutes: draft.timeframeMinutes ? draft.timeframeMinutes * 4 : null,
      entryType: draft.entryPrice == null ? 'MARKET' : 'LIMIT',
      entryPrice: draft.entryPrice,
      stopLoss: draft.stopLoss,
      takeProfit: draft.takeProfit,
    });

    if (result.ok) {
      room.validSignals += 1;
      room.lastValidSignalAt = receivedAt;
      room.state = 'MONITORANDO';
    } else {
      room.state = 'ERRO_INTERPRETACAO';
      room.stateDetail = result.message;
    }
    this.saveRoom(room);

    this.log(
      edited ? 'SINAL_ATUALIZADO' : result.ok ? 'SINAL_RECONHECIDO' : 'SINAL_PENDENTE',
      result.ok ? 'SUCCESS' : 'WARN',
      edited
        ? `Sinal atualizado por edicao em ${room.displayName}`
        : result.ok
          ? `Sinal reconhecido em ${room.displayName}`
          : `Sinal recusado em ${room.displayName}`,
      result.ok
        ? `${draft.side === 'BUY' ? 'Compra' : 'Venda'} em ${instrument.symbol} (${MARKET_LABEL[marketId]}).${edited ? ' A edicao atualiza o sinal existente, sem criar voto novo.' : ''}`
        : result.message,
      { ...base, marketId, parsed: { ...draft }, signalId: result.signalId ?? null },
    );
  }

  /**
   * Apos uma queda, busca o que ficou para tras nas salas monitoradas.
   * Sinais vencidos entram como historico: a validacao de idade do motor impede
   * que disparem operacao.
   */
  private async recoverGaps(): Promise<void> {
    if (!this.client || this.state !== 'CONECTADO') return;
    for (const room of this.rooms.values()) {
      if (!room.monitoring || room.lastMessageId == null) continue;
      try {
        const messages = await this.client.getMessages(room.peerId, {
          minId: room.lastMessageId,
          limit: GAP_RECOVERY_LIMIT,
        });
        if (messages.length === 0) continue;
        this.log(
          'LACUNA_RECEBIMENTO',
          'WARN',
          `Recuperando ${messages.length} mensagem(ns) de ${room.displayName}`,
          `Mensagens publicadas enquanto a conexao estava fora. Sinais ja vencidos entram apenas como historico e nao disparam operacao.`,
          { peerId: room.peerId, roomName: room.displayName },
        );
        for (const message of [...messages].reverse()) {
          await this.handleMessage({ message }, false);
        }
        if (messages.length >= GAP_RECOVERY_LIMIT) {
          this.log(
            'LACUNA_RECEBIMENTO',
            'BLOCK',
            `Lacuna nao recuperada por completo em ${room.displayName}`,
            `Havia mais de ${GAP_RECOVERY_LIMIT} mensagens pendentes. As mais antigas nao foram lidas.`,
            { peerId: room.peerId, roomName: room.displayName },
          );
        }
      } catch (error) {
        const err = error as { errorMessage?: string };
        room.state = 'ACESSO_PERDIDO';
        room.stateDetail = `A conta perdeu acesso a esta sala (${err?.errorMessage ?? 'motivo nao informado'}).`;
        this.saveRoom(room);
        this.log(
          'ACESSO_PERDIDO',
          'BLOCK',
          `Acesso perdido em ${room.displayName}`,
          `${room.stateDetail} A integracao nao tenta contornar restricoes.`,
          { peerId: room.peerId, roomName: room.displayName },
        );
      }
    }
  }

  // --- Instantaneo -----------------------------------------------------------

  roomsList(): TelegramRoom[] {
    return [...this.rooms.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  activityList(limit = 120, peerId?: string): TelegramActivity[] {
    const list = peerId ? this.activity.filter((a) => a.peerId === peerId) : this.activity;
    return list.slice(0, limit);
  }

  snapshot() {
    const rooms = this.roomsList();
    const monitoring = rooms.filter((r) => r.monitoring);
    const lastSignalAt = rooms
      .map((r) => r.lastValidSignalAt)
      .filter((v): v is string => v != null)
      .sort()
      .at(-1) ?? null;
    const lastMessageAt = rooms
      .map((r) => r.lastMessageAt)
      .filter((v): v is string => v != null)
      .sort()
      .at(-1) ?? null;

    return {
      // Nunca expomos api_hash, sessao, telefone completo, codigo ou senha.
      configured: this.configured,
      state: this.state,
      account: this.account,
      pending: this.pending
        ? { phoneMasked: maskPhone(this.pending.phone), delivery: this.pending.delivery }
        : null,
      error: this.lastError,
      rooms,
      monitoredCount: monitoring.length,
      configuredCount: rooms.length,
      lastMessageAt,
      lastSignalAt,
      lastConnectionLossAt: this.lastConnectionLossAt,
      dialogs: this.dialogsCache,
      dialogsFetchedAt: this.dialogsFetchedAt,
      activity: this.activityList(60),
      setupHint: this.configured
        ? null
        : 'Defina TELEGRAM_API_ID e TELEGRAM_API_HASH no arquivo .env da raiz do projeto e reinicie o backend. Obtenha os valores em my.telegram.org.',
    };
  }
}

export type TelegramSnapshot = ReturnType<TelegramService['snapshot']>;
