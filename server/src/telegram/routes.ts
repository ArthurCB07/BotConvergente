import express from 'express';
import type { MarketId } from '../core/types.ts';
import { parseProfiles } from './parseProfiles.ts';
import type { TelegramService } from './telegramService.ts';
import type { ParseProfile } from './types.ts';

/**
 * Rotas da integracao com o Telegram.
 *
 * Nada aqui devolve `api_hash`, sessao, telefone completo, codigo de verificacao
 * ou senha de duas etapas. O codigo e a senha entram pelo corpo do POST, sao
 * usados na chamada e morrem no fim da funcao — nao vao para disco nem para log.
 *
 * PROTECAO: estas rotas sao de configuracao e autenticacao, entao so aceitam
 * chamada vinda da propria maquina (endereco de laco). Quando `DASHBOARD_TOKEN`
 * estiver definido no ambiente, alem disso exigem o cabecalho `x-dashboard-token`.
 * A protecao por endereco impede acesso de outra maquina da rede; ela nao separa
 * usuarios diferentes do MESMO computador — para isso, defina o token.
 */

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function isLoopback(req: express.Request): boolean {
  const address = req.socket.remoteAddress ?? '';
  return LOOPBACK.has(address);
}

function parseMarkets(value: unknown): MarketId[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is MarketId => v === 'FOREX' || v === 'CRYPTO');
}

function parseProfile(value: unknown): ParseProfile | undefined {
  return parseProfiles.some((p) => p.id === value) ? (value as ParseProfile) : undefined;
}

export function registerTelegramRoutes(app: express.Express, telegram: TelegramService): void {
  const token = process.env.DASHBOARD_TOKEN?.trim() || null;

  const guard: express.RequestHandler = (req, res, next) => {
    if (!isLoopback(req)) {
      res.status(403).json({
        error: 'Estas rotas so aceitam chamada da propria maquina onde o backend roda.',
      });
      return;
    }
    if (token && req.header('x-dashboard-token') !== token) {
      res.status(401).json({
        error: 'Token do painel ausente ou incorreto.',
        tokenRequired: true,
      });
      return;
    }
    next();
  };

  app.use('/api/telegram', guard);

  app.get('/api/telegram/state', (_req, res) => {
    res.json({ ...telegram.snapshot(), profiles: parseProfiles, tokenRequired: token != null });
  });

  // --- Autenticacao ---------------------------------------------------------

  app.post('/api/telegram/login', async (req, res) => {
    const phone = String(req.body?.phone ?? '');
    const result = await telegram.startLogin(phone);
    res.status(result.ok ? 200 : 400).json(result);
  });

  app.post('/api/telegram/code', async (req, res) => {
    // O codigo existe apenas nesta variavel, durante esta chamada.
    const code = String(req.body?.code ?? '');
    const result = await telegram.submitCode(code);
    res.status(result.ok ? 200 : 400).json(result);
  });

  app.post('/api/telegram/password', async (req, res) => {
    // A senha existe apenas nesta variavel, durante esta chamada.
    const password = String(req.body?.password ?? '');
    const result = await telegram.submitPassword(password);
    res.status(result.ok ? 200 : 400).json(result);
  });

  app.post('/api/telegram/resend', async (_req, res) => {
    const result = await telegram.resendCode();
    res.status(result.ok ? 200 : 429).json(result);
  });

  app.post('/api/telegram/reconnect', async (_req, res) => {
    const result = await telegram.reconnect();
    res.status(result.ok ? 200 : 400).json(result);
  });

  app.post('/api/telegram/logout', async (_req, res) => {
    const result = await telegram.logout();
    res.json(result);
  });

  // --- Salas ----------------------------------------------------------------

  app.get('/api/telegram/dialogs', async (req, res) => {
    const dialogs = await telegram.listDialogs(req.query.force === '1');
    res.json({ dialogs, fetchedAt: telegram.snapshot().dialogsFetchedAt });
  });

  app.post('/api/telegram/rooms', (req, res) => {
    const body = req.body ?? {};
    const result = telegram.configureRoom({
      peerId: String(body.peerId ?? ''),
      title: body.title == null ? undefined : String(body.title),
      displayName: body.displayName == null ? undefined : String(body.displayName),
      markets: parseMarkets(body.markets),
      monitoring: typeof body.monitoring === 'boolean' ? body.monitoring : undefined,
      profile: parseProfile(body.profile),
      participatesInConvergence:
        typeof body.participatesInConvergence === 'boolean'
          ? body.participatesInConvergence
          : undefined,
      independenceGroupId:
        body.independenceGroupId == null ? undefined : String(body.independenceGroupId),
      topicIds: Array.isArray(body.topicIds)
        ? body.topicIds.map(Number).filter(Number.isFinite)
        : undefined,
    });
    res.status(result.ok ? 200 : 400).json(result);
  });

  app.post('/api/telegram/rooms/:peerId/monitoring', (req, res) => {
    const result = telegram.setMonitoring(String(req.params.peerId), Boolean(req.body?.monitoring));
    res.status(result.ok ? 200 : 400).json(result);
  });

  app.delete('/api/telegram/rooms/:peerId', (req, res) => {
    const result = telegram.removeRoom(String(req.params.peerId));
    res.status(result.ok ? 200 : 404).json(result);
  });

  // --- Atividade ------------------------------------------------------------

  app.get('/api/telegram/activity', (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 120) || 120, 400);
    const peerId = req.query.peerId ? String(req.query.peerId) : undefined;
    res.json({ activity: telegram.activityList(limit, peerId) });
  });
}
