import assert from 'node:assert/strict';
import { test } from 'node:test';
import bigInt from 'big-integer';
import { Api } from 'teleproto';
import { FakeClock } from '../src/core/time.ts';
import { Engine } from '../src/engine/engine.ts';
import { Store } from '../src/infra/store.ts';
import { seed } from '../src/seed.ts';
import { createTelegramEngineBridge } from '../src/telegram/engineBridge.ts';
import { TelegramService } from '../src/telegram/telegramService.ts';

/**
 * Testes da integracao com o Telegram usando um cliente MTProto falso.
 *
 * O que estes testes cobrem: selecao de salas, isolamento entre Forex e Cripto,
 * interpretacao, duplicacao, edicao, formatos nao suportados, perda de acesso,
 * recuperacao de lacuna e o que o painel expoe.
 *
 * O que eles NAO cobrem, e nao poderiam: a conversa real com os servidores do
 * Telegram. Isso depende de `TELEGRAM_API_ID` e `TELEGRAM_API_HASH` reais e de uma
 * conta autenticada.
 */

const NOW = '2026-09-14T14:00:00.000Z';
const NOW_EPOCH = Math.floor(Date.parse(NOW) / 1000);

const SALA_FOREX = bigInt(1000001);
const SALA_CRIPTO = bigInt(1000002);
const SALA_MISTA = bigInt(1000003);
const SALA_REPLICA = bigInt(1000004);

function channel(id: bigInt.BigInteger, title: string) {
  return new Api.Channel({
    id,
    title,
    date: NOW_EPOCH,
    broadcast: true,
    photo: new Api.ChatPhotoEmpty(),
  } as never);
}

/** peerId como o servico calcula: id estavel, nunca o titulo. */
function peerIdOf(id: bigInt.BigInteger): string {
  return `-100${id.toString()}`;
}

function message(id: bigInt.BigInteger, messageId: number, text: string, extra: object = {}) {
  return {
    id: messageId,
    peerId: new Api.PeerChannel({ channelId: id }),
    date: NOW_EPOCH,
    message: text,
    ...extra,
  };
}

class FakeTelegramClient {
  /** [0] = mensagem nova, [1] = mensagem editada, na ordem em que o servico registra. */
  handlers: Array<(event: unknown) => void> = [];
  authorized = false;
  requiresPassword = false;
  passwordAccepted = false;
  sendCodeCalls = 0;
  resendCalls = 0;
  loggedOut = false;
  channels = [
    channel(SALA_FOREX, 'Sinais Forex Pro'),
    channel(SALA_CRIPTO, 'Cripto Alpha'),
    channel(SALA_MISTA, 'Mesa Mista'),
    channel(SALA_REPLICA, 'Sinais Forex Pro (espelho)'),
  ];
  /** Mensagens que aparecem numa busca de lacuna, por peerId. */
  backlog = new Map<string, ReturnType<typeof message>[]>();
  /** Salas onde a conta perdeu acesso. */
  denied = new Set<string>();

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async isUserAuthorized(): Promise<boolean> {
    return this.authorized;
  }
  addEventHandler(callback: (event: unknown) => void): void {
    this.handlers.push(callback);
  }
  async getMe() {
    return {
      id: bigInt(777),
      firstName: 'Tiago',
      lastName: null,
      username: 'tiago',
      phone: '5511987654321',
    };
  }
  async getDialogs() {
    return this.channels.map((entity) => ({ entity, name: entity.title }));
  }
  async getMessages(peer: string, options: { minId?: number; limit?: number }) {
    if (this.denied.has(peer)) {
      throw Object.assign(new Error('CHANNEL_PRIVATE'), { errorMessage: 'CHANNEL_PRIVATE' });
    }
    const all = this.backlog.get(peer) ?? [];
    return all.filter((m) => m.id > (options.minId ?? 0)).slice(0, options.limit ?? 50);
  }

