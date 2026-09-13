# Integrações com corretoras

Mercado do MVP: **forex spot**. As duas plataformas abaixo são as rotas realistas para uma conta
demonstrativa nesse mercado. Nenhuma está implementada — o protótipo opera contra um simulador
local. O que segue vem da documentação oficial de cada plataforma, consultada em setembro de 2026.

## Comparativo

| | Simulador local | MetaTrader 5 | cTrader Open API |
|---|---|---|---|
| Situação no produto | implementado | **não implementado** | **não implementado** |
| Saldo, equity e margem | sim | sim | sim |
| Posições abertas | sim | sim | sim |
| Envio de ordem a mercado | sim | sim | sim |
| Cancelamento de pendentes | não se aplica | sim | sim |
| Stop e alvo anexados à ordem | sim | sim | sim |
| Acompanhamento por chave de cliente | sim | via `magic number` / comentário da ordem | via identificador da ordem |
| Ambiente demonstrativo | sim | sim, conta demo da corretora | sim, endpoint de demo separado |
| Autenticação | nenhuma | login numérico, senha e servidor, informados ao terminal local | OAuth 2.0 em duas etapas: aplicação + conta |
| Terminal ou serviço intermediário | não | **sim**: terminal MT5 aberto e logado + serviço Python | não: cliente Protobuf sobre TCP/TLS |
| Restrições relevantes | preços sintéticos | corretora precisa oferecer MT5 e permitir automação; pacote oficial distribuído para Windows | corretora precisa oferecer cTrader; aplicação passa por registro e aprovação |
| Fonte oficial | — | https://www.mql5.com/en/docs/python_metatrader5 | https://help.ctrader.com/open-api/ |

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

## Política do produto

- Nenhuma promessa de "conexão universal". O usuário escolhe entre corretoras efetivamente
  suportadas.
- Consulta de conta e autorização de negociação são pedidas separadamente quando a plataforma
  permite.
- Credenciais ficam no backend, cifradas em repouso, fora do frontend e fora dos logs.
- Nenhum campo de credencial é preenchido automaticamente. Login, servidor, client id e secret vêm
  da corretora do próprio usuário.
- Antes de qualquer integração real: ler a documentação oficial vigente, validar em conta
  demonstrativa e só então liberar conta real.
