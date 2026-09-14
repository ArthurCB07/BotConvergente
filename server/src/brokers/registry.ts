import type { BrokerDescriptor } from './types.ts';

/**
 * Conexoes conhecidas pelo produto, por mercado.
 *
 * Regra: nada aqui alega conexao que nao exista. Somente as contas `paper-*` estao
 * implementadas. MetaTrader 5, cTrader, Binance e Bybit aparecem com status
 * NOT_IMPLEMENTED e a lista do que falta, com base na documentacao oficial.
 *
 * Uma conexao de forex NAO opera cripto e vice-versa: o campo `markets` e checado
 * pelo motor de risco antes de qualquer envio.
 */

export const brokerCatalog: BrokerDescriptor[] = [
  {
    id: 'paper',
    name: 'Conta simulada compartilhada',
    status: 'CONNECTED',
    markets: ['FOREX', 'CRYPTO'],
    products: ['FX_SPOT', 'CRYPTO_SPOT', 'CRYPTO_PERP'],
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
      'Saldo unico para os dois mercados: serve para exercitar a reserva coordenada de margem.',
      'Precos sinteticos por passeio aleatorio com semente fixa.',
      'Nao reproduz liquidez real, funding de perpetuo nem rejeicoes de exchange.',
    ],
    docsUrl: '',
    accountType: 'SIMULADA',
    currency: 'USD',
  },
  {
    id: 'paper-crypto',
    name: 'Conta simulada exclusiva de cripto',
    status: 'CONNECTED',
    markets: ['CRYPTO'],
    products: ['CRYPTO_SPOT', 'CRYPTO_PERP'],
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
      'Saldo proprio, em USDT, separado do saldo de forex.',
      'Use esta conta para demonstrar o caso de contas distintas por mercado.',
      'Precos sinteticos. Resultados nao tem valor preditivo.',
    ],
    docsUrl: '',
    accountType: 'SIMULADA',
    currency: 'USDT',
  },
  {
    id: 'mt5',
    name: 'MetaTrader 5 (integracao Python oficial)',
    status: 'NOT_IMPLEMENTED',
    markets: ['FOREX'],
    products: ['FX_SPOT'],
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
      'Mapear o identificador de cliente para o campo de comentario ou magic number da ordem.',
    ],
    restrictions: [
      'Nao negocia cripto a vista nem perpetuos de exchange. Uma conexao de forex nao serve para o mercado de cripto.',
      'A corretora precisa oferecer MetaTrader 5 e permitir negociacao automatizada na conta.',
      'Terminal fechado ou sem sessao derruba a integracao inteira.',
      'Instrumentos, digitos e quantidade minima variam por corretora: leia do servidor, nao presuma.',
    ],
    docsUrl: 'https://www.mql5.com/en/docs/python_metatrader5',
    accountType: 'DEMO_CORRETORA',
    currency: 'USD',
  },
  {
    id: 'ctrader',
    name: 'cTrader Open API (Spotware)',
    status: 'NOT_IMPLEMENTED',
    markets: ['FOREX'],
    products: ['FX_SPOT'],
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
      'Fluxo de consentimento do usuario no navegador para emitir o codigo de autorizacao.',
      'Armazenamento cifrado do refresh token no backend, fora do frontend e fora dos logs.',
    ],
    restrictions: [
      'Nao atende o mercado de cripto deste produto.',
      'A corretora do usuario precisa oferecer cTrader.',
      'O escopo de leitura de conta e o de negociacao sao concedidos separadamente.',
      'Disponibilidade por regiao depende da corretora, nao da Spotware.',
    ],
    docsUrl: 'https://help.ctrader.com/open-api/',
    accountType: 'DEMO_CORRETORA',
    currency: 'USD',
  },
  {
    id: 'binance',
    name: 'Binance (Spot e Futuros, testnet)',
    status: 'NOT_IMPLEMENTED',
    markets: ['CRYPTO'],
    products: ['CRYPTO_SPOT', 'CRYPTO_PERP'],
    capabilities: {
      account: true,
      positions: true,
      marketOrders: true,
      // Spot usa ordem OCO para stop e alvo; nao e um campo anexado a ordem a mercado.
      attachedStops: false,
      cancelOrders: true,
      clientOrderIdLookup: true,
      demoEnvironment: true,
      requiresLocalTerminal: false,
    },
    authentication:
      'Chave de API e segredo, com assinatura HMAC SHA-256 sobre a query string. A chave vai no cabecalho X-MBX-APIKEY. O segredo aparece uma unica vez na criacao.',
    requirements: [
      'Conta de testnet propria: as chaves de testnet nao funcionam em producao e vice-versa.',
      'Endpoint REST de testnet separado (testnet.binance.vision para spot).',
      'Sincronizacao de relogio: requisicoes assinadas usam timestamp e janela de recepcao.',
      'Ler filtros do simbolo (passo de quantidade, passo de preco, nocional minimo) antes de dimensionar a ordem.',
      'Spot e Futuros sao APIs distintas, com contas, margem e endpoints separados.',
    ],
    restrictions: [
      'Nao negocia forex. Conexao de cripto nao serve para o mercado de forex.',
      'Disponibilidade e produtos variam por jurisdicao do usuario.',
      'Stop e alvo no spot exigem ordem OCO; o adaptador precisa emular o que em forex vai anexado a ordem.',
      'Perpetuos tem funding periodico, que o simulador atual nao reproduz.',
    ],
    docsUrl: 'https://developers.binance.com/docs/binance-spot-api-docs',
    accountType: 'DEMO_CORRETORA',
    currency: 'USDT',
  },
  {
    id: 'bybit',
    name: 'Bybit API v5 (testnet)',
    status: 'NOT_IMPLEMENTED',
    markets: ['CRYPTO'],
    products: ['CRYPTO_SPOT', 'CRYPTO_PERP'],
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
      'Chave de API e segredo com assinatura HMAC sobre timestamp + chave + janela + corpo, enviados nos cabecalhos X-BAPI-API-KEY, X-BAPI-TIMESTAMP, X-BAPI-SIGN e X-BAPI-RECV-WINDOW. Ha tambem a variante com RSA.',
    requirements: [
      'Conta e chaves de testnet proprias (api-testnet.bybit.com): as bases de usuario de testnet e producao sao separadas.',
      'API unificada v5: a categoria do produto (spot, linear) entra em cada chamada e precisa sair do cadastro do instrumento.',
      'Ler os filtros do instrumento antes de dimensionar a ordem.',
      'Armazenamento cifrado do segredo no backend.',
    ],
    restrictions: [
      'Nao negocia forex.',
      'Disponibilidade por jurisdicao do usuario.',
      'Perpetuos tem funding periodico, nao reproduzido pelo simulador.',
    ],
    docsUrl: 'https://bybit-exchange.github.io/docs/v5/intro',
    accountType: 'DEMO_CORRETORA',
    currency: 'USDT',
  },
];

export const brokerById = new Map(brokerCatalog.map((b) => [b.id, b]));
