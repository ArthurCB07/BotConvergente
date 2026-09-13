import type { Engine } from './engine/engine.ts';

/**
 * Fontes iniciais do prototipo.
 *
 * Repare em `src_alfa_vip`: e um espelho de `src_alfa` e compartilha o mesmo grupo
 * de independencia. As duas juntas valem UM voto. Isso existe para mostrar que
 * nomes diferentes nao provam origens diferentes.
 */
export function seed(engine: Engine): void {
  engine.addSource({
    id: 'src_alfa',
    name: 'Sala Alfa FX',
    kind: 'GENERATOR',
    independenceGroupId: 'grupo_alfa',
    tags: ['intradia'],
    notes: 'Sala de sinais intradia em pares major.',
  });
  engine.addSource({
    id: 'src_alfa_vip',
    name: 'Alfa VIP (espelho)',
    kind: 'GENERATOR',
    independenceGroupId: 'grupo_alfa',
    tags: ['intradia', 'espelho'],
    notes:
      'Retransmite o conteudo da Sala Alfa. Compartilha grupo de independencia com src_alfa: as duas contam como um voto so.',
  });
  engine.addSource({
    id: 'src_beta',
    name: 'Mesa Beta',
    kind: 'GENERATOR',
    independenceGroupId: 'grupo_beta',
    tags: ['intradia'],
    notes: 'Mesa propria com analise tecnica.',
  });
  engine.addSource({
    id: 'src_gama',
    name: 'Gama Signals',
    kind: 'GENERATOR',
    independenceGroupId: 'grupo_gama',
    tags: ['intradia'],
    notes: 'Provedor com entrega por API.',
  });
  engine.addSource({
    id: 'src_delta',
    name: 'Delta Pro',
    kind: 'GENERATOR',
    independenceGroupId: 'grupo_delta',
    tags: ['swing'],
    notes: 'Opera horizontes mais longos. Util para testar a checagem de horizonte.',
  });
  engine.addSource({
    id: 'src_webhook',
    name: 'Webhook externo',
    kind: 'WEBHOOK',
    independenceGroupId: 'grupo_webhook',
    webhookToken: 'demo-token',
    tags: ['integracao'],
    notes:
      'Recebe POST em /api/webhook/demo-token. Aceita texto livre ou campos ja normalizados.',
  });
  engine.addSource({
    id: 'src_manual',
    name: 'Entrada manual',
    kind: 'MANUAL',
    independenceGroupId: 'grupo_manual',
    tags: ['operador'],
    notes: 'Formulario da tela Fontes.',
  });

  engine.log(
    'SCENARIO_RUN',
    'INFO',
    'Ambiente de demonstracao pronto',
    'Conta SIMULADA com USD 10.000, modo Observacao, 7 fontes cadastradas (6 grupos de independencia). Nenhuma conexao real foi estabelecida.',
  );
}
