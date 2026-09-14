import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeClock } from '../src/core/time.ts';
import {
  ReferenceQuotesService,
  isForexMarketOpen,
  minutesSinceWeeklyOpen,
} from '../src/quotes/referenceQuotes.ts';

/** Segunda-feira, 14:00 UTC: mercado de forex aberto. */
const NOW = '2026-09-14T14:00:00.000Z';
/** Sabado: mercado de forex fechado. */
const SABADO = '2026-09-12T14:00:00.000Z';

const KEY = 'chave-de-teste';

/** Resposta crua no formato exato do provedor: TUDO string, chave sem hifen. */
function rawQuote(overrides: Record<string, string> = {}) {
  return {
    code: 'EUR',
    codein: 'USD',
    name: 'Euro/Dólar Americano',
    high: '1.16173005',
    low: '1.15745997',
    varBid: '-0.00144',
    pctChange: '-0.124022',
    bid: '1.1596',
    ask: '1.1602',
    // 2026-09-14T13:55:00Z
    timestamp: String(Math.floor(Date.parse('2026-09-14T13:55:00.000Z') / 1000)),
    create_date: '2026-09-14 10:55:00',
    ...overrides,
  };
}

interface Call {
  url: string;
  headers: Record<string, string>;
}

function fakeFetch(
  responder: (call: Call, index: number) => { status: number; body: unknown; headers?: Record<string, string> },
  calls: Call[] = [],
) {
  const impl: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>),
    );
    calls.push({ url, headers });
    const { status, body, headers: responseHeaders } = responder({ url, headers }, calls.length - 1);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...(responseHeaders ?? {}) },
    });
  };
  return { impl, calls };
}

function service(options: {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  now?: string;
  refreshSeconds?: number;
  staleAfterSeconds?: number;
}) {
  return new ReferenceQuotesService({
    apiKey: options.apiKey,
    fetchImpl: options.fetchImpl,
    clock: new FakeClock(options.now ?? NOW),
    refreshSeconds: options.refreshSeconds ?? 60,
    staleAfterSeconds: options.staleAfterSeconds,
  });
}

// --- Horario de mercado ------------------------------------------------------

test('horario de forex: fechado no fim de semana, aberto durante a semana', () => {
  assert.equal(isForexMarketOpen('2026-09-14T14:00:00.000Z'), true, 'segunda');
  assert.equal(isForexMarketOpen('2026-09-12T14:00:00.000Z'), false, 'sabado');
  assert.equal(isForexMarketOpen('2026-09-13T12:00:00.000Z'), false, 'domingo de manha');
  assert.equal(isForexMarketOpen('2026-09-13T22:00:00.000Z'), true, 'domingo apos a abertura');
  assert.equal(isForexMarketOpen('2026-09-11T22:00:00.000Z'), false, 'sexta apos o fechamento');
});

// --- Sem chave ---------------------------------------------------------------

test('sem AWESOMEAPI_KEY nao chama o provedor e informa como configurar', async () => {
  const { impl, calls } = fakeFetch(() => ({ status: 200, body: {} }));
  const svc = service({ apiKey: undefined, fetchImpl: impl });

  await svc.refresh();
  const snapshot = svc.snapshot();

  assert.equal(calls.length, 0, 'nenhuma chamada externa sem credencial');
  assert.equal(snapshot.status.configured, false);
  assert.equal(snapshot.status.state, 'NAO_CONFIGURADA');
  assert.match(snapshot.status.message, /AWESOMEAPI_KEY/);
  assert.equal(snapshot.quotes.length, 0);
});

test('start() nao agenda nada quando a integracao nao esta configurada', async () => {
  const { impl, calls } = fakeFetch(() => ({ status: 200, body: {} }));
  const svc = service({ apiKey: undefined, fetchImpl: impl });
  svc.start();
  svc.stop();
  assert.equal(calls.length, 0);
});

// --- Consulta autenticada ----------------------------------------------------

