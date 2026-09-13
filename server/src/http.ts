import cors from 'cors';
import express from 'express';
import { brokerCatalog } from './brokers/registry.ts';
import { parseFreeText } from './core/ingestion.ts';
import { INSTRUMENTS } from './core/instruments.ts';
import {
  defaultConvergenceSettings,
  defaultRiskSettings,
  settingDescriptors,
} from './core/settings.ts';
import type { Engine } from './engine/engine.ts';
import { scenarioByKey, scenarios } from './scenarios.ts';
import type { SignalGenerator } from './sources/generator.ts';
import type { OperationMode, Side, Venue } from './core/types.ts';

export function createApp(engine: Engine, generator: SignalGenerator) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '256kb' }));

  // --- Estado ---------------------------------------------------------------

  app.get('/api/state', (_req, res) => {
    res.json(engine.snapshot());
  });

  app.get('/api/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = () => {
      res.write(`data: ${JSON.stringify({ type: 'state' })}\n\n`);
    };
    send();
    const unsubscribe = engine.subscribe((event) => {
      if (event.type === 'state') send();
    });
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
      res.end();
    });
  });

  app.get('/api/meta', (_req, res) => {
    res.json({
      instruments: INSTRUMENTS,
      brokers: brokerCatalog,
      descriptors: settingDescriptors,
      scenarios: scenarios.map(({ key, name, description, expected }) => ({
        key,
        name,
        description,
        expected,
      })),
      defaults: {
        convergence: defaultConvergenceSettings,
        risk: defaultRiskSettings,
      },
    });
  });

  // --- Controles ------------------------------------------------------------

  app.post('/api/mode', (req, res) => {
    const mode = req.body?.mode as OperationMode;
    if (!['OBSERVE', 'SEMI_AUTO', 'AUTO'].includes(mode)) {
      return res.status(400).json({ error: 'Modo invalido.' });
    }
    engine.setMode(mode);
    res.json({ ok: true, mode });
  });

  app.post('/api/automation/pause', (req, res) => {
    engine.setAutomationPaused(Boolean(req.body?.paused));
    res.json({ ok: true, paused: engine.automationPaused });
  });

  app.post('/api/connection', async (req, res) => {
    await engine.setConnected(Boolean(req.body?.connected));
    res.json({ ok: true, connected: engine.broker.isConnected() });
  });

  app.post('/api/broker/failure', (req, res) => {
    const mode = req.body?.mode;
    if (!['NONE', 'TIMEOUT', 'REJECT', 'DISCONNECTED'].includes(mode)) {
      return res.status(400).json({ error: 'Modo de falha invalido.' });
    }
    engine.broker.failureMode = mode;
    engine.log(
      'SCENARIO_RUN',
      'WARN',
      `Modo de falha do simulador: ${mode}`,
      'Ajuste valido apenas para a corretora simulada.',
    );
    res.json({ ok: true, mode });
  });

  app.post('/api/account/cashflow', (req, res) => {
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount)) return res.status(400).json({ error: 'Valor invalido.' });
    engine.broker.applyCashFlow(amount);
    engine.day.cashFlows += amount;
    engine.log(
      'SETTINGS_CHANGED',
      'INFO',
      amount >= 0 ? 'Deposito registrado' : 'Saque registrado',
      `${amount.toFixed(2)} lancado no saldo. Depositos e saques ficam fora do resultado operacional do dia.`,
    );
    engine.runPipeline();
    res.json({ ok: true });
  });

  // --- Configuracoes --------------------------------------------------------

  app.put('/api/settings/convergence', (req, res) => {
    engine.updateConvergenceSettings(req.body ?? {});
    res.json({ ok: true, settings: engine.convergenceSettings });
  });

  app.put('/api/settings/risk', (req, res) => {
    engine.updateRiskSettings(req.body ?? {});
    res.json({ ok: true, settings: engine.riskSettings });
  });

  app.post('/api/settings/reset', (req, res) => {
    const group = req.body?.group;
    if (group === 'convergencia') engine.updateConvergenceSettings({ ...defaultConvergenceSettings });
    else if (group === 'risco' || group === 'execucao') engine.updateRiskSettings({ ...defaultRiskSettings });
    else {
      engine.updateConvergenceSettings({ ...defaultConvergenceSettings });
      engine.updateRiskSettings({ ...defaultRiskSettings });
    }
    res.json({ ok: true });
  });

  // --- Fontes ---------------------------------------------------------------

  app.get('/api/sources', (_req, res) => res.json(engine.sources));

  app.post('/api/sources', (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    if (!name) return res.status(400).json({ error: 'Nome obrigatorio.' });
    const source = engine.addSource({
      name,
      kind: req.body?.kind ?? 'MANUAL',
      independenceGroupId: req.body?.independenceGroupId || undefined,
      tags: req.body?.tags ?? [],
      notes: req.body?.notes ?? '',
      weight: Number(req.body?.weight ?? 1),
    });
    res.json(source);
  });

  app.patch('/api/sources/:id', (req, res) => {
    const source = engine.updateSource(String(req.params.id), req.body ?? {});
    if (!source) return res.status(404).json({ error: 'Fonte nao encontrada.' });
    res.json(source);
  });

  app.delete('/api/sources/:id', (req, res) => {
    const ok = engine.removeSource(String(req.params.id));
    if (!ok) return res.status(404).json({ error: 'Fonte nao encontrada.' });
    res.json({ ok: true });
  });

  // --- Sinais ---------------------------------------------------------------

  app.post('/api/signals', (req, res) => {
    const body = req.body ?? {};
    const result = engine.ingestSignal({
      sourceId: String(body.sourceId ?? ''),
      raw: {
        text: String(body.text ?? ''),
        externalMessageId: body.externalMessageId ?? null,
      },
      parsedBy: body.parsedBy ?? 'MANUAL',
      parserConfidence: body.parserConfidence ?? null,
      action: body.action ?? 'NEW',
      symbol: body.symbol ?? null,
      venue: (body.venue ?? null) as Venue | null,
      side: (body.side ?? null) as Side | null,
      emittedAt: body.emittedAt ?? engine.clock.nowIso(),
      timeframeMinutes: body.timeframeMinutes ?? null,
      horizonMinutes: body.horizonMinutes ?? null,
      validUntil: body.validUntil ?? null,
      entryType: body.entryType ?? (body.entryPrice == null ? 'MARKET' : 'LIMIT'),
      entryPrice: body.entryPrice ?? null,
      stopLoss: body.stopLoss ?? null,
      takeProfit: body.takeProfit ?? null,
    });
    res.json(result);
  });

  /** Pre-visualizacao do parser de texto livre, sem gravar nada. */
  app.post('/api/signals/parse', (req, res) => {
    res.json(parseFreeText(String(req.body?.text ?? '')));
  });

  app.post('/api/webhook/:token', (req, res) => {
    const token = String(req.params.token);
    const source = engine.sources.find((s) => s.kind === 'WEBHOOK' && s.webhookToken === token);
    if (!source) return res.status(404).json({ error: 'Token de webhook desconhecido.' });

    const body = req.body ?? {};
    const text = String(body.text ?? body.message ?? '');
    const draft = text ? parseFreeText(text) : null;

    const result = engine.ingestSignal({
      sourceId: source.id,
      raw: { text, externalMessageId: body.id ?? null, payload: body },
      parsedBy: draft ? 'AI_ASSISTED' : 'WEBHOOK',
      parserConfidence: draft?.confidence ?? null,
      action: body.action ?? 'NEW',
      symbol: body.symbol ?? draft?.symbol ?? null,
      venue: body.venue ?? null,
      side: body.side ?? draft?.side ?? null,
      emittedAt: body.emittedAt ?? engine.clock.nowIso(),
      timeframeMinutes: body.timeframeMinutes ?? draft?.timeframeMinutes ?? null,
      horizonMinutes: body.horizonMinutes ?? null,
      entryPrice: body.entryPrice ?? draft?.entryPrice ?? null,
      stopLoss: body.stopLoss ?? draft?.stopLoss ?? null,
      takeProfit: body.takeProfit ?? draft?.takeProfit ?? null,
    });
    res.json(result);
  });

  // --- Gerador ---------------------------------------------------------------

  app.get('/api/generator', (_req, res) =>
    res.json({ running: generator.running, config: generator.config }),
  );

  app.post('/api/generator/start', (_req, res) => {
    generator.start();
    res.json({ ok: true, running: generator.running });
  });

  app.post('/api/generator/stop', (_req, res) => {
    generator.stop();
    res.json({ ok: true, running: generator.running });
  });

  app.post('/api/generator/round', (_req, res) => {
    generator.round();
    res.json({ ok: true });
  });

  app.put('/api/generator/config', (req, res) => {
    generator.setConfig(req.body ?? {});
    res.json({ ok: true, config: generator.config });
  });

  // --- Oportunidades e operacoes --------------------------------------------

  app.post('/api/opportunities/:id/confirm', async (req, res) => {
    const result = await engine.confirmOpportunity(String(req.params.id));
    res.status(result.ok ? 200 : 409).json(result);
  });

  app.post('/api/opportunities/:id/reject', (req, res) => {
    const ok = engine.rejectOpportunity(String(req.params.id));
    res.status(ok ? 200 : 404).json({ ok });
  });

  app.post('/api/positions/:id/close', async (req, res) => {
    await engine.broker.closePosition(String(req.params.id), 'MANUAL');
    engine.runPipeline();
    res.json({ ok: true });
  });

  // --- Cenarios --------------------------------------------------------------

  app.post('/api/scenarios/:key', async (req, res) => {
    const scenario = scenarioByKey.get(String(req.params.key));
    if (!scenario) return res.status(404).json({ error: 'Cenario desconhecido.' });
    engine.log('SCENARIO_RUN', 'INFO', `Cenario: ${scenario.name}`, scenario.description);
    await scenario.run(engine, generator);
    engine.runPipeline();
    await engine.flush();
    res.json({ ok: true, expected: scenario.expected });
  });

  return app;
}