  async invoke(request: unknown): Promise<unknown> {
    const name = (request as { className?: string }).className ?? '';
    if (name === 'auth.SendCode') {
      this.sendCodeCalls += 1;
      return {
        phoneCodeHash: 'hash-de-teste',
        type: new Api.auth.SentCodeTypeApp({ length: 5 }),
        timeout: 60,
        nextType: new Api.auth.CodeTypeSms(),
      };
    }
    if (name === 'auth.ResendCode') {
      this.resendCalls += 1;
      return { phoneCodeHash: 'hash-de-teste-2', type: new Api.auth.SentCodeTypeSms({ length: 5 }), timeout: 60 };
    }
    if (name === 'auth.SignIn') {
      const code = (request as { phoneCode?: string }).phoneCode;
      if (code !== '12345') {
        throw Object.assign(new Error('PHONE_CODE_INVALID'), { errorMessage: 'PHONE_CODE_INVALID' });
      }
      if (this.requiresPassword && !this.passwordAccepted) {
        throw Object.assign(new Error('SESSION_PASSWORD_NEEDED'), {
          errorMessage: 'SESSION_PASSWORD_NEEDED',
        });
      }
      this.authorized = true;
      return {};
    }
    if (name === 'auth.LogOut') {
      this.loggedOut = true;
      this.authorized = false;
      return true;
    }
    throw new Error(`chamada nao prevista no cliente falso: ${name}`);
  }

  /**
   * Entrega uma mensagem como o Telegram entregaria: o evento vai para UM
   * manipulador, o de mensagem nova ou o de mensagem editada.
   */
  async deliver(msg: ReturnType<typeof message>, edited = false): Promise<void> {
    const handler = this.handlers[edited ? 1 : 0];
    if (handler) await handler({ message: msg });
  }
}

interface Harness {
  engine: Engine;
  store: Store;
  service: TelegramService;
  client: FakeTelegramClient;
  close(): void;
}

function buildHarness(options: { credentials?: boolean; requiresPassword?: boolean } = {}): Harness {
  const clock = new FakeClock(NOW);
  const store = new Store(':memory:');
  const engine = new Engine({ clock, initialBalance: 10_000, cryptoInitialBalance: 5_000, store });
  seed(engine);

  const client = new FakeTelegramClient();
  client.requiresPassword = options.requiresPassword ?? false;

  const service = new TelegramService({
    apiId: options.credentials === false ? undefined : '123456',
    apiHash: options.credentials === false ? undefined : 'hash-local-de-teste',
    store,
    clock,
    bridge: createTelegramEngineBridge(engine),
    clientFactory: () => client as never,
  });

  return { engine, store, service, client, close: () => store.close() };
}

async function connect(harness: Harness): Promise<void> {
  const started = await harness.service.startLogin('+55 11 98765-4321');
  assert.equal(started.ok, true);
  const signed = await harness.service.submitCode('12345');
  assert.equal(signed.ok, true);
  await harness.service.listDialogs(true);
}

// --- Credenciais -----------------------------------------------------------

test('sem credenciais o estado e SEM_CREDENCIAIS e o login explica o que falta', async () => {
  const harness = buildHarness({ credentials: false });
  try {
    assert.equal(harness.service.configured, false);
    assert.equal(harness.service.state, 'SEM_CREDENCIAIS');

    const result = await harness.service.startLogin('+5511987654321');
    assert.equal(result.ok, false);
    assert.match(result.message, /TELEGRAM_API_ID/);
    assert.match(result.message, /TELEGRAM_API_HASH/);

    const snapshot = harness.service.snapshot();
    assert.equal(snapshot.configured, false);
    assert.ok(snapshot.setupHint);
  } finally {
    harness.close();
  }
});

test('credenciais presentes NAO significam conta conectada', () => {
  const harness = buildHarness();
  try {
    assert.equal(harness.service.configured, true);
    assert.equal(harness.service.state, 'DESCONECTADO');
    assert.equal(harness.service.snapshot().account, null);
  } finally {
    harness.close();
  }
});