test('consulta autenticada envia x-api-key e nao coloca a chave na URL', async () => {
  const { impl, calls } = fakeFetch(() => ({ status: 200, body: { EURUSD: rawQuote() } }));
  const svc = service({ apiKey: KEY, fetchImpl: impl });

  await svc.refresh();

  assert.equal(calls.length, 1, 'todos os pares em UMA chamada');
  assert.equal(calls[0]?.headers['x-api-key'], KEY);
  assert.equal(calls[0]?.url.includes(KEY), false, 'a chave nunca vai na URL');
  assert.match(calls[0]?.url ?? '', /\/json\/last\//);
});

test('consulta os pares em conjunto, no formato do provedor', async () => {
  const { impl, calls } = fakeFetch(() => ({ status: 200, body: { EURUSD: rawQuote() } }));
  const svc = service({ apiKey: KEY, fetchImpl: impl });
  await svc.refresh();

  const url = calls[0]?.url ?? '';
  for (const pair of ['EUR-USD', 'GBP-USD', 'USD-JPY', 'AUD-USD', 'USD-CHF']) {
    assert.ok(url.includes(pair), `par ${pair} deveria estar na consulta`);
  }
  assert.equal(url.includes('EURUSD-OTC'), false, 'instrumento sem cobertura nao e consultado');
});

test('EURUSD-OTC aparece como sem cobertura, sem substituto', () => {
  const svc = service({ apiKey: KEY });
  assert.deepEqual(svc.snapshot().status.unsupportedSymbols, ['EURUSD-OTC']);
});

// --- Normalizacao ------------------------------------------------------------

test('normaliza texto em numero e separa horario da cotacao do horario de recebimento', async () => {
  const { impl } = fakeFetch(() => ({ status: 200, body: { EURUSD: rawQuote() } }));
  const svc = service({ apiKey: KEY, fetchImpl: impl });
  await svc.refresh();

  const quote = svc.get('EURUSD');
  assert.ok(quote);
  assert.equal(typeof quote.bid, 'number');
  assert.equal(quote.bid, 1.1596);
  assert.equal(quote.ask, 1.1602);
  assert.equal(quote.high, 1.16173005);
  assert.equal(quote.low, 1.15745997);
  assert.equal(quote.varBid, -0.00144);
  assert.equal(quote.pctChange, -0.124022);
  assert.equal(quote.pair, 'EUR-USD');
  assert.equal(quote.symbol, 'EURUSD');
  assert.equal(quote.source, 'AwesomeAPI');
  assert.match(quote.sourceLabel, /AwesomeAPI/);

  // Horario da negociacao veio do provedor; o de recebimento e o relogio local.
  assert.equal(quote.quotedAt, '2026-09-14T13:55:00.000Z');
  assert.equal(quote.fetchedAt, NOW);
  assert.notEqual(quote.quotedAt, quote.fetchedAt);
  assert.equal(quote.quotedAtProviderLocal, '2026-09-14 10:55:00');
  assert.equal(quote.ageSeconds, 300);
  assert.equal(quote.stale, false);
});

test('campo ausente vira null em vez de NaN', async () => {
  const { impl } = fakeFetch(() => ({
    status: 200,
    body: { EURUSD: rawQuote({ high: 'indisponivel' }) },
  }));
  const svc = service({ apiKey: KEY, fetchImpl: impl });
  await svc.refresh();
  assert.equal(svc.get('EURUSD')?.high, null);
});

// --- Cache compartilhado e concorrencia --------------------------------------

test('leituras usam o cache: nenhuma consulta externa por leitura', async () => {
  const { impl, calls } = fakeFetch(() => ({ status: 200, body: { EURUSD: rawQuote() } }));
  const svc = service({ apiKey: KEY, fetchImpl: impl });
  await svc.refresh();

  for (let i = 0; i < 20; i++) {
    svc.get('EURUSD');
    svc.snapshot();
  }
  assert.equal(calls.length, 1, 'vinte leituras, uma unica chamada externa');
});

test('consultas concorrentes compartilham a mesma requisicao', async () => {
  // Portao manual: segura a resposta ate os tres pedidos estarem no ar.
  let open: () => void = () => {};
  const gate = { promise: new Promise<void>((resolve) => { open = resolve; }), resolve: () => open() };
  const calls: string[] = [];
  const impl: typeof fetch = async (input) => {
    calls.push(String(input));
    await gate.promise;
    return new Response(JSON.stringify({ EURUSD: rawQuote() }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const svc = service({ apiKey: KEY, fetchImpl: impl });

  const all = Promise.all([svc.refresh(), svc.refresh(), svc.refresh()]);
  gate.resolve();
  await all;

  assert.equal(calls.length, 1, 'tres pedidos simultaneos, uma chamada externa');
});

// --- Falhas ------------------------------------------------------------------

test('credencial recusada vira erro de autenticacao', async () => {
  const { impl } = fakeFetch(() => ({ status: 401, body: { message: 'nao autorizado' } }));
  const svc = service({ apiKey: KEY, fetchImpl: impl });
  await svc.refresh();

  const status = svc.snapshot().status;
  assert.equal(status.state, 'ERRO');
  assert.equal(status.error?.code, 'AUTENTICACAO');
  assert.match(status.error?.message ?? '', /AWESOMEAPI_KEY/);
});

test('limite excedido respeita o tempo de espera informado pelo provedor', async () => {
  const { impl } = fakeFetch(() => ({
    status: 429,
    body: { message: 'too many requests' },
    headers: { 'retry-after': '120' },
  }));
  const svc = service({ apiKey: KEY, fetchImpl: impl, refreshSeconds: 60 });
  await svc.refresh();

  const status = svc.snapshot().status;
  assert.equal(status.error?.code, 'LIMITE_EXCEDIDO');
  assert.equal(status.error?.retryAfterSeconds, 120);
  const waitSeconds = (Date.parse(status.nextAttemptAt as string) - Date.parse(NOW)) / 1000;
  assert.ok(waitSeconds >= 120, `esperava ao menos 120 s, obteve ${waitSeconds}`);
});

test('falhas seguidas aumentam o intervalo entre tentativas', async () => {
  const { impl } = fakeFetch(() => ({ status: 500, body: { message: 'indisponivel' } }));
  const svc = service({ apiKey: KEY, fetchImpl: impl, refreshSeconds: 60 });

  await svc.refresh();
  const primeira = Date.parse(svc.snapshot().status.nextAttemptAt as string);
  await svc.refresh();
  const segunda = Date.parse(svc.snapshot().status.nextAttemptAt as string);

  assert.ok(segunda > primeira, 'o recuo cresce a cada falha consecutiva');
  assert.equal(svc.snapshot().status.consecutiveFailures, 2);
});

test('timeout e reportado como timeout', async () => {
  const impl: typeof fetch = async () => {
    const error = new Error('abortado');
    error.name = 'AbortError';
    throw error;
  };
  const svc = service({ apiKey: KEY, fetchImpl: impl });
  await svc.refresh();
  assert.equal(svc.snapshot().status.error?.code, 'TIMEOUT');
});

test('par inexistente e isolado e a consulta repete sem ele', async () => {
  const calls: Call[] = [];
  const { impl } = fakeFetch((call, index) => {
    if (index === 0) {
      return {
        status: 404,
        body: { status: 404, code: 'CoinNotExists', message: 'moeda nao encontrada USD-CHF' },
      };
    }
    return { status: 200, body: { EURUSD: rawQuote() } };
  }, calls);

  const svc = service({ apiKey: KEY, fetchImpl: impl });
  await svc.refresh();

  assert.equal(calls.length, 2, 'uma tentativa completa e uma repeticao sem o par recusado');
  assert.equal(calls[1]?.url.includes('USD-CHF'), false);
  const status = svc.snapshot().status;
  assert.ok(status.unsupportedSymbols.includes('USDCHF'), 'par recusado vira sem cobertura');
  assert.equal(status.state, 'OK');
  assert.equal(svc.get('EURUSD')?.bid, 1.1596);
});

test('a repeticao e unica: nao vira laco de tentativas', async () => {
  const calls: Call[] = [];
  const { impl } = fakeFetch(
    () => ({
      status: 404,
      body: { status: 404, code: 'CoinNotExists', message: 'moeda nao encontrada USD-CHF' },
    }),
    calls,
  );
  const svc = service({ apiKey: KEY, fetchImpl: impl });
  await svc.refresh();
  assert.equal(calls.length, 2, 'no maximo duas chamadas por ciclo');
});

// --- Dados desatualizados ----------------------------------------------------

test('falha depois de sucesso mantem a ultima cotacao, marcada como desatualizada', async () => {
  let fail = false;
  const impl: typeof fetch = async () => {
    if (fail) return new Response(JSON.stringify({ message: 'fora do ar' }), { status: 503 });
    return new Response(JSON.stringify({ EURUSD: rawQuote() }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const svc = service({ apiKey: KEY, fetchImpl: impl });
  await svc.refresh();
  fail = true;
  await svc.refresh();

  const snapshot = svc.snapshot();
  assert.equal(snapshot.quotes.length, 1, 'a cotacao conhecida continua na tela');
  assert.equal(snapshot.quotes[0]?.bid, 1.1596, 'o valor nao foi trocado por nada inventado');
  assert.equal(snapshot.quotes[0]?.stale, true);
  assert.equal(snapshot.status.state, 'DESATUALIZADA');
  assert.match(snapshot.quotes[0]?.staleReason ?? '', /falhou/);
});

test('cotacao velha com mercado aberto e marcada como desatualizada', async () => {
  const antiga = String(Math.floor(Date.parse('2026-09-14T10:00:00.000Z') / 1000));
  const { impl } = fakeFetch(() => ({
    status: 200,
    body: { EURUSD: rawQuote({ timestamp: antiga }) },
  }));
  const svc = service({ apiKey: KEY, fetchImpl: impl, staleAfterSeconds: 300 });
  await svc.refresh();

  const quote = svc.get('EURUSD');
  assert.equal(quote?.stale, true);
  assert.match(quote?.staleReason ?? '', /mercado aberto/);
  assert.equal(svc.snapshot().status.state, 'DESATUALIZADA');
});

test('com o mercado fechado, o preco de fechamento nao e tratado como falha', async () => {
  const sexta = String(Math.floor(Date.parse('2026-09-11T20:59:00.000Z') / 1000));
  const { impl } = fakeFetch(() => ({
    status: 200,
    body: { EURUSD: rawQuote({ timestamp: sexta }) },
  }));
  const svc = service({ apiKey: KEY, fetchImpl: impl, now: SABADO, staleAfterSeconds: 300 });
  await svc.refresh();

  const snapshot = svc.snapshot();
  assert.equal(snapshot.quotes[0]?.stale, false, 'fechamento de sexta e o preco correto no sabado');
  assert.match(snapshot.quotes[0]?.staleReason ?? '', /fechado/);
  assert.equal(snapshot.status.state, 'MERCADO_FECHADO');
  assert.equal(snapshot.status.marketOpen, false);
});

test('logo apos a abertura de domingo, preco de sexta nao e tratado como falha', async () => {
  // Domingo 21:34 UTC: mercado aberto ha 34 min.
  const domingoAberto = '2026-09-13T21:34:00.000Z';
  const sexta = String(Math.floor(Date.parse('2026-09-11T21:00:00.000Z') / 1000));
  const { impl } = fakeFetch(() => ({
    status: 200,
    body: { EURUSD: rawQuote({ timestamp: sexta }) },
  }));
  const svc = service({ apiKey: KEY, fetchImpl: impl, now: domingoAberto });
  await svc.refresh();

  assert.equal(minutesSinceWeeklyOpen(domingoAberto), 34);
  const quote = svc.get('EURUSD');
  assert.equal(quote?.stale, false, 'na retomada semanal o par ainda nao voltou, e isso e esperado');
  assert.match(quote?.staleReason ?? '', /reaberto/);
});

test('passada a carencia de abertura, cotacao parada volta a ser desatualizada', async () => {
  // Segunda-feira: a semana ja esta em curso, sem carencia.
  const sexta = String(Math.floor(Date.parse('2026-09-11T21:00:00.000Z') / 1000));
  const { impl } = fakeFetch(() => ({
    status: 200,
    body: { EURUSD: rawQuote({ timestamp: sexta }) },
  }));
  const svc = service({ apiKey: KEY, fetchImpl: impl, now: NOW });
  await svc.refresh();

  assert.equal(minutesSinceWeeklyOpen(NOW), null);
  assert.equal(svc.get('EURUSD')?.stale, true);
});

test('limiar padrao tolera a cadencia propria de cada par', () => {
  // 15 min com intervalo de 60 s: um major pode ficar minutos sem negocio novo.
  assert.equal(service({ apiKey: KEY, refreshSeconds: 60 }).staleAfterSeconds, 900);
  // Intervalo maior manda: 10 vezes o ciclo.
  assert.equal(service({ apiKey: KEY, refreshSeconds: 300 }).staleAfterSeconds, 3000);
});

// --- Consumo -----------------------------------------------------------------

test('projecao de consumo mensal acompanha o intervalo configurado', () => {
  assert.equal(service({ apiKey: KEY, refreshSeconds: 60 }).snapshot().status.estimatedMonthlyRequests, 43_200);
  assert.equal(service({ apiKey: KEY, refreshSeconds: 300 }).snapshot().status.estimatedMonthlyRequests, 8_640);
});

test('o instantaneo nunca carrega a credencial', async () => {
  const { impl } = fakeFetch(() => ({ status: 200, body: { EURUSD: rawQuote() } }));
  const svc = service({ apiKey: KEY, fetchImpl: impl });
  await svc.refresh();
  const serialized = JSON.stringify(svc.snapshot());
  assert.equal(serialized.includes(KEY), false, 'a chave nao pode aparecer no que vai para a interface');
});
