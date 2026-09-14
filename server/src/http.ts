import cors from 'cors';
import express from 'express';
import { brokerCatalog } from './brokers/registry.ts';
import { parseFreeText } from './core/ingestion.ts';
import { INSTRUMENTS, instrumentsOfMarket } from './core/instruments.ts';
import {
  cloneConvergenceDefaults,
  cloneRiskDefaults,
  defaultGlobalRiskSettings,
  settingDescriptors,
} from './core/settings.ts';
import type { Engine } from './engine/engine.ts';
import { SCHEMA_VERSION } from './infra/store.ts';
import { scenarioByKey, scenarios } from './scenarios.ts';
import { seed } from './seed.ts';
import type { SignalGenerator } from './sources/generator.ts';
import { registerTelegramRoutes } from './telegram/routes.ts';
import type { TelegramService } from './telegram/telegramService.ts';
import type { MarketId, OperationMode, Side, Venue } from './core/types.ts';
import { MARKET_IDS, MARKET_LABEL } from './core/types.ts';

function parseMarket(value: unknown): MarketId | null {
  return value === 'FOREX' || value === 'CRYPTO' ? value : null;
}

export function createApp(
  engine: Engine,
  generator: SignalGenerator,
  telegram?: TelegramService,
) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '256kb' }));

  /*
   * Rotas do Telegram ficam em modulo proprio e tem guarda propria: sao rotas de
   * configuracao e autenticacao, nao de leitura do painel.
   */
  if (telegram) registerTelegramRoutes(app, telegram);

  /** Resolve `:marketId` da rota, respondendo 400 quando invalido. */
  const withMarket = (
    handler: (marketId: MarketId, req: express.Request, res: express.Response) => unknown,
  ) => {
    return (req: express.Request, res: express.Response) => {
      const marketId = parseMarket(String(req.params.marketId ?? '').toUpperCase());
      if (!marketId) {
        res.status(400).json({ error: 'Mercado invalido. Use FOREX ou CRYPTO.' });
        return;
      }
      return handler(marketId, req, res);
    };
  };

  // --- Estado ---------------------------------------------------------------

  app.get('/api/state', (_req, res) => {
    res.json(engine.snapshot());
  });

  app.get('/api/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = () => res.write(`data: ${JSON.stringify({ type: 'state' })}\n\n`);
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
      markets: MARKET_IDS.map((id) => ({ id, label: MARKET_LABEL[id] })),
      instruments: INSTRUMENTS,
      instrumentsByMarket: {
        FOREX: instrumentsOfMarket('FOREX'),
        CRYPTO: instrumentsOfMarket('CRYPTO'),
      },
      brokers: brokerCatalog,
      descriptors: settingDescriptors,
      scenarios: scenarios.map(({ key, name, marketId, description, expected }) => ({
        key,
        name,
        marketId,
        description,
        expected,
      })),
      defaults: {
        convergence: {
          FOREX: cloneConvergenceDefaults('FOREX'),
          CRYPTO: cloneConvergenceDefaults('CRYPTO'),
        },
        risk: { FOREX: cloneRiskDefaults('FOREX'), CRYPTO: cloneRiskDefaults('CRYPTO') },
        global: defaultGlobalRiskSettings,
      },
    });
  });

  // --- Controles por mercado -------------------------------------------------

  app.post(
    '/api/markets/:marketId/mode',
    withMarket((marketId, req, res) => {
      const mode = req.body?.mode as OperationMode;
      if (!['OBSERVE', 'SEMI_AUTO', 'AUTO'].includes(mode)) {
        return res.status(400).json({ error: 'Modo invalido.' });
      }
      engine.setMode(marketId, mode);
      res.json({ ok: true, marketId, mode });
    }),
  );

  app.post(
    '/api/markets/:marketId/automation',
    withMarket((marketId, req, res) => {
      engine.setAutomationEnabled(marketId, Boolean(req.body?.enabled));
      res.json({ ok: true, marketId, enabled: engine.markets[marketId].automationEnabled });
    }),
  );

  app.post(
    '/api/markets/:marketId/account',
    withMarket((marketId, req, res) => {
      const result = engine.setAccountForMarket(marketId, String(req.body?.accountId ?? ''));
      res.status(result.ok ? 200 : 409).json(result);
    }),
  );

  app.put(
    '/api/markets/:marketId/settings/convergence',
    withMarket((marketId, req, res) => {
      engine.updateConvergenceSettings(marketId, req.body ?? {});
      res.json({ ok: true, settings: engine.markets[marketId].convergence });
    }),
  );

  app.put(
    '/api/markets/:marketId/settings/risk',
    withMarket((marketId, req, res) => {
      engine.updateRiskSettings(marketId, req.body ?? {});
      res.json({ ok: true, settings: engine.markets[marketId].risk });
    }),
  );

  app.post(
    '/api/markets/:marketId/settings/reset',
    withMarket((marketId, req, res) => {
      const group = req.body?.group;
      if (group === 'convergencia') {
        engine.updateConvergenceSettings(marketId, cloneConvergenceDefaults(marketId));
      } else if (group === 'risco' || group === 'execucao') {
        engine.updateRiskSettings(marketId, cloneRiskDefaults(marketId));
      } else {
        engine.updateConvergenceSettings(marketId, cloneConvergenceDefaults(marketId));
        engine.updateRiskSettings(marketId, cloneRiskDefaults(marketId));
      }
      res.json({ ok: true });
    }),
  );

  // --- Controles globais -----------------------------------------------------

  app.post('/api/global/pause', (req, res) => {
    engine.setGlobalPaused(Boolean(req.body?.paused));
    res.json({ ok: true, paused: engine.globalPaused });
  });

  app.put('/api/global/risk', (req, res) => {
    engine.updateGlobalRiskSettings(req.body ?? {});
    res.json({ ok: true, settings: engine.globalRisk });
  });

  app.post('/api/global/reset', (_req, res) => {
    engine.updateGlobalRiskSettings({ ...defaultGlobalRiskSettings });
    res.json({ ok: true });
  });

  // --- Contas ----------------------------------------------------------------

  app.post('/api/accounts/:accountId/connection', async (req, res) => {
    const accountId = String(req.params.accountId);
    if (!engine.accounts.has(accountId)) return res.status(404).json({ error: 'Conta desconhecida.' });
    await engine.setConnected(accountId, Boolean(req.body?.connected));
    res.json({ ok: true, connected: engine.accounts.get(accountId)?.isConnected() });
  });

  app.post('/api/accounts/:accountId/failure', (req, res) => {
    const broker = engine.accounts.get(String(req.params.accountId));
    if (!broker) return res.status(404).json({ error: 'Conta desconhecida.' });
    const mode = req.body?.mode;
    if (!['NONE', 'TIMEOUT', 'REJECT', 'DISCONNECTED'].includes(mode)) {
      return res.status(400).json({ error: 'Modo de falha invalido.' });
    }
    broker.failureMode = mode;
    engine.log(
      'SCENARIO_RUN',
      'WARN',
      null,
      `Modo de falha em ${broker.getAccount().brokerName}: ${mode}`,
      'Ajuste valido apenas para contas simuladas.',
    );
    res.json({ ok: true, mode });
  });

  app.post('/api/accounts/:accountId/cashflow', (req, res) => {
    const broker = engine.accounts.get(String(req.params.accountId));
    if (!broker) return res.status(404).json({ error: 'Conta desconhecida.' });
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount)) return res.status(400).json({ error: 'Valor invalido.' });
    broker.applyCashFlow(amount);
    engine.log(
      'SETTINGS_CHANGED',
      'INFO',
      null,
      amount >= 0 ? 'Deposito registrado' : 'Saque registrado',
      `${amount.toFixed(2)} ${broker.getAccount().currency} lancado em ${broker.getAccount().accountId}. Depositos e saques ficam fora do resultado operacional.`,
    );
    engine.runPipeline();
    res.json({ ok: true });
  });

  // --- Fontes ---------------------------------------------------------------

  app.get('/api/sources', (_req, res) => res.json(engine.sources));

  app.post('/api/sources', (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    if (!name) return res.status(400).json({ error: 'Nome obrigatorio.' });
    const markets = Array.isArray(req.body?.markets)
      ? (req.body.markets.filter((m: unknown) => parseMarket(m) != null) as MarketId[])
      : [];
    const source = engine.addSource({
      name,
      kind: req.body?.kind ?? 'MANUAL',
      markets,
      independenceGroupId: req.body?.independenceGroupId || undefined,
      tags: req.body?.tags ?? [],
      notes: req.body?.notes ?? '',
      weightByMarket: req.body?.weightByMarket ?? { FOREX: 1, CRYPTO: 1 },
    });
    res.json(source);
  });

  app.patch('/api/sources/:id', (req, res) => {
    const patch = { ...(req.body ?? {}) };
    if (Array.isArray(patch.markets)) {
      patch.markets = patch.markets.filter((m: unknown) => parseMarket(m) != null);
    }
    const source = engine.updateSource(String(req.params.id), patch);
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
      raw: { text: String(body.text ?? ''), externalMessageId: body.externalMessageId ?? null },
      parsedBy: body.parsedBy ?? 'MANUAL',
      parserConfidence: body.parserConfidence ?? null,
      action: body.action ?? 'NEW',
      marketId: parseMarket(body.marketId),
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
      marketId: parseMarket(body.marketId) ?? draft?.marketId ?? null,
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

  app.post('/api/generator/round', (req, res) => {
    const marketId = parseMarket(String(req.body?.marketId ?? '').toUpperCase());
    if (marketId) generator.round(marketId);
    else generator.roundAll();
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
    const positionId = String(req.params.id);
    for (const broker of engine.accounts.values()) {
      if (broker.getPositions().some((p) => p.id === positionId)) {
        await broker.closePosition(positionId, 'MANUAL');
        engine.runPipeline();
        return res.json({ ok: true });
      }
    }
    res.status(404).json({ error: 'Posicao nao encontrada.' });
  });

  // --- Cotacao de referencia -------------------------------------------------

  /**
   * Estado e cotacoes da integracao externa. A chave NUNCA sai daqui: a resposta
   * carrega apenas se a integracao esta configurada, nunca o valor da credencial.
   */
  app.get('/api/quotes/forex', (_req, res) => {
    const service = engine.referenceQuotes;
    if (!service) {
      return res.json({
        status: {
          configured: false,
          state: 'NAO_CONFIGURADA',
          message:
            'Integracao nao configurada. Defina AWESOMEAPI_KEY no ambiente do backend (arquivo .env na raiz do projeto) e reinicie o servidor.',
          source: 'AwesomeAPI',
        },
        quotes: [],
      });
    }
    res.json(service.snapshot());
  });

  /** Forca uma consulta agora. A trava de concorrencia do servico continua valendo. */
  app.post('/api/quotes/forex/refresh', async (_req, res) => {
    const service = engine.referenceQuotes;
    if (!service) return res.status(409).json({ error: 'Integracao nao configurada.' });
    await service.refresh();
    engine.applyReferenceQuotes();
    res.json(service.snapshot());
  });

  // --- Cotacao publica de cripto (Binance Spot) ------------------------------

  app.get('/api/quotes/crypto', (_req, res) => {
    const service = engine.cryptoQuotes;
    if (!service) {
      return res.json({
        status: {
          state: 'INDISPONIVEL',
          message: 'Integracao de cotacao de cripto nao iniciada neste processo.',
          source: 'BINANCE_SPOT',
          sourceLabel: 'Binance · Spot',
        },
        quotes: [],
      });
    }
    res.json(service.snapshot());
  });

  /** Recarga por REST. Util para recuperar sem esperar o proximo ciclo. */
  app.post('/api/quotes/crypto/refresh', async (_req, res) => {
    const service = engine.cryptoQuotes;
    if (!service) return res.status(409).json({ error: 'Integracao nao iniciada.' });
    await service.refreshFromRest();
    engine.applyCryptoQuotes();
    res.json(service.snapshot());
  });

  /** Troca os pares acompanhados. Aceita apenas o que exchangeInfo confirmar. */
  app.post('/api/quotes/crypto/symbols', async (req, res) => {
    const service = engine.cryptoQuotes;
    if (!service) return res.status(409).json({ error: 'Integracao nao iniciada.' });
    const symbols = Array.isArray(req.body?.symbols) ? req.body.symbols.map(String) : [];
    const result = await service.setSymbols(symbols);
    engine.applyCryptoQuotes();
    res.status(result.ok ? 200 : 400).json(result);
  });

  /** Candles para grafico, direto do REST publico. */
  app.get('/api/quotes/crypto/klines', async (req, res) => {
    const service = engine.cryptoQuotes;
    if (!service) return res.status(409).json({ error: 'Integracao nao iniciada.' });
    const symbol = String(req.query.symbol ?? '').toUpperCase();
    if (!service.selectedSymbols.includes(symbol)) {
      return res.status(400).json({ error: `Par ${symbol || '(vazio)'} nao esta entre os acompanhados.` });
    }
    const result = await service.klines(
      symbol,
      String(req.query.interval ?? '1m'),
      Number(req.query.limit ?? 60),
    );
    res.status(result.ok ? 200 : 502).json(result);
  });

  // --- Banco -----------------------------------------------------------------

  app.get('/api/db', (_req, res) => {
    if (!engine.store) return res.json({ enabled: false });
    res.json({
      enabled: true,
      path: engine.store.path,
      schemaVersion: SCHEMA_VERSION,
      counts: engine.store.counts(),
      countsByMarket: engine.store.countsByMarket(),
      lastMigration: engine.store.lastMigration,
    });
  });

  app.post('/api/db/reset', (req, res) => {
    if (!engine.store) return res.status(409).json({ error: 'Nenhum banco configurado.' });
    if (req.body?.confirm !== 'APAGAR') {
      return res.status(400).json({
        error: 'Confirmacao ausente. Envie {"confirm":"APAGAR"} para apagar o banco.',
      });
    }
    engine.resetEnvironment(seed);
    res.json({ ok: true, counts: engine.store.counts() });
  });

  // --- Cenarios --------------------------------------------------------------

  app.post('/api/scenarios/:key', async (req, res) => {
    const scenario = scenarioByKey.get(String(req.params.key));
    if (!scenario) return res.status(404).json({ error: 'Cenario desconhecido.' });
    engine.log(
      'SCENARIO_RUN',
      'INFO',
      scenario.marketId,
      `Cenario: ${scenario.name}`,
      scenario.description,
    );
    await scenario.run(engine, generator);
    engine.runPipeline();
    await engine.flush();
    res.json({ ok: true, expected: scenario.expected });
  });

  return app;
}