// --- Fluxo de login --------------------------------------------------------

test('o metodo de entrega mostrado e o que o servico informou', async () => {
  const harness = buildHarness();
  try {
    const result = await harness.service.startLogin('+55 11 98765-4321');
    assert.equal(result.delivery?.method, 'APP');
    // Nao prometemos SMS quando o servico entregou no aplicativo.
    assert.doesNotMatch(result.message, /SMS/i);
    assert.equal(harness.service.state, 'AGUARDANDO_CODIGO');
  } finally {
    harness.close();
  }
});

test('codigo incorreto mantem o passo do codigo, sem reenvio automatico', async () => {
  const harness = buildHarness();
  try {
    await harness.service.startLogin('+5511987654321');
    const bad = await harness.service.submitCode('00000');
    assert.equal(bad.ok, false);
    assert.match(bad.message, /Codigo incorreto/);
    assert.equal(harness.service.state, 'AGUARDANDO_CODIGO');
    // Uma unica solicitacao de codigo: nada de rajada.
    assert.equal(harness.client.sendCodeCalls, 1);
    assert.equal(harness.client.resendCalls, 0);
  } finally {
    harness.close();
  }
});

test('reenvio antes da espera informada e recusado', async () => {
  const harness = buildHarness();
  try {
    await harness.service.startLogin('+5511987654321');
    const resend = await harness.service.resendCode();
    assert.equal(resend.ok, false);
    assert.match(resend.message, /Aguarde/);
    assert.equal(harness.client.resendCalls, 0);
  } finally {
    harness.close();
  }
});

test('conta com duas etapas pede senha apenas quando o servico solicita', async () => {
  const harness = buildHarness({ requiresPassword: true });
  try {
    await harness.service.startLogin('+5511987654321');
    const result = await harness.service.submitCode('12345');
    assert.equal(result.needsPassword, true);
    assert.equal(harness.service.state, 'AGUARDANDO_SENHA');

    const empty = await harness.service.submitPassword('');
    assert.equal(empty.ok, false);
    assert.equal(harness.service.state, 'AGUARDANDO_SENHA');
  } finally {
    harness.close();
  }
});

test('conexao bem-sucedida mascara o telefone e nao expoe segredo', async () => {
  const harness = buildHarness();
  try {
    await connect(harness);
    assert.equal(harness.service.state, 'CONECTADO');

    const snapshot = harness.service.snapshot();
    assert.equal(snapshot.account?.username, 'tiago');
    assert.match(String(snapshot.account?.phoneMasked), /^\+55 ••••• 4321$/);

    const serialized = JSON.stringify(snapshot);
    assert.equal(serialized.includes('hash-local-de-teste'), false);
    assert.equal(serialized.includes('5511987654321'), false);
    assert.equal(serialized.includes('12345'), false);
  } finally {
    harness.close();
  }
});

// --- Selecao de salas ------------------------------------------------------

test('listar conversas nao habilita leitura de nenhuma delas', async () => {
  const harness = buildHarness();
  try {
    await connect(harness);
    const dialogs = await harness.service.listDialogs(true);
    assert.equal(dialogs.length, 4);
    assert.equal(dialogs.every((d) => !d.configured && !d.monitoring), true);
    assert.equal(harness.service.roomsList().length, 0);

    await harness.client.deliver(message(SALA_FOREX, 10, 'COMPRA EURUSD entrada 1.0850 sl 1.0830 tp 1.0880'));

    // Nenhuma leitura: sem sinal, sem atividade e sem fonte criada.
    assert.equal(harness.service.activityList().length, 1); // apenas o evento de conexao
    assert.equal(harness.engine.signals.filter((s) => s.sourceId.startsWith('src_tg_')).length, 0);
  } finally {
    harness.close();
  }
});

