import { id } from './core/ids.ts';
import type { Engine } from './engine/engine.ts';
import type { SignalGenerator } from './sources/generator.ts';

/**
 * Cenarios de demonstracao.
 *
 * Cada cenario exercita um caminho do fluxo completo e deixa o rastro no historico
 * de decisoes. Todos operam sobre a conta SIMULADA.
 */

export interface ScenarioDefinition {
  key: string;
  name: string;
  description: string;
  expected: string;
  run: (engine: Engine, generator: SignalGenerator) => Promise<void> | void;
}

/**
 * Alguns cenarios precisam enviar ordem. Se o momento atual estiver fora dos dias
 * ou horarios permitidos (fim de semana, por exemplo), o portao de horario bloqueia
 * o envio e o cenario nao demonstra nada.
 *
 * Aqui a janela e aberta de forma EXPLICITA: a alteracao vira evento de auditoria,
 * para que nenhuma configuracao do usuario mude em silencio.
 */
function openTradingWindowForDemo(engine: Engine): void {
  const before = {
    tradingDays: engine.riskSettings.tradingDays,
    tradingWindows: engine.riskSettings.tradingWindows,
  };
  const allDays = [1, 2, 3, 4, 5, 6, 7];
  const fullDay = [{ start: '00:00', end: '23:59' }];
  const needsChange =
    before.tradingDays.length !== allDays.length ||
    before.tradingWindows[0]?.start !== '00:00' ||
    before.tradingWindows[0]?.end !== '23:59';
  if (!needsChange) return;

  engine.riskSettings = { ...engine.riskSettings, tradingDays: allDays, tradingWindows: fullDay };
  engine.log(
    'SETTINGS_CHANGED',
    'WARN',
    'Cenario abriu dias e horarios permitidos',
    `Para demonstrar o envio de ordem, os dias permitidos passaram de [${before.tradingDays.join(', ')}] para todos e a janela para 00:00-23:59. ` +
      'Restaure os valores sugeridos na tela Configuracoes antes de qualquer uso serio: forex spot nao negocia no fim de semana.',
  );
}

function clearRecentSignals(engine: Engine, symbol: string): void {
  for (const signal of engine.signals) {
    if (signal.symbol === symbol && signal.status === 'VALID') {
      signal.status = 'CANCELLED';
      signal.issues = [
        ...signal.issues,
        { code: 'LIMPEZA_CENARIO', message: 'Removido para isolar o cenario.', severity: 'INFO' },
      ];
    }
  }
}

