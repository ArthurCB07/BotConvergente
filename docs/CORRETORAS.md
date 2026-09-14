# Integrações por mercado

A plataforma opera dois mercados, e **cada um tem suas próprias conexões**. Uma conexão de forex não
opera cripto e vice-versa: cada adaptador declara os mercados que atende, e o motor de risco bloqueia
o envio com `INSTRUMENTO_NAO_SUPORTADO` antes de qualquer tentativa.

Nenhuma integração real está implementada — o protótipo opera contra contas simuladas. O que segue
vem da documentação oficial de cada plataforma, consultada em setembro de 2026.

## Contas simuladas disponíveis

| | `paper` | `paper-crypto` |
|---|---|---|
| Mercados | Forex **e** Cripto | Só Cripto |
| Moeda | USD | USDT |
| Serve para demonstrar | saldo compartilhado e **reserva coordenada de margem** | contas separadas por mercado, com saldos exibidos individualmente |

## Forex

### Comparativo

| | MetaTrader 5 | cTrader Open API |
|---|---|---|
| Situação no produto | **não implementado** | **não implementado** |
| Saldo, equity e margem | sim | sim |
| Posições abertas | sim | sim |
| Envio de ordem a mercado | sim | sim |
| Cancelamento de pendentes | sim | sim |
| Stop e alvo anexados à ordem | sim | sim |
| Acompanhamento por chave de cliente | via `magic number` / comentário da ordem | via identificador da ordem |
| Ambiente demonstrativo | sim, conta demo da corretora | sim, endpoint de demo separado |
| Autenticação | login numérico, senha e servidor, informados ao terminal local | OAuth 2.0 em duas etapas: aplicação + conta |
| Terminal ou serviço intermediário | **sim**: terminal MT5 aberto e logado + serviço Python | não: cliente Protobuf sobre TCP/TLS |
| Opera cripto? | **não** | **não** |
| Fonte oficial | https://www.mql5.com/en/docs/python_metatrader5 | https://help.ctrader.com/open-api/ |

## MetaTrader 5

**Como funciona.** A integração oficial em Python conversa com o **terminal MetaTrader 5 instalado
na máquina**, não com um serviço na nuvem. O fluxo recomendado pela própria documentação é:
conectar, ler dados, checar estado, validar a ordem com `order_check`, enviar com `order_send`,
encerrar. `order_send` devolve a estrutura de resultado da requisição; o detalhe do erro vem de
`last_error`.

**O que falta para habilitar:**

1. Terminal MT5 instalado, logado na conta demo e com negociação algorítmica habilitada.
2. Serviço intermediário em Python usando o pacote oficial `MetaTrader5`, exposto ao backend por
   uma API interna — o backend em Node não fala com o terminal diretamente.
3. Mapear o `clientOrderId` para `magic number` ou comentário da ordem, para reconciliação.
4. Ler o catálogo de símbolos do servidor da corretora em vez de presumir dígitos, lote mínimo e
   tamanho de contrato: esses valores variam por corretora.

**Riscos operacionais.** Terminal fechado, sessão caída ou máquina reiniciada derrubam a
integração inteira. Em produção isso exige supervisão do processo e um portão de "dados
indisponíveis" — que já existe no motor de risco.

## cTrader Open API

**Como funciona.** Protocolo Protobuf sobre TCP com TLS, com endpoints separados para demo e conta
real. A autenticação é OAuth 2.0 em dois níveis: primeiro a **aplicação** se autentica com client
id e secret; depois cada **conta de negociação** é autenticada com o access token do usuário. O
código de autorização tem validade curta e é trocado por um access token; o refresh token permite
renovar sem nova interação.

**O que falta para habilitar:**

1. Registrar a aplicação no portal de desenvolvedores da Spotware e obter aprovação.
2. Cliente Protobuf sobre TCP/TLS, com reconexão e heartbeat.
3. Fluxo de consentimento no navegador para emitir o código de autorização.
4. Armazenamento cifrado do refresh token no backend.

**Vantagem para este produto.** O escopo de leitura de conta e o de negociação são concedidos
separadamente. Dá para conectar primeiro só leitura — saldo, equity e posições — e habilitar envio
de ordens depois, o que casa com a ideia de começar em modo Observação.

## Cripto

### Comparativo

| | Binance | Bybit v5 |
|---|---|---|
| Situação no produto | **não implementado** | **não implementado** |
| Produtos | à vista e futuros (APIs separadas) | à vista e lineares, API unificada v5 |
| Saldo e posições | sim | sim |
| Stop e alvo anexados à ordem | **não no spot**: exige ordem OCO | sim |
| Acompanhamento por chave de cliente | sim | sim |
| Ambiente demonstrativo | sim, testnet com base de usuários própria | sim, testnet com base de usuários própria |
| Autenticação | chave + segredo, assinatura HMAC SHA-256 sobre a query string, chave no cabeçalho `X-MBX-APIKEY` | chave + segredo, HMAC sobre timestamp + chave + janela + corpo, nos cabeçalhos `X-BAPI-*` (há variante RSA) |
| Opera forex? | **não** | **não** |
| Fonte oficial | https://developers.binance.com/docs/binance-spot-api-docs | https://bybit-exchange.github.io/docs/v5/intro |

### O que falta para habilitar (ambos)

1. Conta e chaves **de testnet**, separadas das de produção — as bases de usuário são distintas.
2. Ler os filtros do instrumento (passo de quantidade, passo de preço, nocional mínimo) antes de
   dimensionar a ordem, em vez de presumir.
3. Sincronização de relógio: requisições assinadas usam timestamp e janela de recepção.
4. Armazenamento cifrado do segredo no backend.
5. Em Binance, spot e futuros são APIs distintas, com contas, margem e endpoints separados; o
   adaptador precisa escolher a certa a partir do `ProductType` do instrumento.
6. Emular, no spot, o que em forex vai anexado à ordem: stop e alvo exigem ordem OCO.

### O que o simulador não reproduz

- **Funding periódico** dos perpétuos.
- Liquidez real, rejeições da exchange e gaps de notícia.
- Restrições por jurisdição do usuário, que variam por produto e por exchange.

## Política do produto

- Nenhuma promessa de "conexão universal". O usuário escolhe, **por mercado**, entre conexões
  efetivamente suportadas — e a lista oferecida só mostra as compatíveis com aquele mercado.
- Antes de enviar, o motor valida suporte ao instrumento, quantidade mínima, passo de quantidade e
  valor nocional mínimo.
- Consulta de conta e autorização de negociação são pedidas separadamente quando a plataforma
  permite.
- Credenciais ficam no backend, cifradas em repouso, fora do frontend e fora dos logs.
- Nenhum campo de credencial é preenchido automaticamente. Login, servidor, client id e secret vêm
  da corretora do próprio usuário.
- Antes de qualquer integração real: ler a documentação oficial vigente, validar em conta
  demonstrativa e só então liberar conta real.