test('sala e identificada pelo id estavel, nao pelo titulo', async () => {
  const harness = buildHarness();
  try {
    await connect(harness);
    const peerId = peerIdOf(SALA_FOREX);
    harness.service.configureRoom({ peerId, markets: ['FOREX'], monitoring: true });

    // O administrador renomeia a sala.
    harness.client.channels[0] = channel(SALA_FOREX, 'Outro Nome Completamente Diferente');
    await harness.service.listDialogs(true);

    const room = harness.service.roomsList()[0];
    assert.equal(room?.peerId, peerId);
    assert.equal(room?.monitoring, true);
  } finally {
    harness.close();
  }
});

test('monitorar exige mercado classificado', async () => {
  const harness = buildHarness();
  try {
    await connect(harness);
    const result = harness.service.configureRoom({
      peerId: peerIdOf(SALA_FOREX),
      markets: [],
      monitoring: true,
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /mercado/i);
  } finally {
    harness.close();
  }
});

// --- Interpretacao ---------------------------------------------------------

test('sala monitorada interpreta o sinal e preserva o texto original', async () => {
  const harness = buildHarness();
  try {
    await connect(harness);
    const peerId = peerIdOf(SALA_FOREX);
    harness.service.configureRoom({ peerId, markets: ['FOREX'], monitoring: true });

    const texto = 'COMPRA EURUSD M15 entrada 1.0850 sl 1.0830 tp 1.0880';
    await harness.client.deliver(message(SALA_FOREX, 11, texto));

    const signal = harness.engine.signals.find((s) => s.raw.externalMessageId === `tg:${peerId}:11`);
    assert.ok(signal, 'sinal criado');
    assert.equal(signal.symbol, 'EURUSD');
    assert.equal(signal.side, 'BUY');
    assert.equal(signal.marketId, 'FOREX');
    assert.equal(signal.status, 'VALID');

    const entry = harness.service.activityList().find((a) => a.messageId === 11);
    assert.equal(entry?.kind, 'SINAL_RECONHECIDO');
    assert.equal(entry?.originalText, texto);
    assert.ok(entry?.publishedAt, 'horario de publicacao registrado');
    assert.ok(entry?.receivedAt, 'horario de recebimento registrado');

    const room = harness.service.roomsList()[0];
    assert.equal(room?.validSignals, 1);
  } finally {
    harness.close();
  }
});

test('mensagem sem instrumento reconhecido fica pendente, nao vira sinal', async () => {
  const harness = buildHarness();
  try {
    await connect(harness);
    harness.service.configureRoom({
      peerId: peerIdOf(SALA_FOREX),
      markets: ['FOREX'],
      monitoring: true,
    });
    await harness.client.deliver(message(SALA_FOREX, 12, 'Bom dia, mesa aberta. Aguardem o setup.'));

    const entry = harness.service.activityList().find((a) => a.messageId === 12);
    assert.equal(entry?.kind, 'MENSAGEM_IGNORADA');
    assert.equal(harness.service.roomsList()[0]?.validSignals, 0);
  } finally {
    harness.close();
  }
});

test('imagem sem legenda e marcada como formato ainda nao suportado', async () => {
  const harness = buildHarness();
  try {
    await connect(harness);
    harness.service.configureRoom({
      peerId: peerIdOf(SALA_FOREX),
      markets: ['FOREX'],
      monitoring: true,
    });
    await harness.client.deliver(message(SALA_FOREX, 13, '', { media: { className: 'MessageMediaPhoto' } }));

    const entry = harness.service.activityList().find((a) => a.messageId === 13);
    assert.equal(entry?.kind, 'FORMATO_NAO_SUPORTADO');
    assert.match(String(entry?.detail), /imagem ou audio/i);
  } finally {
    harness.close();
  }
});

test('perfil somente registro nunca cria sinal', async () => {
  const harness = buildHarness();
  try {
    await connect(harness);
    harness.service.configureRoom({
      peerId: peerIdOf(SALA_FOREX),
      markets: ['FOREX'],
      monitoring: true,
      profile: 'SOMENTE_MANUAL',
    });
    await harness.client.deliver(
      message(SALA_FOREX, 14, 'COMPRA EURUSD entrada 1.0850 sl 1.0830 tp 1.0880'),
    );

    assert.equal(
      harness.engine.signals.some((s) => s.raw.externalMessageId?.endsWith(':14')),
      false,
    );
    const entry = harness.service.activityList().find((a) => a.messageId === 14);
    assert.match(String(entry?.detail), /somente registro/i);
  } finally {
    harness.close();
  }
});

// --- Separacao entre mercados ----------------------------------------------

test('sinal de cripto em sala cadastrada so para forex fica pendente', async () => {
  const harness = buildHarness();
  try {
    await connect(harness);
    harness.service.configureRoom({
      peerId: peerIdOf(SALA_FOREX),
      markets: ['FOREX'],
      monitoring: true,
    });
    await harness.client.deliver(
      message(SALA_FOREX, 15, 'COMPRA BTCUSDT entrada 72500 sl 71400 tp 74300'),
    );

    assert.equal(
      harness.engine.signals.some((s) => s.raw.externalMessageId?.endsWith(':15')),
      false,
    );
    const entry = harness.service.activityList().find((a) => a.messageId === 15);
    assert.equal(entry?.kind, 'SINAL_PENDENTE');
    assert.equal(entry?.marketId, 'CRYPTO');
  } finally {
    harness.close();
  }
});

test('sala mista roteia cada sinal para o mercado do instrumento', async () => {
  const harness = buildHarness();
  try {
    await connect(harness);
    const peerId = peerIdOf(SALA_MISTA);
    harness.service.configureRoom({ peerId, markets: ['FOREX', 'CRYPTO'], monitoring: true });

    await harness.client.deliver(
      message(SALA_MISTA, 20, 'COMPRA EURUSD entrada 1.0850 sl 1.0830 tp 1.0880'),
    );
    await harness.client.deliver(
      message(SALA_MISTA, 21, 'VENDA BTCUSDT entrada 72500 sl 74300 tp 71400'),
    );

    const forex = harness.engine.signals.find((s) => s.raw.externalMessageId === `tg:${peerId}:20`);
    const crypto = harness.engine.signals.find((s) => s.raw.externalMessageId === `tg:${peerId}:21`);
    assert.equal(forex?.marketId, 'FOREX');
    assert.equal(crypto?.marketId, 'CRYPTO');

    // O mercado sai do instrumento, e cada analise so ve o seu.
    const forexSlice = harness.engine.snapshot().markets.FOREX;
    const cryptoSlice = harness.engine.snapshot().markets.CRYPTO;
    assert.equal(forexSlice.signals.some((s) => s.symbol === 'BTCUSDT'), false);
    assert.equal(cryptoSlice.signals.some((s) => s.symbol === 'EURUSD'), false);
  } finally {
    harness.close();
  }
});

// --- Duplicacao e edicao ---------------------------------------------------

test('a mesma mensagem entregue duas vezes nao cria voto novo', async () => {
  const harness = buildHarness();
  try {
    await connect(harness);
    const peerId = peerIdOf(SALA_FOREX);
    harness.service.configureRoom({ peerId, markets: ['FOREX'], monitoring: true });

    const texto = 'COMPRA EURUSD entrada 1.0850 sl 1.0830 tp 1.0880';
    await harness.client.deliver(message(SALA_FOREX, 30, texto));
    await harness.client.deliver(message(SALA_FOREX, 30, texto));

    const matching = harness.engine.signals.filter(
      (s) => s.raw.externalMessageId === `tg:${peerId}:30`,
    );
    assert.equal(matching.length, 1);
  } finally {
    harness.close();
  }
});

test('edicao atualiza o sinal existente, sem criar voto adicional', async () => {
  const harness = buildHarness();
  try {
    await connect(harness);
    const peerId = peerIdOf(SALA_FOREX);
    harness.service.configureRoom({ peerId, markets: ['FOREX'], monitoring: true });

    await harness.client.deliver(
      message(SALA_FOREX, 31, 'COMPRA EURUSD entrada 1.0850 sl 1.0830 tp 1.0880'),
    );
    await harness.client.deliver(
      message(SALA_FOREX, 31, 'COMPRA EURUSD entrada 1.0850 sl 1.0830 tp 1.0900'),
      true,
    );

    const versions = harness.engine.signals.filter(
      (s) => s.raw.externalMessageId === `tg:${peerId}:31`,
    );
    // Duas versoes registradas, porem apenas uma vigente.
    assert.equal(versions.length, 2);
    const live = versions.filter((s) => s.supersededBySignalId === null);
    assert.equal(live.length, 1);
    assert.equal(live[0]?.takeProfit, 1.09);
    assert.equal(live[0]?.version, 2);
  } finally {
    harness.close();
  }
});

test('salas replicadas compartilham grupo de independencia e valem um voto', async () => {
  const harness = buildHarness();
  try {
    await connect(harness);
    harness.service.configureRoom({
      peerId: peerIdOf(SALA_FOREX),
      markets: ['FOREX'],
      monitoring: true,
      independenceGroupId: 'grupo-forex-pro',
    });
    harness.service.configureRoom({
      peerId: peerIdOf(SALA_REPLICA),
      markets: ['FOREX'],
      monitoring: true,
      independenceGroupId: 'grupo-forex-pro',
    });

    const texto = 'COMPRA EURUSD entrada 1.0850 sl 1.0830 tp 1.0880';
    await harness.client.deliver(message(SALA_FOREX, 40, texto));
    await harness.client.deliver(message(SALA_REPLICA, 40, texto));

    const sources = harness.engine.sources.filter((s) => s.id.startsWith('src_tg_'));
    assert.equal(sources.length, 2);
    assert.equal(new Set(sources.map((s) => s.independenceGroupId)).size, 1);

    const evaluation = harness.engine.evaluations.FOREX.find(
      (e) => e.symbol === 'EURUSD' && e.side === 'BUY',
    );
    assert.ok(evaluation, 'agrupamento avaliado');
    const telegramVotes = [...evaluation.agreeing, ...evaluation.dissenting].filter((v) =>
      v.sourceId.startsWith('src_tg_'),
    );
    assert.equal(telegramVotes.length, 1, 'replica nao adiciona voto');
  } finally {
    harness.close();
  }
});

// --- Continuidade ----------------------------------------------------------

test('pausar uma sala interrompe a leitura sem apagar historico', async () => {
  const harness = buildHarness();
  try {
    await connect(harness);
    const peerId = peerIdOf(SALA_FOREX);
    harness.service.configureRoom({ peerId, markets: ['FOREX'], monitoring: true });
    await harness.client.deliver(
      message(SALA_FOREX, 50, 'COMPRA EURUSD entrada 1.0850 sl 1.0830 tp 1.0880'),
    );
    const antes = harness.service.activityList().length;
    const sinaisAntes = harness.engine.signals.length;

    const paused = harness.service.setMonitoring(peerId, false);
    assert.equal(paused.ok, true);
    assert.equal(harness.service.roomsList()[0]?.state, 'PAUSADA');

    await harness.client.deliver(
      message(SALA_FOREX, 51, 'COMPRA GBPUSD entrada 1.2680 sl 1.2660 tp 1.2710'),
    );

    // Nada novo entrou, e nada antigo saiu.
    assert.equal(harness.service.activityList().length, antes);
    assert.equal(harness.engine.signals.length, sinaisAntes);
    assert.equal(harness.service.roomsList()[0]?.validSignals, 1);
  } finally {
    harness.close();
  }
});

test('reconexao recupera as mensagens perdidas a partir do ultimo id lido', async () => {
  const harness = buildHarness();
  try {
    await connect(harness);
    const peerId = peerIdOf(SALA_FOREX);
    harness.service.configureRoom({ peerId, markets: ['FOREX'], monitoring: true });
    await harness.client.deliver(
      message(SALA_FOREX, 60, 'COMPRA EURUSD entrada 1.0850 sl 1.0830 tp 1.0880'),
    );

    // Publicadas enquanto a conexao estava fora.
    harness.client.backlog.set(peerId, [
      message(SALA_FOREX, 61, 'COMPRA GBPUSD entrada 1.2680 sl 1.2660 tp 1.2710'),
      message(SALA_FOREX, 62, 'VENDA AUDUSD entrada 0.6650 sl 0.6670 tp 0.6620'),
    ]);

    harness.client.authorized = true;
    const result = await harness.service.reconnect();
    assert.equal(result.ok, true);
    // A recuperacao roda em segundo plano apos a reconexao.
    await new Promise((resolve) => setImmediate(resolve));

    const recuperadas = harness.service
      .activityList(200)
      .filter((a) => a.messageId === 61 || a.messageId === 62);
    assert.equal(recuperadas.length, 2);
    assert.ok(
      harness.service.activityList(200).some((a) => a.kind === 'LACUNA_RECEBIMENTO'),
      'a lacuna e registrada de forma visivel',
    );
  } finally {
    harness.close();
  }
});

test('perda de acesso a uma sala e sinalizada, sem tentar contornar', async () => {
  const harness = buildHarness();
  try {
    await connect(harness);
    const peerId = peerIdOf(SALA_FOREX);
    harness.service.configureRoom({ peerId, markets: ['FOREX'], monitoring: true });
    await harness.client.deliver(
      message(SALA_FOREX, 70, 'COMPRA EURUSD entrada 1.0850 sl 1.0830 tp 1.0880'),
    );

    harness.client.denied.add(peerId);
    harness.client.authorized = true;
    await harness.service.reconnect();
    await new Promise((resolve) => setImmediate(resolve));

    const room = harness.service.roomsList()[0];
    assert.equal(room?.state, 'ACESSO_PERDIDO');
    const entry = harness.service.activityList(200).find((a) => a.kind === 'ACESSO_PERDIDO');
    assert.ok(entry);
    assert.match(String(entry?.detail), /nao tenta contornar/i);
  } finally {
    harness.close();
  }
});

test('salas configuradas sobrevivem ao reinicio do processo', async () => {
  const harness = buildHarness();
  try {
    await connect(harness);
    harness.service.configureRoom({
      peerId: peerIdOf(SALA_CRIPTO),
      displayName: 'Cripto Alpha',
      markets: ['CRYPTO'],
      monitoring: true,
      profile: 'CRIPTO_CLASSICO',
    });

    // Novo servico sobre o MESMO banco, como acontece apos reiniciar o backend.
    const revived = new TelegramService({
      apiId: '123456',
      apiHash: 'hash-local-de-teste',
      store: harness.store,
      clock: new FakeClock(NOW),
      bridge: createTelegramEngineBridge(harness.engine),
      clientFactory: () => harness.client as never,
    });

    const rooms = revived.roomsList();
    assert.equal(rooms.length, 1);
    assert.equal(rooms[0]?.displayName, 'Cripto Alpha');
    assert.deepEqual(rooms[0]?.markets, ['CRYPTO']);
    assert.equal(rooms[0]?.profile, 'CRIPTO_CLASSICO');
    assert.equal(rooms[0]?.monitoring, true);
  } finally {
    harness.close();
  }
});

test('encerrar a sessao limpa o que era da integracao e avisa o escopo', async () => {
  const harness = buildHarness();
  try {
    await connect(harness);
    const result = await harness.service.logout();
    assert.equal(result.ok, true);
    assert.equal(harness.client.loggedOut, true);
    assert.equal(harness.service.state, 'DESCONECTADO');
    assert.equal(harness.service.snapshot().account, null);

    const entry = harness.service.activityList().find((a) => a.kind === 'CONEXAO_PERDIDA');
    assert.match(String(entry?.detail), /outras sessoes/i);
  } finally {
    harness.close();
  }
});
