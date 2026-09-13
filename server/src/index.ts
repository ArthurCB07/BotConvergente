import { resolve } from 'node:path';
import { Engine } from './engine/engine.ts';
import { createApp } from './http.ts';
import { Store } from './infra/store.ts';
import { seed } from './seed.ts';
import { SignalGenerator } from './sources/generator.ts';

const PORT = Number(process.env.PORT ?? 8787);
const TICK_SECONDS = 1;
/*
 * Caminho ancorado no proprio modulo, nao no diretorio de onde o comando saiu:
 * `npm run dev` na raiz e `npm start` dentro de server/ precisam abrir o mesmo banco.
 */
const DB_PATH = process.env.DB_PATH ?? resolve(import.meta.dirname, '..', 'data', 'app.db');

const store = new Store(DB_PATH);
const engine = new Engine({ initialBalance: 10_000, seed: 20260913, store });

const recovered = engine.hydrate();
if (!recovered) {
  seed(engine);
  engine.persistRuntime(true);
}

// Descarta o excedente de historico na entrada, alem do descarte na saida.
store.prune();

await engine.setConnected(true);

const generator = new SignalGenerator(engine);

// Laco do mercado simulado.
const ticker = setInterval(() => engine.tick(TICK_SECONDS), TICK_SECONDS * 1000);

const app = createApp(engine, generator);
const server = app.listen(PORT, () => {
  console.log(`[api] Backend em http://localhost:${PORT}`);
  console.log(`[api] Banco: ${DB_PATH}`);
  console.log(
    recovered ? '[api] Estado recuperado do banco.' : '[api] Banco vazio: ambiente de demonstracao semeado.',
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
