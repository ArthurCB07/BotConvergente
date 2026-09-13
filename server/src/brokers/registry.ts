import type { BrokerDescriptor } from './types.ts';

/**
 * Corretoras conhecidas pelo produto.
 *
 * Regra: nada aqui alega conexao que nao exista. Somente `paper` esta implementado.
 * MetaTrader 5 e cTrader aparecem com status NOT_IMPLEMENTED e a lista do que falta,
 * com base na documentacao oficial de cada plataforma.
 */

export const brokerCatalog: BrokerDescriptor[] = [
  {
    id: 'paper',
    name: 'Simulador local (conta simulada)',
    status: 'CONNECTED',
    markets: ['FX_SPOT'],
    capabilities: {
      account: true,
      positions: true,
      marketOrders: true,
      attachedStops: true,
      cancelOrders: true,
      clientOrderIdLookup: true,
      demoEnvironment: true,
      requiresLocalTerminal: false,
    },
    authentication: 'Nenhuma. Roda dentro do proprio backend.',
    requirements: [],
    restrictions: [
      'Precos sinteticos por passeio aleatorio com semente fixa.',
      'Nao reproduz liquidez real, gaps de noticia nem rejeicoes de corretora.',
      'Serve para validar o fluxo do produto, nao para estimar resultado.',
    ],
    docsUrl: '',
    accountType: 'SIMULADA',
  },
  {
    id: 'mt5',
    name: 'MetaTrader 5 (integracao Python oficial)',
    status: 'NOT_IMPLEMENTED',
    markets: ['FX_SPOT', 'CFD', 'FUTUROS'],
    capabilities: {
      account: true,
      positions: true,
      marketOrders: true,
      attachedStops: true,
      cancelOrders: true,
      clientOrderIdLookup: true,
      demoEnvironment: true,
      requiresLocalTerminal: true,
    },
    authentication:
      'Login numerico, senha e nome do servidor da corretora, informados ao terminal MetaTrader 5 local. Nao usa OAuth.',
    requirements: [
      'Terminal MetaTrader 5 instalado, logado e com negociacao algoritmica habilitada.',
      'Servico intermediario em Python com o pacote oficial MetaTrader5, exposto ao backend por uma API interna.',
      'O pacote oficial e distribuido para Windows; em outros sistemas exige camada de compatibilidade.',
      'Mapear o identificador de cliente para o campo de comentario ou magic number da ordem, para reconciliacao.',
    ],
    restrictions: [
      'A corretora precisa oferecer MetaTrader 5 e permitir negociacao automatizada na conta.',
      'Terminal fechado ou sem sessao derruba a integracao inteira.',
      'Instrumentos, digitos e lote minimo variam por corretora: o catalogo precisa ser lido do servidor, nao presumido.',
    ],
    docsUrl: 'https://www.mql5.com/en/docs/python_metatrader5',
    accountType: 'DEMO_CORRETORA',
  },
  {
    id: 'ctrader',
    name: 'cTrader Open API (Spotware)',
    status: 'NOT_IMPLEMENTED',
    markets: ['FX_SPOT', 'CFD'],
    capabilities: {
      account: true,
      positions: true,
      marketOrders: true,
      attachedStops: true,
      cancelOrders: true,
      clientOrderIdLookup: true,
      demoEnvironment: true,
      requiresLocalTerminal: false,
    },
    authentication:
      'OAuth 2.0 em duas etapas: autenticacao da aplicacao (client id e secret) e autenticacao da conta de negociacao com access token. O access token expira e e renovado por refresh token.',
    requirements: [
      'Registrar a aplicacao no portal de desenvolvedores da Spotware e obter aprovacao.',
      'Cliente Protobuf sobre TCP com TLS (endpoints separados para demo e conta real).',
      'Fluxo de consentimento do usuario no navegador para emitir o codigo de autorizacao, valido por tempo curto.',
      'Armazenamento cifrado do refresh token no backend, fora do frontend e fora dos logs.',
    ],
    restrictions: [
      'A corretora do usuario precisa oferecer cTrader.',
      'O escopo de leitura de conta e o de negociacao sao concedidos separadamente: da para conectar so leitura primeiro.',
      'Disponibilidade por regiao depende da corretora, nao da Spotware.',
    ],
    docsUrl: 'https://help.ctrader.com/open-api/',
    accountType: 'DEMO_CORRETORA',
  },
];

export const brokerById = new Map(brokerCatalog.map((b) => [b.id, b]));
