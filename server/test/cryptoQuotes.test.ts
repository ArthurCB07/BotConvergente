import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { FakeClock } from '../src/core/time.ts';
import { BinanceClient } from '../src/quotes/binanceClient.ts';
import { BinanceStream, type WebSocketLike } from '../src/quotes/binanceStream.ts';
import { CryptoQuotesService } from '../src/quotes/cryptoQuotes.ts';

const NOW = '2026-09-14T14:00:00.000Z';

/** Resposta de exchangeInfo no formato real do provedor. */
function exchangeInfoBody(symbols: string[], status = 'TRADING') {
  return {
    timezone: 'UTC',
    serverTime: Date.parse(NOW),
    symbols: symbols.map((symbol) => ({
      symbol,
      status,
      baseAsset: symbol.replace('USDT', ''),
      quoteAsset: 'USDT',
      baseAssetPrecision: 8,
      quoteAssetPrecision: 8,
      isSpotTradingAllowed: status === 'TRADING',
      filters: [
        { filterType: 'PRICE_FILTER', tickSize: '0.01000000' },
        { filterType: 'LOT_SIZE', stepSize: '0.00001000' },
        { filterType: 'NOTIONAL', minNotional: '5.00000000' },
      ],
    })),
  };
}

function bookBody(symbols: string[]) {
  return symbols.map((symbol) => ({
    symbol,
    bidPrice: '76802.00000000',
    bidQty: '1.49811000',
    askPrice: '76802.01000000',
    askQty: '6.79687000',
  }));
}

function stats24hBody(symbols: string[]) {
  return symbols.map((symbol) => ({
    symbol,
    priceChange: '-402.21000000',
    priceChangePercent: '-0.521',
    lastPrice: '76802.01000000',
    openPrice: '77204.22000000',
    highPrice: '77450.00000000',
    lowPrice: '76500.00000000',
    volume: '1234.5',
    quoteVolume: '94000000',
    openTime: Date.parse('2026-09-13T14:00:00.000Z'),
    closeTime: Date.parse('2026-09-14T13:59:59.000Z'),
  }));
}

/** Roteador de resposta por caminho, no formato real da Binance. */
function fakeFetch(overrides: Record<string, { status: number; body: unknown; headers?: Record<string, string> }> = {}) {
  const calls: string[] = [];
  const impl: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    for (const [fragment, response] of Object.entries(overrides)) {
      if (url.includes(fragment)) {
        return new Response(JSON.stringify(response.body), {
          status: response.status,
          headers: { 'content-type': 'application/json', ...(response.headers ?? {}) },
        });
      }
    }
    const symbols = decodeURIComponent(url.split('symbols=')[1] ?? '[]');
    const list: string[] = JSON.parse(symbols || '[]');
    let body: unknown = {};
    if (url.includes('/exchangeInfo')) body = exchangeInfoBody(list);
    else if (url.includes('/ticker/bookTicker')) body = bookBody(list);
    else if (url.includes('/ticker/24hr')) body = stats24hBody(list);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { impl, calls };
}

/** Duble de socket, controlado pelo teste. */
class FakeSocket implements WebSocketLike {
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  closed = false;
  static created: FakeSocket[] = [];
  static urls: string[] = [];

  constructor(public url: string) {
    FakeSocket.created.push(this);
    FakeSocket.urls.push(url);
  }
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.onopen?.({});
  }
  emit(stream: string, data: unknown): void {
    this.onmessage?.({ data: JSON.stringify({ stream, data }) });
  }
  serverClose(code = 1006): void {
    this.onclose?.({ code });
  }
  static reset(): void {
    FakeSocket.created = [];
    FakeSocket.urls = [];
  }
}

function service(options: Partial<Parameters<typeof buildService>[0]> = {}) {
  return buildService(options);
}

function buildService(options: {
  fetchImpl?: typeof fetch;
  staleAfterSeconds?: number;
  now?: string;
  watchdogSeconds?: number;
} = {}) {
  FakeSocket.reset();
  return new CryptoQuotesService({
    fetchImpl: options.fetchImpl ?? fakeFetch().impl,
    clock: new FakeClock(options.now ?? NOW),
    staleAfterSeconds: options.staleAfterSeconds,
    watchdogSeconds: options.watchdogSeconds,
    statsRefreshSeconds: 3600,
    socketFactory: (url) => new FakeSocket(url),
  });
}

// --- Cliente REST ------------------------------------------------------------