export const scenarios: ScenarioDefinition[] = [
  {
    key: 'convergencia_suficiente',
    name: 'Concordancia suficiente',
    description:
      'Tres grupos de independencia concordam com compra em EURUSD, um discorda. Espelho da Alfa envia o mesmo sinal e nao gera voto extra.',
    expected:
      'Publica oportunidade com 3 de 4 fontes participantes (75%). O espelho aparece como nao participante, com o motivo.',
    run: (engine, generator) => {
      clearRecentSignals(engine, 'EURUSD');
      generator.emit({ sourceId: 'src_alfa', symbol: 'EURUSD', side: 'BUY', entryOffsetPips: 0 });
      generator.emit({ sourceId: 'src_alfa_vip', symbol: 'EURUSD', side: 'BUY', entryOffsetPips: 0.5 });
      generator.emit({ sourceId: 'src_beta', symbol: 'EURUSD', side: 'BUY', entryOffsetPips: 1.5 });
      generator.emit({ sourceId: 'src_gama', symbol: 'EURUSD', side: 'BUY', entryOffsetPips: -2 });
      generator.emit({ sourceId: 'src_delta', symbol: 'EURUSD', side: 'SELL', entryOffsetPips: 1 });
    },
  },
  {
    key: 'sinais_contrarios',
    name: 'Sinais contrarios derrubam a convergencia',
    description: 'Dois grupos compram GBPUSD e dois vendem, no mesmo instrumento e janela.',
    expected:
      'Concordancia de 50%, abaixo do minimo de 75%. Nenhuma oportunidade publicada; a tela Convergencias mostra o motivo.',
    run: (engine, generator) => {
      clearRecentSignals(engine, 'GBPUSD');
      generator.emit({ sourceId: 'src_alfa', symbol: 'GBPUSD', side: 'BUY' });
      generator.emit({ sourceId: 'src_beta', symbol: 'GBPUSD', side: 'BUY', entryOffsetPips: 1 });
      generator.emit({ sourceId: 'src_gama', symbol: 'GBPUSD', side: 'SELL', entryOffsetPips: -1 });
      generator.emit({ sourceId: 'src_delta', symbol: 'GBPUSD', side: 'SELL' });
    },
  },
  {
    key: 'expiracao',
    name: 'Sinal expirado nao vota',
    description:
      'Tres fontes concordam em AUDUSD, porem dois sinais chegaram ha mais tempo que a idade maxima configurada.',
    expected: 'Sinais marcados como expirados. A contagem cai e a oportunidade nao e publicada.',
    run: (engine, generator) => {
      clearRecentSignals(engine, 'AUDUSD');
      const a = generator.emit({ sourceId: 'src_alfa', symbol: 'AUDUSD', side: 'BUY' });
      const b = generator.emit({ sourceId: 'src_beta', symbol: 'AUDUSD', side: 'BUY' });
      generator.emit({ sourceId: 'src_gama', symbol: 'AUDUSD', side: 'BUY' });

      // Envelhece artificialmente dois sinais para alem da idade maxima.
      const ageMinutes = engine.convergenceSettings.maxSignalAgeMinutes + 5;
      const past = new Date(Date.parse(engine.clock.nowIso()) - ageMinutes * 60_000).toISOString();
      for (const signalId of [a.signalId, b.signalId]) {
        const signal = engine.signals.find((s) => s.id === signalId);
        if (signal) {
          signal.receivedAt = past;
          signal.emittedAt = past;
        }
      }
      engine.runPipeline();
    },
  },
  {
    key: 'duplicacao',
    name: 'Mensagem duplicada',
    description: 'A mesma mensagem da Sala Alfa chega duas vezes em USDJPY.',
    expected:
      'A segunda entrega e reconhecida como duplicata pelo identificador de mensagem. Nenhum voto novo, registro no historico.',
    run: (engine) => {
      clearRecentSignals(engine, 'USDJPY');
      const messageId = id('msg');
      const payload = {
        sourceId: 'src_alfa',
        raw: { text: 'COMPRA USDJPY M15 entrada: 155.200 SL: 155.000 TP: 155.500', externalMessageId: messageId },
        parsedBy: 'GENERATOR' as const,
        symbol: 'USDJPY',
        venue: 'REGULAR' as const,
        side: 'BUY' as const,
        emittedAt: engine.clock.nowIso(),
        timeframeMinutes: 15,
        horizonMinutes: 60,
        entryType: 'LIMIT' as const,
        entryPrice: 155.2,
        stopLoss: 155.0,
        takeProfit: 155.5,
      };
      engine.ingestSignal(payload);
      engine.ingestSignal(payload);
    },
  },
  {
    key: 'edicao_mensagem',
    name: 'Mensagem editada pela fonte',
    description:
      'A Sala Alfa publica compra em USDCHF e em seguida edita a mesma mensagem invertendo a direcao para venda.',
    expected:
      'O sinal original vira versao substituida e para de votar. Somente a versao 2 permanece vigente.',
    run: (engine) => {
      clearRecentSignals(engine, 'USDCHF');
      const messageId = id('msg');
      engine.ingestSignal({
        sourceId: 'src_alfa',
        raw: { text: 'COMPRA USDCHF M15 entrada: 0.88900', externalMessageId: messageId },
        parsedBy: 'GENERATOR',
        symbol: 'USDCHF',
        venue: 'REGULAR',
        side: 'BUY',
        emittedAt: engine.clock.nowIso(),
        timeframeMinutes: 15,
        horizonMinutes: 60,
        entryType: 'LIMIT',
        entryPrice: 0.889,
      });
      engine.ingestSignal({
        sourceId: 'src_alfa',
        raw: {
          text: 'CORRECAO: VENDA USDCHF M15 entrada: 0.88900',
          externalMessageId: messageId,
        },
        parsedBy: 'GENERATOR',
        action: 'EDIT',
        symbol: 'USDCHF',
        venue: 'REGULAR',
        side: 'SELL',
        emittedAt: engine.clock.nowIso(),
        timeframeMinutes: 15,
        horizonMinutes: 60,
        entryType: 'LIMIT',
        entryPrice: 0.889,
      });
    },
  },
  {
    key: 'cancelamento',
    name: 'Cancelamento pela fonte',
    description: 'A Mesa Beta envia um sinal e depois cancela a mesma mensagem.',
    expected: 'O voto sai do agrupamento imediatamente e o cancelamento fica registrado.',
    run: (engine) => {
      const messageId = id('msg');
      engine.ingestSignal({
        sourceId: 'src_beta',
        raw: { text: 'VENDA EURUSD M15 entrada: 1.08500', externalMessageId: messageId },
        parsedBy: 'GENERATOR',
        symbol: 'EURUSD',
        venue: 'REGULAR',
        side: 'SELL',
        emittedAt: engine.clock.nowIso(),
        timeframeMinutes: 15,
        horizonMinutes: 60,
        entryType: 'LIMIT',
        entryPrice: 1.085,
      });
      engine.ingestSignal({
        sourceId: 'src_beta',
        raw: { text: 'CANCELADO', externalMessageId: messageId },
        parsedBy: 'GENERATOR',
        action: 'CANCEL',
      });
    },
  },
  {
    key: 'mensagem_ambigua',
    name: 'Mensagem ambigua nao vira operacao',
    description:
      'Texto livre contendo termos de compra e de venda ao mesmo tempo, interpretado com confianca baixa.',
    expected: 'Sinal marcado como ambiguo pela validacao determinista. Nao vota e nao gera ordem.',
    run: (engine) => {
      engine.ingestSignal({
        sourceId: 'src_webhook',
        raw: {
          text: 'pessoal, quem comprou EURUSD segura; quem quiser pode vender na maxima tambem',
          externalMessageId: id('msg'),
        },
        parsedBy: 'AI_ASSISTED',
        parserConfidence: 0.42,
        symbol: 'EURUSD',
        venue: 'REGULAR',
        side: 'BUY',
        emittedAt: engine.clock.nowIso(),
        timeframeMinutes: 15,
        horizonMinutes: 60,
        entryType: 'MARKET',
      });
    },
  },
  {
    key: 'otc_nao_mistura',
    name: 'OTC nao entra no mesmo agrupamento',
    description:
      'Duas fontes indicam compra em EURUSD regular e duas indicam compra em EURUSD-OTC.',
    expected:
      'Dois agrupamentos separados, cada um com 2 participantes. Nenhum atinge o minimo de 3 fontes.',
    run: (engine, generator) => {
      clearRecentSignals(engine, 'EURUSD');
      clearRecentSignals(engine, 'EURUSD-OTC');
      generator.emit({ sourceId: 'src_alfa', symbol: 'EURUSD', side: 'BUY' });
      generator.emit({ sourceId: 'src_beta', symbol: 'EURUSD', side: 'BUY' });
      generator.emit({ sourceId: 'src_gama', symbol: 'EURUSD-OTC', side: 'BUY' });
      generator.emit({ sourceId: 'src_delta', symbol: 'EURUSD-OTC', side: 'BUY' });
    },
  },
  {
    key: 'horizonte_incompativel',
    name: 'Horizonte incompativel',
    description:
      'Tres fontes compram EURUSD em M5 e a Delta Pro compra o mesmo par com horizonte de varios dias.',
    expected:
      'O voto da Delta entra em "nao comparaveis" com o motivo. O denominador nao e inflado por ele.',
    run: (engine, generator) => {
      clearRecentSignals(engine, 'EURUSD');
      generator.emit({ sourceId: 'src_alfa', symbol: 'EURUSD', side: 'BUY', timeframeMinutes: 5, horizonMinutes: 20 });
      generator.emit({ sourceId: 'src_beta', symbol: 'EURUSD', side: 'BUY', timeframeMinutes: 5, horizonMinutes: 25 });
      generator.emit({ sourceId: 'src_gama', symbol: 'EURUSD', side: 'BUY', timeframeMinutes: 5, horizonMinutes: 20 });
      generator.emit({
        sourceId: 'src_delta',
        symbol: 'EURUSD',
        side: 'BUY',
        timeframeMinutes: 240,
        horizonMinutes: 2880,
      });
    },
  },
  {
    key: 'stop_diario',
    name: 'Stop loss diario atingido',
    description:
      'Forca o resultado realizado do dia abaixo do limite configurado e tenta publicar uma convergencia elegivel.',
    expected: 'Oportunidade publicada, porem bloqueada pelo portao de stop diario, com o motivo no historico.',
    run: (engine, generator) => {
      const base = engine.day.baseEquity || engine.broker.getAccount().equity;
      engine.day.realizedNetPnl =
        -(base * engine.riskSettings.dailyLossLimitPercent) / 100 - 1;
      engine.log(
        'DAILY_LIMIT_HIT',
        'BLOCK',
        'Stop loss diario atingido (cenario)',
        `Resultado realizado do dia forcado para ${engine.day.realizedNetPnl.toFixed(2)} a fim de demonstrar o bloqueio.`,
      );
      clearRecentSignals(engine, 'EURUSD');
      generator.emit({ sourceId: 'src_alfa', symbol: 'EURUSD', side: 'BUY' });
      generator.emit({ sourceId: 'src_beta', symbol: 'EURUSD', side: 'BUY' });
      generator.emit({ sourceId: 'src_gama', symbol: 'EURUSD', side: 'BUY' });
      engine.runPipeline();
    },
  },
  {
    key: 'falha_conexao',
    name: 'Falha de conexao com a corretora',
    description: 'Derruba a conexao e tenta executar uma convergencia elegivel.',
    expected:
      'Cotacoes param de atualizar. Os portoes de conexao e de idade da cotacao bloqueiam qualquer envio.',
    run: async (engine, generator) => {
      clearRecentSignals(engine, 'EURUSD');
      generator.emit({ sourceId: 'src_alfa', symbol: 'EURUSD', side: 'BUY' });
      generator.emit({ sourceId: 'src_beta', symbol: 'EURUSD', side: 'BUY' });
      generator.emit({ sourceId: 'src_gama', symbol: 'EURUSD', side: 'BUY' });
      await engine.setConnected(false);
    },
  },
  {
    key: 'timeout_reconciliacao',
    name: 'Timeout de ordem e reconciliacao',
    description:
      'Coloca a corretora simulada em modo de timeout, envia uma ordem e forca a reconciliacao pela chave de cliente.',
    expected:
      'A ordem expira sem resposta, o sistema consulta o estado pela chave e confirma a execucao sem enviar ordem duplicada.',
    run: async (engine, generator) => {
      await engine.setConnected(true);
      openTradingWindowForDemo(engine);
      engine.setMode('AUTO');
      engine.broker.failureMode = 'TIMEOUT';
      clearRecentSignals(engine, 'EURUSD');
      generator.emit({ sourceId: 'src_alfa', symbol: 'EURUSD', side: 'BUY' });
      generator.emit({ sourceId: 'src_beta', symbol: 'EURUSD', side: 'BUY' });
      generator.emit({ sourceId: 'src_gama', symbol: 'EURUSD', side: 'BUY' });
      engine.runPipeline();
      await engine.flush();
      engine.broker.failureMode = 'NONE';
    },
  },
  {
    key: 'execucao_completa',
    name: 'Fluxo completo ate a execucao',
    description:
      'Modo autonomo, conexao ativa, tres fontes concordantes em EURUSD. Depois empurra o preco ate o alvo.',
    expected:
      'Publica, aprova no risco, envia ordem, abre posicao simulada e encerra no take profit, registrando o resultado.',
    run: async (engine, generator) => {
      await engine.setConnected(true);
      openTradingWindowForDemo(engine);
      engine.day.realizedNetPnl = 0;
      engine.day.dailyLimitHit = null;
      engine.day.pausedUntil = null;
      engine.day.consecutiveLosses = 0;
      engine.setMode('AUTO');
      clearRecentSignals(engine, 'EURUSD');
      generator.emit({ sourceId: 'src_alfa', symbol: 'EURUSD', side: 'BUY' });
      generator.emit({ sourceId: 'src_beta', symbol: 'EURUSD', side: 'BUY' });
      generator.emit({ sourceId: 'src_gama', symbol: 'EURUSD', side: 'BUY' });
      engine.runPipeline();
      // Espera o envio concluir antes de mexer no preco: caso contrario a ordem
      // seria preenchida ja com o preco deslocado e o alvo ficaria para tras.
      await engine.flush();
      engine.broker.nudge('EURUSD', 35);
      engine.runPipeline();
      await engine.flush();
    },
  },
];

export const scenarioByKey = new Map(scenarios.map((s) => [s.key, s]));
