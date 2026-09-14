import { id } from './core/ids.ts';
import type { Engine } from './engine/engine.ts';
import type { MarketId } from './core/types.ts';
import { MARKET_LABEL } from './core/types.ts';
import type { SignalGenerator } from './sources/generator.ts';

/**
 * Cenarios de demonstracao.
 *
 * Cada cenario exercita um caminho do fluxo e deixa o rastro no historico de
 * decisoes, carimbado com o mercado. Todos operam sobre contas SIMULADAS.
 */

export interface ScenarioDefinition {
  key: string;
  name: string;
  /** Mercado destacado pelo cenario. `null` = cobre os dois. */
  marketId: MarketId | null;
  description: string;
  expected: string;
  run: (engine: Engine, generator: SignalGenerator) => Promise<void> | void;
}

/**
 * Alguns cenarios precisam enviar ordem. Se o momento atual estiver fora dos dias
 * ou horarios permitidos do mercado (fim de semana em Forex, por exemplo), o
 * portao de horario bloqueia o envio e o cenario nao demonstra nada.
 *
 * A janela e aberta de forma EXPLICITA: a alteracao vira evento de auditoria, para
 * que nenhuma configuracao do usuario mude em silencio.
 */
function openTradingWindowForDemo(engine: Engine, marketId: MarketId): void {
  const risk = engine.markets[marketId].risk;
  const allDays = [1, 2, 3, 4, 5, 6, 7];
  const needsChange =
    risk.tradingDays.length !== allDays.length ||
    risk.tradingWindows[0]?.start !== '00:00' ||
    risk.tradingWindows[0]?.end !== '23:59';
  if (!needsChange) return;

  const before = { days: [...risk.tradingDays], windows: risk.tradingWindows.map((w) => ({ ...w })) };
  engine.markets[marketId].risk = {
    ...risk,
    tradingDays: allDays,
    tradingWindows: [{ start: '00:00', end: '23:59' }],
  };
  engine.log(
    'SETTINGS_CHANGED',
    'WARN',
    marketId,
    `Cenario abriu dias e horarios de ${MARKET_LABEL[marketId]}`,
    `Para demonstrar o envio de ordem, os dias permitidos passaram de [${before.days.join(', ')}] para todos e a janela para 00:00-23:59. ` +
      'Restaure os valores sugeridos na tela Configuracoes antes de qualquer uso serio.',
  );
}