test('exchangeInfo traduz os filtros do simbolo sem presumir valores', async () => {
  const { impl } = fakeFetch();
  const client = new BinanceClient({ fetchImpl: impl });
  const result = await client.exchangeInfo(['BTCUSDT']);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const info = result.data[0];
  assert.equal(info?.symbol, 'BTCUSDT');
  assert.equal(info?.status, 'TRADING');
  assert.equal(info?.baseAsset, 'BTC');
  assert.equal(info?.quoteAsset, 'USDT');
  assert.equal(info?.tickSize, 0.01);
  assert.equal(info?.stepSize, 0.00001);
  assert.equal(info?.minNotional, 5);
});

test('simbolo invalido e reportado como tal', async () => {
  const { impl } = fakeFetch({
    '/exchangeInfo': { status: 400, body: { code: -1121, msg: 'Invalid symbol.' } },
  });
  const client = new BinanceClient({ fetchImpl: impl });
  const result = await client.exchangeInfo(['NAOEXISTE']);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'SIMBOLO_INVALIDO');
});

test('limite de requisicoes respeita o tempo de espera informado', async () => {
  const { impl } = fakeFetch({
    '/ticker/24hr': { status: 429, body: { msg: 'too many' }, headers: { 'retry-after': '30' } },
  });
  const client = new BinanceClient({ fetchImpl: impl });
  const result = await client.ticker24h(['BTCUSDT']);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'LIMITE_EXCEDIDO');
  assert.equal(result.error.retryAfterSeconds, 30);
});

test('timeout do REST e classificado como timeout', async () => {
  const impl: typeof fetch = async () => {
    const error = new Error('abort');
    error.name = 'AbortError';
    throw error;
  };
  const client = new BinanceClient({ fetchImpl: impl });
  const result = await client.bookTicker(['BTCUSDT']);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'TIMEOUT');
});

// --- Stream ------------------------------------------------------------------

test('o stream abre UMA conexao combinada com todos os pares', async () => {
  FakeSocket.reset();
  const stream = new BinanceStream({
    onMessage: () => {},
    socketFactory: (url) => new FakeSocket(url),
  });
  stream.start(['btcusdt@bookTicker', 'btcusdt@trade', 'ethusdt@bookTicker']);
  assert.equal(FakeSocket.created.length, 1, 'uma unica conexao para todos os streams');
  const url = FakeSocket.urls[0] ?? '';
  assert.ok(url.startsWith('wss://data-stream.binance.vision:443/stream?streams='));
  assert.ok(url.includes('btcusdt@bookTicker'));
  assert.ok(url.includes('ethusdt@bookTicker'));
  stream.stop();
});

test('mensagem do stream combinado e entregue ja separada por stream', async () => {
  FakeSocket.reset();
  const recebidas: Array<{ stream: string; data: Record<string, unknown> }> = [];
  const stream = new BinanceStream({
    onMessage: (m) => recebidas.push({ stream: m.stream, data: m.data }),
    socketFactory: (url) => new FakeSocket(url),
  });
  stream.start(['btcusdt@trade']);
  const socket = FakeSocket.created[0]!;
  socket.open();
  socket.emit('btcusdt@trade', { e: 'trade', p: '76754.01', T: 1789339283558 });
  assert.equal(recebidas.length, 1);
  assert.equal(recebidas[0]?.stream, 'btcusdt@trade');
  assert.equal(recebidas[0]?.data.p, '76754.01');
  assert.equal(stream.state, 'ABERTO');
  stream.stop();
});

test('conexao silenciosa e refeita pelo cao de guarda', async () => {
  FakeSocket.reset();
  const stream = new BinanceStream({
    watchdogSeconds: 0.05,
    onMessage: () => {},
    socketFactory: (url) => new FakeSocket(url),
  });
  stream.start(['btcusdt@trade']);
  FakeSocket.created[0]!.open();
  assert.equal(stream.state, 'ABERTO');

  await delay(120);
  assert.equal(stream.state, 'RECONECTANDO', 'sem dado na janela, a conexao e considerada morta');
  assert.ok(FakeSocket.created.length >= 2, 'abriu uma conexao nova');
  assert.ok(stream.reconnects >= 1);
  stream.stop();
});

