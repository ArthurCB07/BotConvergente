import type { Engine } from './engine/engine.ts';

/**
 * Fontes iniciais do prototipo, nos dois mercados.
 *
 * Tres arranjos existem de proposito:
 *  - `src_alfa` e `src_alfa_vip` compartilham grupo de independencia: duas fontes,
 *    UM voto em Forex.
 *  - `src_global` atende Forex E Cripto: uma fonte so, roteando cada sinal para o
 *    mercado certo, sem duplicar voto dentro de um mercado.
 *  - As demais sao exclusivas de um mercado.
 */
export function seed(engine: Engine): void {
  // --- Forex ----------------------------------------------------------------
  engine.addSource({
    id: 'src_alfa',
    name: 'Sala Alfa FX',
    kind: 'GENERATOR',
    markets: ['FOREX'],
    independenceGroupId: 'grupo_alfa',
    tags: ['intradia'],
    notes: 'Sala de sinais intradia em pares major.',
  });
  engine.addSource({
    id: 'src_alfa_vip',
    name: 'Alfa VIP (espelho)',
    kind: 'GENERATOR',
    markets: ['FOREX'],
    independenceGroupId: 'grupo_alfa',
    tags: ['intradia', 'espelho'],
    notes:
      'Retransmite o conteudo da Sala Alfa. Mesmo grupo de independencia: as duas contam como um voto so.',
  });
  engine.addSource({
    id: 'src_beta',
    name: 'Mesa Beta',
    kind: 'GENERATOR',
    markets: ['FOREX'],
    independenceGroupId: 'grupo_beta',
    tags: ['intradia'],
    notes: 'Mesa propria com analise tecnica.',
  });
  engine.addSource({
    id: 'src_gama',
    name: 'Gama Signals',
    kind: 'GENERATOR',
    markets: ['FOREX'],
    independenceGroupId: 'grupo_gama',
    tags: ['intradia'],
    notes: 'Provedor com entrega por API.',
  });
  engine.addSource({
    id: 'src_delta',
    name: 'Delta Pro',
    kind: 'GENERATOR',
    markets: ['FOREX'],
    independenceGroupId: 'grupo_delta',
    tags: ['swing'],
    notes: 'Opera horizontes mais longos. Util para testar a checagem de horizonte.',
  });

  // --- Cripto ---------------------------------------------------------------
  engine.addSource({
    id: 'src_satoshi',
    name: 'Satoshi Room',
    kind: 'GENERATOR',
    markets: ['CRYPTO'],
    independenceGroupId: 'grupo_satoshi',
    tags: ['spot'],
    notes: 'Sala de cripto a vista, foco em BTC e ETH.',
  });
  engine.addSource({
    id: 'src_altseason',
    name: 'Altseason Desk',
    kind: 'GENERATOR',
    markets: ['CRYPTO'],
    independenceGroupId: 'grupo_altseason',
    tags: ['spot'],
    notes: 'Cobre altcoins de maior liquidez.',
  });
  engine.addSource({
    id: 'src_onchain',
    name: 'OnChain Alerts',
    kind: 'GENERATOR',
    markets: ['CRYPTO'],
    independenceGroupId: 'grupo_onchain',
    tags: ['spot'],
    notes: 'Provedor com entrega por API.',
  });
  engine.addSource({
    id: 'src_perpdesk',
    name: 'Perp Desk',
    kind: 'GENERATOR',
    markets: ['CRYPTO'],
    independenceGroupId: 'grupo_perpdesk',
    tags: ['derivativos'],
    notes: 'Opera perpetuos. Nunca soma votos com as salas de a vista.',
  });
  engine.addSource({
    id: 'src_cryptoscalp',
    name: 'Crypto Scalp 24h',
    kind: 'GENERATOR',
    markets: ['CRYPTO'],
    independenceGroupId: 'grupo_cryptoscalp',
    tags: ['spot', 'scalp'],
    notes: 'Timeframes curtos, sala ativa 24 horas.',
  });
  engine.addSource({
    id: 'src_whale',
    name: 'Whale Watch',
    kind: 'GENERATOR',
    markets: ['CRYPTO'],
    independenceGroupId: 'grupo_whale',
    tags: ['spot'],
    notes: 'Sala de cripto com horizonte mais longo.',
  });

  // --- Fontes que atendem os dois mercados ----------------------------------
  engine.addSource({
    id: 'src_global',
    name: 'Mesa Global (Forex e Cripto)',
    kind: 'GENERATOR',
    markets: ['FOREX', 'CRYPTO'],
    independenceGroupId: 'grupo_global',
    tags: ['multimercado'],
    notes:
      'Publica os dois mercados. Cadastrada uma vez com os dois: cada sinal vai para o mercado certo e a fonte vale um voto em cada mercado, nunca dois no mesmo.',
  });
  engine.addSource({
    id: 'src_webhook',
    name: 'Webhook externo',
    kind: 'WEBHOOK',
    markets: ['FOREX', 'CRYPTO'],
    independenceGroupId: 'grupo_webhook',
    webhookToken: 'demo-token',
    tags: ['integracao'],
    notes:
      'Recebe POST em /api/webhook/demo-token. O mercado sai do instrumento reconhecido na mensagem.',
  });
  engine.addSource({
    id: 'src_manual',
    name: 'Entrada manual',
    kind: 'MANUAL',
    markets: ['FOREX', 'CRYPTO'],
    independenceGroupId: 'grupo_manual',
    tags: ['operador'],
    notes: 'Formulario da tela Fontes.',
  });

  engine.log(
    'SCENARIO_RUN',
    'INFO',
    null,
    'Ambiente de demonstracao pronto',
    'Conta SIMULADA compartilhada com USD 10.000 e conta de cripto separada com USDT 5.000. ' +
      'Os dois mercados em modo Observacao, automacao desligada. ' +
      '14 fontes: 6 grupos participam de Forex e 9 de Cripto. Nenhuma conexao real foi estabelecida.',
  );
}