/** Prepara um mercado para executar: conta ligada, automacao ligada, dia limpo. */
async function armMarket(engine: Engine, marketId: MarketId): Promise<void> {
  await engine.connectAll();
  openTradingWindowForDemo(engine, marketId);
  const day = engine.markets[marketId].day;
  day.realizedNetPnl = 0;
  day.dailyLimitHit = null;
  day.pausedUntil = null;
  day.consecutiveLosses = 0;
  day.lastEntryAt = null;
  engine.globalDay.realizedNetPnl = 0;
  engine.globalDay.dailyLimitHit = null;
  engine.setAutomationEnabled(marketId, true);
  engine.setMode(marketId, 'AUTO');
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

const FOREX_TRIO = ['src_alfa', 'src_beta', 'src_gama'];
const CRYPTO_TRIO = ['src_satoshi', 'src_altseason', 'src_onchain'];

export const scenarios: ScenarioDefinition[] = [
  // --- Forex ----------------------------------------------------------------
  {
    key: 'convergencia_forex',
    name: 'Forex: concordancia suficiente',
    marketId: 'FOREX',
    description:
      'Tres grupos de Forex concordam com compra em EURUSD, um discorda. O espelho da Alfa envia o mesmo sinal e nao gera voto extra.',
    expected: '3 de 4 fontes participantes de Forex (75%). Cripto nao entra no calculo.',
    run: (engine, generator) => {
      clearRecentSignals(engine, 'EURUSD');
      generator.emit({ sourceId: 'src_alfa', symbol: 'EURUSD', side: 'BUY' });
      generator.emit({ sourceId: 'src_alfa_vip', symbol: 'EURUSD', side: 'BUY', entryOffsetPips: 0.5 });
      generator.emit({ sourceId: 'src_beta', symbol: 'EURUSD', side: 'BUY', entryOffsetPips: 1.5 });
      generator.emit({ sourceId: 'src_gama', symbol: 'EURUSD', side: 'BUY', entryOffsetPips: -2 });
      generator.emit({ sourceId: 'src_delta', symbol: 'EURUSD', side: 'SELL', entryOffsetPips: 1 });
    },
  },
  {
    key: 'sinais_contrarios',
    name: 'Forex: sinais contrarios derrubam a convergencia',
    marketId: 'FOREX',
    description: 'Dois grupos compram GBPUSD e dois vendem, no mesmo instrumento e janela.',
    expected: 'Concordancia de 50%, abaixo do minimo. Nenhuma oportunidade publicada.',
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
    name: 'Forex: sinal expirado nao vota',
    marketId: 'FOREX',
    description: 'Tres fontes concordam em AUDUSD, porem dois sinais passaram da idade maxima.',
    expected: 'Sinais marcados como expirados. A contagem cai e a oportunidade nao e publicada.',
    run: (engine, generator) => {
      clearRecentSignals(engine, 'AUDUSD');
      const a = generator.emit({ sourceId: 'src_alfa', symbol: 'AUDUSD', side: 'BUY' });
      const b = generator.emit({ sourceId: 'src_beta', symbol: 'AUDUSD', side: 'BUY' });
      generator.emit({ sourceId: 'src_gama', symbol: 'AUDUSD', side: 'BUY' });
      const ageMinutes = engine.markets.FOREX.convergence.maxSignalAgeMinutes + 5;
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
    name: 'Forex: mensagem duplicada',
    marketId: 'FOREX',
    description: 'A mesma mensagem da Sala Alfa chega duas vezes em USDJPY.',
    expected: 'A segunda entrega e reconhecida pelo identificador. Nenhum voto novo.',
    run: (engine) => {
      clearRecentSignals(engine, 'USDJPY');
      const messageId = id('msg');
      const payload = {
        sourceId: 'src_alfa',
        raw: {
          text: 'COMPRA USDJPY M15 entrada: 155.200 SL: 155.000 TP: 155.500',
          externalMessageId: messageId,
        },
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
    name: 'Forex: mensagem editada pela fonte',
    marketId: 'FOREX',
    description: 'A Sala Alfa publica compra em USDCHF e edita a mesma mensagem invertendo para venda.',
    expected: 'O sinal original vira versao substituida. Somente a versao 2 vota.',
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
        raw: { text: 'CORRECAO: VENDA USDCHF M15 entrada: 0.88900', externalMessageId: messageId },
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
    key: 'otc_nao_mistura',
    name: 'Forex: OTC nao entra no mesmo agrupamento',
    marketId: 'FOREX',
    description: 'Duas fontes indicam compra em EURUSD regular e duas em EURUSD-OTC.',
    expected: 'Dois agrupamentos separados, 2 participantes cada. Nenhum atinge o minimo de 3.',
    run: (engine, generator) => {
      clearRecentSignals(engine, 'EURUSD');
      clearRecentSignals(engine, 'EURUSD-OTC');
      generator.emit({ sourceId: 'src_alfa', symbol: 'EURUSD', side: 'BUY' });
      generator.emit({ sourceId: 'src_beta', symbol: 'EURUSD', side: 'BUY' });
      generator.emit({ sourceId: 'src_gama', symbol: 'EURUSD-OTC', side: 'BUY' });
      generator.emit({ sourceId: 'src_delta', symbol: 'EURUSD-OTC', side: 'BUY' });
    },
  },

  // --- Cripto ---------------------------------------------------------------
  {
    key: 'convergencia_cripto',
    name: 'Cripto: concordancia suficiente',
    marketId: 'CRYPTO',
    description: 'Tres salas de cripto concordam com compra em BTCUSDT a vista.',
    expected: 'Oportunidade de Cripto publicada. Forex nao participa nem e afetado.',
    run: (engine, generator) => {
      clearRecentSignals(engine, 'BTCUSDT');
      for (const sourceId of CRYPTO_TRIO) {
        generator.emit({ sourceId, symbol: 'BTCUSDT', side: 'BUY', entryOffsetPips: (Math.random() - 0.5) * 10 });
      }
    },
  },
  {
    key: 'spot_vs_perp',
    name: 'Cripto: a vista e perpetuo nao convergem juntos',
    marketId: 'CRYPTO',
    description:
      'Duas salas compram BTCUSDT a vista e duas compram BTCUSDT-PERP, no mesmo par e na mesma janela.',
    expected:
      'Dois agrupamentos separados por tipo de produto, com 2 participantes cada. Nenhum atinge o minimo de 3.',
    run: (engine, generator) => {
      clearRecentSignals(engine, 'BTCUSDT');
      clearRecentSignals(engine, 'BTCUSDT-PERP');
      generator.emit({ sourceId: 'src_satoshi', symbol: 'BTCUSDT', side: 'BUY' });
      generator.emit({ sourceId: 'src_altseason', symbol: 'BTCUSDT', side: 'BUY', entryOffsetPips: 2 });
      generator.emit({ sourceId: 'src_perpdesk', symbol: 'BTCUSDT-PERP', side: 'BUY' });
      generator.emit({ sourceId: 'src_whale', symbol: 'BTCUSDT-PERP', side: 'BUY', entryOffsetPips: 2 });
    },
  },
  {
    key: 'mercado_nao_cadastrado',
    name: 'Cripto: sinal de mercado fora do cadastro da fonte',
    marketId: null,
    description: 'A Sala Alfa, cadastrada so para Forex, envia um sinal de BTCUSDT.',
    expected:
      'Sinal marcado como mercado nao cadastrado. Fica registrado e visivel, porem fora da convergencia dos dois mercados.',
    run: (engine, generator) => {
      generator.emit({ sourceId: 'src_alfa', symbol: 'BTCUSDT', side: 'BUY' });
    },
  },
  {
    key: 'cripto_nao_afeta_forex',
    name: 'Isolamento: Cripto nao muda a concordancia de Forex',
    marketId: null,
    description:
      'Primeiro gera dois votos de compra em EURUSD (insuficiente). Depois enche o mercado de Cripto com seis votos concordantes.',
    expected:
      'A avaliacao de Forex continua com 2 participantes e segue abaixo do corte. Cripto publica a sua propria oportunidade.',
    run: (engine, generator) => {
      clearRecentSignals(engine, 'EURUSD');
      clearRecentSignals(engine, 'ETHUSDT');
      generator.emit({ sourceId: 'src_alfa', symbol: 'EURUSD', side: 'BUY' });
      generator.emit({ sourceId: 'src_beta', symbol: 'EURUSD', side: 'BUY', entryOffsetPips: 1 });
      for (const sourceId of [...CRYPTO_TRIO, 'src_cryptoscalp', 'src_whale', 'src_global']) {
        generator.emit({ sourceId, symbol: 'ETHUSDT', side: 'BUY', entryOffsetPips: (Math.random() - 0.5) * 8 });
      }
      engine.runPipeline();
    },
  },
  {
    key: 'base_percentual',
    name: 'Base do percentual: habilitadas x com sinal',
    marketId: 'CRYPTO',
    description:
      'Tres salas de cripto concordam. Alterna a base do percentual entre "fontes habilitadas" e "sinais comparaveis" para mostrar a diferenca no denominador.',
    expected:
      'Com "sinais comparaveis" o denominador e 3 (100%). Com "fontes habilitadas" o denominador vira o total de grupos do mercado, e o silencio pesa contra.',
    run: (engine, generator) => {
      clearRecentSignals(engine, 'SOLUSDT');
      for (const sourceId of CRYPTO_TRIO) {
        generator.emit({ sourceId, symbol: 'SOLUSDT', side: 'BUY', entryOffsetPips: (Math.random() - 0.5) * 6 });
      }
      engine.updateConvergenceSettings('CRYPTO', { denominatorMode: 'ENABLED_SOURCES' });
      engine.runPipeline();
    },
  },

  // --- Automacao e limites --------------------------------------------------
  {
    key: 'automacao_independente',
    name: 'Automacao independente por mercado',
    marketId: null,
    description:
      'Liga a automacao de Cripto, desliga a de Forex e publica convergencia elegivel nos dois.',
    expected:
      'Cripto envia ordem. Forex publica a oportunidade e a bloqueia com o motivo "automacao desligada", mantendo sinais e posicoes.',
    run: async (engine, generator) => {
      await engine.connectAll();
      openTradingWindowForDemo(engine, 'FOREX');
      engine.setMode('FOREX', 'AUTO');
      engine.setMode('CRYPTO', 'AUTO');
      engine.setAutomationEnabled('FOREX', false);
      engine.setAutomationEnabled('CRYPTO', true);
      engine.markets.CRYPTO.day.lastEntryAt = null;
      clearRecentSignals(engine, 'EURUSD');
      clearRecentSignals(engine, 'BTCUSDT');
      for (const sourceId of FOREX_TRIO) generator.emit({ sourceId, symbol: 'EURUSD', side: 'BUY' });
      for (const sourceId of CRYPTO_TRIO) generator.emit({ sourceId, symbol: 'BTCUSDT', side: 'BUY' });
      engine.runPipeline();
      await engine.flush();
    },
  },
  {
    key: 'execucao_simultanea',
    name: 'Execucao simultanea nos dois mercados',
    marketId: null,
    description:
      'Automacao ligada nos dois, convergencia elegivel em EURUSD e em BTCUSDT na mesma passagem do pipeline.',
    expected:
      'Duas ordens simuladas, uma por mercado, cada uma com sua conta e sua reserva de margem. Nenhuma reusa o saldo da outra.',
    run: async (engine, generator) => {
      await armMarket(engine, 'FOREX');
      await armMarket(engine, 'CRYPTO');
      engine.updateGlobalRiskSettings({ maxOpenPositionsTotal: 2 });
      clearRecentSignals(engine, 'EURUSD');
      clearRecentSignals(engine, 'BTCUSDT');
      for (const sourceId of FOREX_TRIO) generator.emit({ sourceId, symbol: 'EURUSD', side: 'BUY' });
      for (const sourceId of CRYPTO_TRIO) generator.emit({ sourceId, symbol: 'BTCUSDT', side: 'BUY' });
      engine.runPipeline();
      await engine.flush();
    },
  },
  {
    key: 'limite_global',
    name: 'Limite global bloqueia os dois mercados',
    marketId: null,
    description:
      'Reduz o maximo global de posicoes para 1, abre uma posicao em Forex e tenta abrir outra em Cripto.',
    expected:
      'A segunda entrada e bloqueada pelo portao global, com o motivo marcado como GLOBAL, mesmo com o limite individual de Cripto livre.',
    run: async (engine, generator) => {
      await armMarket(engine, 'FOREX');
      await armMarket(engine, 'CRYPTO');
      engine.updateGlobalRiskSettings({ enabled: true, maxOpenPositionsTotal: 1 });
      clearRecentSignals(engine, 'EURUSD');
      clearRecentSignals(engine, 'BTCUSDT');
      for (const sourceId of FOREX_TRIO) generator.emit({ sourceId, symbol: 'EURUSD', side: 'BUY' });
      engine.runPipeline();
      await engine.flush();
      for (const sourceId of CRYPTO_TRIO) generator.emit({ sourceId, symbol: 'BTCUSDT', side: 'BUY' });
      engine.runPipeline();
      await engine.flush();
    },
  },
  {
    key: 'stop_diario_mercado',
    name: 'Stop diario de um mercado nao para o outro',
    marketId: null,
    description:
      'Forca o resultado realizado de Forex abaixo do limite diario e publica convergencia elegivel nos dois mercados.',
    expected:
      'Forex bloqueado pelo stop diario do mercado. Cripto continua elegivel: o limite individual so vale no mercado dele.',
    run: async (engine, generator) => {
      await armMarket(engine, 'FOREX');
      await armMarket(engine, 'CRYPTO');
      const base = engine.markets.FOREX.day.baseEquity || 10_000;
      engine.markets.FOREX.day.realizedNetPnl =
        -(base * engine.markets.FOREX.risk.dailyLossLimitPercent) / 100 - 1;
      engine.log(
        'DAILY_LIMIT_HIT',
        'BLOCK',
        'FOREX',
        'Stop loss diario de Forex atingido (cenario)',
        `Resultado realizado de Forex forcado para ${engine.markets.FOREX.day.realizedNetPnl.toFixed(2)} a fim de demonstrar o bloqueio por mercado.`,
      );
      clearRecentSignals(engine, 'EURUSD');
      clearRecentSignals(engine, 'BTCUSDT');
      for (const sourceId of FOREX_TRIO) generator.emit({ sourceId, symbol: 'EURUSD', side: 'BUY' });
      for (const sourceId of CRYPTO_TRIO) generator.emit({ sourceId, symbol: 'BTCUSDT', side: 'BUY' });
      engine.runPipeline();
      await engine.flush();
    },
  },
  {
    key: 'falha_conexao',
    name: 'Falha de conexao na conta',
    marketId: null,
    description: 'Derruba a conta compartilhada e tenta executar convergencias elegiveis.',
    expected:
      'Cotacoes param de atualizar. Os portoes de conexao e de idade da cotacao bloqueiam qualquer envio nos mercados que usam essa conta.',
    run: async (engine, generator) => {
      clearRecentSignals(engine, 'EURUSD');
      for (const sourceId of FOREX_TRIO) generator.emit({ sourceId, symbol: 'EURUSD', side: 'BUY' });
      await engine.setConnected('paper', false);
    },
  },
  {
    key: 'timeout_reconciliacao',
    name: 'Timeout de ordem e reconciliacao',
    marketId: 'FOREX',
    description:
      'Coloca a conta em modo de timeout, envia uma ordem de Forex e forca a reconciliacao pela chave de cliente.',
    expected:
      'A ordem expira sem resposta, o sistema consulta o estado pela chave e confirma a execucao sem enviar ordem duplicada.',
    run: async (engine, generator) => {
      await armMarket(engine, 'FOREX');
      engine.brokerFor('FOREX').failureMode = 'TIMEOUT';
      clearRecentSignals(engine, 'EURUSD');
      for (const sourceId of FOREX_TRIO) generator.emit({ sourceId, symbol: 'EURUSD', side: 'BUY' });
      engine.runPipeline();
      await engine.flush();
      engine.brokerFor('FOREX').failureMode = 'NONE';
    },
  },
  {
    key: 'execucao_completa_cripto',
    name: 'Cripto: fluxo completo ate a execucao',
    marketId: 'CRYPTO',
    description:
      'Automacao de Cripto ligada, tres salas concordantes em BTCUSDT. Depois empurra o preco ate o alvo.',
    expected:
      'Publica, aprova no risco, envia ordem, abre posicao simulada e encerra no take profit, registrando o resultado em Cripto.',
    run: async (engine, generator) => {
      await armMarket(engine, 'CRYPTO');
      clearRecentSignals(engine, 'BTCUSDT');
      for (const sourceId of CRYPTO_TRIO) generator.emit({ sourceId, symbol: 'BTCUSDT', side: 'BUY' });
      engine.runPipeline();
      await engine.flush();
      engine.brokerFor('CRYPTO').nudge('BTCUSDT', 300);
      engine.runPipeline();
      await engine.flush();
    },
  },
  {
    key: 'execucao_completa_forex',
    name: 'Forex: fluxo completo ate a execucao',
    marketId: 'FOREX',
    description:
      'Automacao de Forex ligada, tres salas concordantes em EURUSD. Depois empurra o preco ate o alvo.',
    expected: 'Publica, aprova, envia, abre posicao simulada e encerra no take profit.',
    run: async (engine, generator) => {
      await armMarket(engine, 'FOREX');
      clearRecentSignals(engine, 'EURUSD');
      for (const sourceId of FOREX_TRIO) generator.emit({ sourceId, symbol: 'EURUSD', side: 'BUY' });
      engine.runPipeline();
      await engine.flush();
      engine.brokerFor('FOREX').nudge('EURUSD', 35);
      engine.runPipeline();
      await engine.flush();
    },
  },
];

export const scenarioByKey = new Map(scenarios.map((s) => [s.key, s]));