test('fechamento pelo servidor agenda reconexao com recuo', async () => {
  FakeSocket.reset();
  const stream = new BinanceStream({
    onMessage: () => {},
    socketFactory: (url) => new FakeSocket(url),
  });
  stream.start(['btcusdt@trade']);
  FakeSocket.created[0]!.open();
  FakeSocket.created[0]!.serverClose(1006);
  assert.equal(stream.state, 'RECONECTANDO');
  assert.ok((stream.lastCloseReason ?? '').includes('1006'));
  stream.stop();
  assert.equal(stream.state, 'PARADO');
});

// --- Servico -----------------------------------------------------------------

test('pares padrao saem do catalogo e sao validados em exchangeInfo', async () => {
  const { impl, calls } = fakeFetch();
  const svc = buildService({ fetchImpl: impl });
  await svc.start();

  assert.deepEqual(svc.selectedSymbols, ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
  assert.ok(calls.some((c) => c.includes('/api/v3/exchangeInfo')), 'valida antes de usar');
  assert.ok(calls.some((c) => c.includes('/api/v3/ticker/bookTicker')));
  assert.ok(calls.some((c) => c.includes('/api/v3/ticker/24hr')));
  svc.stop();
});

test('par fora de negociacao e descartado', async () => {
  const { impl } = fakeFetch({
    '/exchangeInfo': { status: 200, body: exchangeInfoBody(['BTCUSDT', 'ETHUSDT', 'SOLUSDT'], 'HALT') },
  });
  const svc = buildService({ fetchImpl: impl });
  await svc.start();
  assert.deepEqual(svc.selectedSymbols, [], 'nenhum par com status diferente de TRADING');
  svc.stop();
});

test('perpetuos aparecem como incompativeis com esta integracao', async () => {
  const svc = buildService();
  await svc.start();
  const incompativeis = svc.snapshot().status.incompatibleSymbols;
  const simbolos = incompativeis.map((i) => i.symbol);
  assert.ok(simbolos.includes('BTCUSDT-PERP'));
  assert.ok(simbolos.includes('ETHUSDT-PERP'));
  const perp = incompativeis.find((i) => i.symbol === 'BTCUSDT-PERP');
  assert.match(perp?.reason ?? '', /perpetuo/);
  assert.match(perp?.reason ?? '', /a vista/);
  svc.stop();
});

test('normaliza o livro sem inventar horario e o negocio com o horario do provedor', async () => {
  const svc = buildService();
  await svc.start();
  const socket = FakeSocket.created[0]!;
  socket.open();
  socket.emit('btcusdt@bookTicker', {
    u: 100069132434,
    s: 'BTCUSDT',
    b: '76754.00000000',
    B: '3.84782000',
    a: '76754.01000000',
    A: '2.76103000',
  });
  socket.emit('btcusdt@trade', {
    e: 'trade',
    E: 1789339283558,
    s: 'BTCUSDT',
    p: '76750.55000000',
    q: '0.002',
    T: 1789339283000,
  });

  const quote = svc.get('BTCUSDT');
  assert.ok(quote);
  // Tres precos distintos, nunca colapsados em um so.
  assert.equal(quote.bid, 76754);
  assert.equal(quote.ask, 76754.01);
  assert.equal(quote.lastPrice, 76750.55);
  assert.notEqual(quote.lastPrice, quote.bid);

  // O livro NAO tem horario de evento: o campo fica nulo, e nada e inventado.
  assert.equal(quote.bookEventAt, null);
  assert.ok(quote.bookReceivedAt);
  assert.equal(quote.bookUpdateId, 100069132434);

  // O negocio tem horario do provedor, separado do horario de recebimento.
  assert.equal(quote.lastTradeAt, new Date(1789339283000).toISOString());
  assert.equal(quote.lastTradeReceivedAt, NOW);
  svc.stop();
});

test('identifica exchange, mercado, ativo-base e moeda de cotacao', async () => {
  const svc = buildService();
  await svc.start();
  const quote = svc.get('BTCUSDT');
  assert.equal(quote?.exchange, 'Binance');
  assert.equal(quote?.marketType, 'Spot');
  assert.equal(quote?.baseAsset, 'BTC');
  assert.equal(quote?.quoteAsset, 'USDT');
  assert.equal(quote?.pairLabel, 'BTC/USDT');
  assert.equal(svc.snapshot().status.sourceLabel, 'Binance · Spot');
  svc.stop();
});

test('USDT nunca e apresentado como USD', async () => {
  const svc = buildService();
  await svc.start();
  const texto = JSON.stringify(svc.snapshot());
  assert.ok(texto.includes('USDT'));
  assert.equal(/"quoteAsset":"USD"/.test(texto), false);
  assert.equal(/"pairLabel":"[A-Z]+\/USD"/.test(texto), false);
  svc.stop();
});

test('estatisticas de 24 h preservam o horario do provedor', async () => {
  const svc = buildService();
  await svc.start();
  const quote = svc.get('BTCUSDT');
  assert.equal(quote?.high24h, 77450);
  assert.equal(quote?.low24h, 76500);
  assert.equal(quote?.priceChangePercent, -0.521);
  assert.equal(quote?.stats24hAt, new Date(Date.parse('2026-09-14T13:59:59.000Z')).toISOString());
  assert.equal(quote?.stats24hReceivedAt, NOW);
  svc.stop();
});

test('regras do simbolo vem de exchangeInfo, nao do codigo', async () => {
  const svc = buildService();
  await svc.start();
  const quote = svc.get('BTCUSDT');
  assert.equal(quote?.tickSize, 0.01);
  assert.equal(quote?.stepSize, 0.00001);
  assert.equal(quote?.minNotional, 5);
  assert.equal(quote?.status, 'TRADING');
  svc.stop();
});

test('sem dado novo dentro da janela, a cotacao fica desatualizada e o preco permanece', async () => {
  const svc = buildService({ staleAfterSeconds: 30 });
  await svc.start();
  const socket = FakeSocket.created[0]!;
  socket.open();
  socket.emit('btcusdt@trade', { p: '76750.55000000', T: Date.parse(NOW) });

  const quoteFresca = svc.get('BTCUSDT');
  assert.equal(quoteFresca?.stale, false);

  // O relogio anda 10 minutos sem nenhuma mensagem nova.
  const svcQualquer = svc as unknown as { clock: FakeClock };
  svcQualquer.clock.advanceMinutes(10);

  const quoteVelha = svc.get('BTCUSDT');
  assert.equal(quoteVelha?.stale, true);
  assert.equal(quoteVelha?.lastPrice, 76750.55, 'o ultimo preco conhecido continua, sem substituto');
  assert.match(quoteVelha?.staleReason ?? '', /24 horas/);
  assert.equal(svc.snapshot().status.state, 'DESATUALIZADA');
  svc.stop();
});

test('provedor indisponivel na carga inicial nao inventa preco', async () => {
  const { impl } = fakeFetch({
    '/api/v3/': { status: 503, body: { msg: 'service unavailable' } },
  });
  const svc = buildService({ fetchImpl: impl });
  await svc.start();
  const snapshot = svc.snapshot();
  assert.equal(snapshot.quotes.length, 0);
  assert.equal(snapshot.status.state, 'INDISPONIVEL');
  svc.stop();
});

test('troca de pares aceita apenas o que o provedor confirma', async () => {
  const { impl } = fakeFetch();
  const svc = buildService({ fetchImpl: impl });
  await svc.start();

  const ok = await svc.setSymbols(['btcusdt', 'adausdt']);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.accepted, ['BTCUSDT', 'ADAUSDT']);
  assert.deepEqual(svc.selectedSymbols, ['BTCUSDT', 'ADAUSDT']);
  svc.stop();
});

