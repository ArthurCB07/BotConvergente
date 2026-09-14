import { resolve } from 'node:path';
import { ReferenceQuotesService } from './quotes/referenceQuotes.ts';
import { CryptoQuotesService } from './quotes/cryptoQuotes.ts';
import { Engine } from './engine/engine.ts';
import { createApp } from './http.ts';
import { Store } from './infra/store.ts';
import { seed } from './seed.ts';
import { SignalGenerator } from './sources/generator.ts';
import { createTelegramEngineBridge } from './telegram/engineBridge.ts';
import { TelegramService } from './telegram/telegramService.ts';

/*
 * Le o .env da raiz do projeto, quando existir. Segredos ficam so no ambiente do
 * backend: nada de credencial em codigo, em log ou no frontend.
 */
try {
  process.loadEnvFile(resolve(import.meta.dirname, '..', '..', '.env'));
} catch {
  // Sem arquivo .env: vale o que estiver nas variaveis de ambiente do processo.
}

const PORT = Number(process.env.PORT ?? 8787);
const TICK_SECONDS = 1;
/*
 * Caminho ancorado no proprio modulo, nao no diretorio de onde o comando saiu:
 * `npm run dev` na raiz e `npm start` dentro de server/ precisam abrir o mesmo banco.
 */
const DB_PATH = process.env.DB_PATH ?? resolve(import.meta.dirname, '..', 'data', 'app.db');

const store = new Store(DB_PATH);
const engine = new Engine({
  initialBalance: 10_000,
  cryptoInitialBalance: 5_000,
  seed: 20260913,
  store,
});

const recovered = engine.hydrate();
if (!recovered) {
  seed(engine);
  engine.persistRuntime(true);
}

// Descarta o excedente de historico na entrada, alem do descarte na saida.
store.prune();

await engine.connectAll();

// --- Cotacao de referencia (AwesomeAPI) ------------------------------------
const referenceQuotes = new ReferenceQuotesService({
  apiKey: process.env.AWESOMEAPI_KEY,
  refreshSeconds: Number(process.env.QUOTES_REFRESH_SECONDS ?? 60),
  // Cada atualizacao reancora o preco simulado de Forex e avisa a interface.
  onUpdate: () => engine.applyReferenceQuotes(),
});
engine.attachReferenceQuotes(referenceQuotes);
referenceQuotes.start();

// --- Cotacao publica de cripto (Binance Spot) -------------------------------
const cryptoQuotes = new CryptoQuotesService({
  statsRefreshSeconds: Number(process.env.CRYPTO_STATS_REFRESH_SECONDS ?? 60),
  onUpdate: () => engine.applyCryptoQuotes(),
});
engine.attachCryptoQuotes(cryptoQuotes);
void cryptoQuotes.start();

// --- Telegram (MTProto, conta do usuario) -----------------------------------
const telegram = new TelegramService({
  // Segredos ficam no backend. Nenhum dos dois chega ao frontend, a URL ou log.
  apiId: process.env.TELEGRAM_API_ID,
  apiHash: process.env.TELEGRAM_API_HASH,
  store,
  bridge: createTelegramEngineBridge(engine),
  onUpdate: () => engine.notifyState(),
});
/*
 * Reaproveita a sessao salva, quando houver. Sem credenciais, nao tenta nada.
 * Nao bloqueia a subida do servidor: uma rede lenta ou indisponivel atrasaria o
 * painel inteiro por causa de uma integracao opcional.
 */
void telegram.init();

const generator = new SignalGenerator(engine);

// Laco do mercado simulado.
const ticker = setInterval(() => engine.tick(TICK_SECONDS), TICK_SECONDS * 1000);

const app = createApp(engine, generator, telegram);
const server = app.listen(PORT, () => {
  console.log(`[api] Backend em http://localhost:${PORT}`);
  console.log(`[api] Banco: ${DB_PATH}`);
  console.log(
    recovered ? '[api] Estado recuperado do banco.' : '[api] Banco vazio: ambiente de demonstracao semeado.',
  );
  if (store.lastMigration) {
    const m = store.lastMigration;
    console.log(
      `[api] Migracao v${m.fromVersion} -> v${m.toVersion}: ${m.sourcesMigrated} fonte(s), ${m.signalsMigrated} sinal(is), ${m.recordsMigrated} outro(s) registro(s).`,
    );
    if (m.sourcesNeedingClassification.length > 0) {
      console.log(
        `[api] Precisam de classificacao de mercado: ${m.sourcesNeedingClassification.join(', ')}`,
      );
    }
  }
  console.log('[api] Mercados: FOREX e CRYPTO, com convergencia e automacao independentes.');
  // Registra apenas a PRESENCA da credencial. O valor nunca e impresso.
  console.log(
    referenceQuotes.configured
      ? `[api] Cotacao de referencia (AwesomeAPI): ativa, atualizando a cada ${referenceQuotes.refreshSeconds} s.`
      : '[api] Cotacao de referencia (AwesomeAPI): NAO CONFIGURADA. Defina AWESOMEAPI_KEY no .env da raiz e reinicie.',
  );
  console.log(
    '[api] Cotacao de cripto (Binance Spot, dados publicos): sem chave, somente leitura de mercado.',
  );
  /*
   * Diferenca deliberada entre "variaveis preenchidas" e "conta conectada".
   * Ter as credenciais NAO e conexao.
   */
  console.log(
    telegram.configured
      ? `[api] Telegram: credenciais configuradas. Estado da conta: ${telegram.state}.`
      : '[api] Telegram: CONFIGURACAO PENDENTE. Defina TELEGRAM_API_ID e TELEGRAM_API_HASH no .env da raiz e reinicie.',
  );
  console.log('[api] Conta SIMULADA. Nenhuma corretora real conectada.');
});

let closing = false;
function shutdown(signal: string): void {
  if (closing) return;
  closing = true;
  console.log(`[api] ${signal} recebido. Gravando estado antes de sair.`);
  clearInterval(ticker);
  generator.stop();
  referenceQuotes.stop();
  cryptoQuotes.stop();
  telegram.stopWatchdog();
  try {
    engine.shutdown();
  } catch (error) {
    console.error('[api] Falha ao gravar o estado final:', error);
  }
  server.close(() => process.exit(0));
  // Se conexoes abertas segurarem o servidor, sai mesmo assim.
  setTimeout(() => process.exit(0), 2000).unref();
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => shutdown(signal));
}
process.on('beforeExit', () => shutdown('beforeExit'));
