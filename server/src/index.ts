import { Engine } from './engine/engine.ts';
import { createApp } from './http.ts';
import { seed } from './seed.ts';
import { SignalGenerator } from './sources/generator.ts';

const PORT = Number(process.env.PORT ?? 8787);
const TICK_SECONDS = 1;

const engine = new Engine({ initialBalance: 10_000, seed: 20260913 });
seed(engine);
await engine.setConnected(true);

const generator = new SignalGenerator(engine);

// Laco do mercado simulado.
setInterval(() => engine.tick(TICK_SECONDS), TICK_SECONDS * 1000);

const app = createApp(engine, generator);

app.listen(PORT, () => {
  console.log(`[api] Backend em http://localhost:${PORT}`);
  console.log('[api] Conta SIMULADA. Nenhuma corretora real conectada.');
});