test('troca de pares recusa simbolo que o provedor nao reconhece', async () => {
  const { impl } = fakeFetch({
    '/exchangeInfo': { status: 400, body: { code: -1121, msg: 'Invalid symbol.' } },
  });
  const svc = buildService({ fetchImpl: impl });
  const result = await svc.setSymbols(['NAOEXISTE']);
  assert.equal(result.ok, false);
  assert.deepEqual(result.accepted, []);
  svc.stop();
});

test('preco medio usa o livro e cai para o ultimo negocio quando nao ha livro', async () => {
  const { impl } = fakeFetch({
    '/ticker/bookTicker': { status: 503, body: { msg: 'indisponivel' } },
  });
  const svc = buildService({ fetchImpl: impl });
  await svc.start();
  // Sem livro, o REST de 24 h ainda preenche o ultimo preco.
  assert.equal(svc.midPrice('BTCUSDT'), 76802.01);

  const comLivro = buildService();
  await comLivro.start();
  assert.equal(comLivro.midPrice('BTCUSDT'), (76802 + 76802.01) / 2);
  svc.stop();
  comLivro.stop();
});

test('candles so sao servidos para par acompanhado', async () => {
  const svc = buildService();
  await svc.start();
  const recusado = await svc.klines('DOGEUSDT');
  assert.equal(recusado.ok, false);
  svc.stop();
});
