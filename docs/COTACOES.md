# Cotações de mercado

Cada mercado tem **sua própria fonte de preço**, e elas nunca se cruzam:

| Mercado | Fonte | Tipo de preço | Credencial |
|---|---|---|---|
| Forex | AwesomeAPI | referência, REST a cada 60 s | `AWESOMEAPI_KEY` |
| Cripto | **Binance · Spot** | público, stream em tempo real + REST | nenhuma |

## Forex — AwesomeAPI

A seção **Forex** exibe cotações reais de referência da AwesomeAPI.

> **O que esta integração é:** preço de referência de mercado, para exibição e conferência.
> **O que ela não é:** preço executável de corretora. Não há saldo, não há envio de ordem, e ela
> sozinha não habilita operação real. A futura conexão de execução continua tendo de validar preço e
> condições por conta própria.

## Configuração

A chave é lida **exclusivamente no backend**, pela variável `AWESOMEAPI_KEY`. Ela nunca vai para o
frontend, para a URL, para a resposta das rotas nem para o log — o servidor registra apenas se a
integração está configurada ou não.

```bash
cp .env.example .env
```

Preencha `AWESOMEAPI_KEY=` com a sua chave e reinicie o backend. Sem a variável, a interface mostra
**"Integração não configurada"** com o passo a passo, e o resto do sistema continua funcionando.

| Variável | Padrão | Para que serve |
|---|---|---|
| `AWESOMEAPI_KEY` | vazio | Credencial. Sem ela, nenhuma chamada externa é feita |
| `QUOTES_REFRESH_SECONDS` | `60` | Intervalo entre consultas |
| `PORT` | `8787` | Porta do backend |

`.env` e `.env.*` estão no `.gitignore`; só `.env.example` é versionado.

## Consulta

`GET https://economia.awesomeapi.com.br/json/last/{pares}`, com a chave no cabeçalho `x-api-key`.
Todos os pares vão em **uma única chamada**, separados por vírgula.

| Instrumento do projeto | Par no provedor | Situação |
|---|---|---|
| EURUSD | `EUR-USD` | suportado |
| GBPUSD | `GBP-USD` | suportado |
| USDJPY | `USD-JPY` | suportado |
| AUDUSD | `AUD-USD` | suportado |
| USDCHF | `USD-CHF` | suportado |
| EURUSD-OTC | — | **sem cobertura** |
| BTCUSDT, ETHUSDT, SOLUSDT, perpétuos | — | fora do escopo desta etapa |

`EURUSD-OTC` é um instrumento sintético deste projeto, criado para demonstrar que OTC não se mistura
com mercado regular. Ele aparece na interface como "sem cobertura" e **não recebe substituto**:
cotação de turismo e PTAX não são equivalentes a forex, e inventar preço para par indisponível está
fora de questão.

A lista de pares suportados foi conferida em `https://economia.awesomeapi.com.br/json/available`
(540 pares na consulta feita).

## Consumo

Uma chamada por minuto equivale a **43.200 requisições em 30 dias contínuos**, dentro das 100 mil
mensais do plano gratuito com chave. A interface mostra a projeção e o total desta execução.

Para reduzir o consumo, aumente `QUOTES_REFRESH_SECONDS` — 300 s caem para 8.640 requisições/mês.

**Nenhum componente da interface dispara consulta externa.** Existe um único serviço no processo, com
cache compartilhado por todas as telas, abas e usuários; o instantâneo já viaja pelo fluxo de eventos
(SSE) que a interface consome. Chamadas concorrentes compartilham a mesma requisição em voo, então
três abas abertas continuam gerando uma chamada.

## Tratamento de falhas

| Situação | Resposta do provedor | O que o sistema faz |
|---|---|---|
| Chave ausente | — | Estado "não configurada". Zero chamadas externas |
| Chave inválida | **HTTP 403** | `AUTENTICACAO`, com instrução de conferir a variável |
| Limite excedido | HTTP 429 | `LIMITE_EXCEDIDO`, respeitando o `Retry-After` quando enviado |
| Par inexistente | HTTP 404 `CoinNotExists` | Isola o par citado e repete **uma vez** sem ele; o par vira "sem cobertura" |
| Sem resposta | — | `TIMEOUT` após 10 s |
| Provedor fora do ar | 5xx | `PROVEDOR_INDISPONIVEL` |

Falhas consecutivas aumentam o intervalo entre tentativas (recuo exponencial, teto de 15 min). Não há
repetição ilimitada: a busca por par inválido tenta no máximo duas vezes por ciclo.

Em falha, **a última cotação conhecida continua na tela, marcada como desatualizada**. Nunca é
substituída por valor simulado ou aleatório apresentado como real.

## Dados normalizados

O provedor entrega **todos os campos como texto**. O serviço converte e separa o que não pode ser
confundido:

- `bid`, `ask`, `high`, `low`, `varBid`, `pctChange` → número, ou `null` quando ilegível.
- `quotedAt` — **horário da negociação**, convertido do `timestamp` Unix do provedor.
- `quotedAtProviderLocal` — o `create_date` do provedor (UTC−3), preservado como veio.
- `fetchedAt` — **horário em que este sistema recebeu a resposta**. Nunca confundido com o de cima.

## Regra de desatualização

Considera o intervalo de consulta **e o horário de mercado**:

- Forex à vista não negocia no fim de semana. A janela usada é domingo 21:00 UTC a sexta 21:00 UTC,
  uma aproximação declarada que ignora horário de verão.
- **Mercado fechado:** a cotação de fechamento da sexta é o preço correto, não um dado quebrado — o
  estado é "mercado fechado", sem alerta de falha.
- **Mercado aberto:** passando de `staleAfterSeconds` (padrão `max(15 min, 10× o intervalo)`) sem
  preço novo, a cotação é marcada como desatualizada.
- **Carência de 60 min após a abertura de domingo.** Medido contra o provedor real: na retomada
  semanal os pares voltam em cadência própria, e um major pode seguir no fechamento de sexta por
  dezenas de minutos. Sem a carência, a abertura marcaria preço correto como desatualizado.

O limiar é generoso de propósito: ele existe para detectar **provedor parado**, não par quieto. Cada
par tem cadência própria — numa medição real às 21:34 UTC de domingo, AUDUSD, GBPUSD, USDJPY e USDCHF
vieram com segundos de idade enquanto EURUSD ainda estava no fechamento da sexta.

Uma consulta bem-sucedida **não garante preço novo**: o provedor devolve a última negociação
conhecida, e isso está dito na própria tela.

## Efeito no resto do sistema

Dois pontos usam o preço de referência quando ele existe:

1. **Plausibilidade do sinal.** A checagem de 20% passa a comparar com o preço de referência em vez
   do valor inicial do catálogo, que é arbitrário e envelhece.
2. **Âncora do preço simulado.** A cada atualização, o preço do simulador de Forex é realinhado ao
   nível da referência — para a conta de demonstração não operar a 1,0850 enquanto o mercado está a
   1,1596. **A âncora é recusada quando há posição aberta no instrumento**, porque um salto de preço
   com posição viva dispararia stop ou alvo por um motivo que não é movimento de mercado. Entre
   atualizações o preço continua sendo um passeio aleatório, e a interface separa as duas coisas em
   cartões distintos: "Cotação de referência" e "Preço da conta simulada".

   O realinhamento vira evento de auditoria **uma vez por símbolo e só quando o deslocamento passa de
   0,1%** — o salto do preço inicial do catálogo para o preço de mercado é notícia; um ajuste de
   fração de pip a cada minuto, não.

## Rotas internas

| Rota | O que faz |
|---|---|
| `GET /api/quotes/forex` | Estado e cotações normalizadas. Nunca devolve a credencial |
| `POST /api/quotes/forex/refresh` | Força uma consulta agora, respeitando a trava de concorrência |

As cotações também chegam no instantâneo em `markets.FOREX.referenceQuotes`, que é o caminho normal
usado pela interface.


---

# Cripto — Binance Spot

A seção **Cripto** exibe preço público do **mercado à vista** da Binance. Sem chave de API, sem
programa intermediário, sem acesso a conta.

> **O que esta integração é:** preço público de mercado à vista, para exibição e conferência.
> **O que ela não é:** acesso a conta, saldo ou envio de ordem. Preço público não é autorização para
> negociar e não garante o preço de execução.

## Endpoints

| Uso | Endpoint |
|---|---|
| Validação de pares e regras | `GET /api/v3/exchangeInfo` |
| Melhor bid/ask (carga e recuperação) | `GET /api/v3/ticker/bookTicker` |
| Estatísticas de 24 h | `GET /api/v3/ticker/24hr` |
| Último preço | `GET /api/v3/ticker/price` |
| Candles | `GET /api/v3/klines` |
| Atualização contínua | `wss://data-stream.binance.vision:443/stream?streams=...` |

Base REST: `https://data-api.binance.vision` (endpoint somente de dados de mercado).

**Streams usados**, um par de cada por símbolo: `<par>@bookTicker` (melhor compra e venda) e
`<par>@trade` (último negócio, com horário). Todos em **uma única conexão combinada**.

## Pares

Padrão: **BTCUSDT, ETHUSDT, SOLUSDT** — confirmados em `exchangeInfo` com `status: TRADING` e
`isSpotTradingAllowed: true` antes de qualquer uso. Tick, passo de quantidade e nocional mínimo são
**lidos do provedor**, nunca presumidos.

Outros pares podem ser escolhidos na própria tela; cada um passa pela mesma validação e é recusado
com o motivo quando o provedor não confirma.

**Incompatíveis com esta integração:** `BTCUSDT-PERP` e `ETHUSDT-PERP`. São contratos perpétuos, e
esta etapa cobre apenas o mercado à vista — um sinal de futuros **nunca** é lido como à vista. Eles
aparecem listados como incompatíveis, com o motivo, em vez de receber um preço à vista emprestado.

## Conexão

Uma conexão por processo, compartilhada por todas as telas. **Nenhum componente da interface abre
conexão externa**: as atualizações chegam pelo fluxo de eventos do próprio backend.

- **Keepalive:** o protocolo WebSocket responde `ping` com `pong` automaticamente na implementação
  nativa do Node, então não há pong manual a enviar.
- **Cão de guarda por ausência de dados:** sem nenhuma mensagem dentro da janela (30 s por padrão), a
  conexão é considerada morta e refeita. Isso cobre o caso de conexão aberta porém silenciosa, que um
  ping sozinho não detecta.
- **Renovação preventiva** a cada 12 h, bem antes do limite de vida do provedor.
- **Reconexão** com recuo exponencial e ruído, teto de 60 s.
- **Recuperação por REST:** ao perder o stream, o REST assume até a conexão voltar.

## Dados

Três preços **distintos**, nunca colapsados em um só:

- **Último negócio** — do stream `@trade`. Tem horário do provedor (`T`, horário do negócio).
- **Melhor compra / melhor venda** — do stream `@bookTicker`. **Este stream não envia horário**, só
  um identificador de atualização; registramos apenas o momento do recebimento e deixamos o campo de
  horário do evento como `null`. Nenhum timestamp é inventado.
- **Estatísticas de 24 h** — do REST, com o `closeTime` informado pelo provedor.

Precisão preservada: as casas decimais exibidas vêm do `tickSize` do próprio par.

A moeda de cotação fica sempre visível (`BTC/USDT`), com exchange e tipo de mercado ao lado
(`Binance · Spot · BTCUSDT`). **USDT nunca é apresentado como USD.**

> Nota de modelagem: a conta simulada compartilhada é denominada em USD, e o total consolidado
> declara a paridade USDT = 1,00 USD. Isso é a conta, não a cotação — o preço de mercado continua
> sendo exibido em USDT. Para separar de vez, escolha a conta `paper-crypto` (USDT) na tela Conexões.

## Estados e falhas

| Estado | Quando |
|---|---|
| `CARREGANDO` | antes da primeira carga |
| `OK` | stream aberto e dados recentes |
| `RECONECTANDO` | conexão caiu ou está sendo refeita; último preço permanece na tela |
| `DESATUALIZADA` | sem dado novo além da janela (90 s por padrão) |
| `INDISPONIVEL` | provedor fora do ar e nenhum preço em cache |

Cripto negocia 24 horas por dia, então silêncio prolongado indica falha de conexão — diferente de
Forex, onde o fim de semana é fechamento legítimo.

Em falha, **o último preço conhecido continua na tela, marcado como desatualizado**. Nunca é
substituído por valor simulado.

## Rotas internas

| Rota | O que faz |
|---|---|
| `GET /api/quotes/crypto` | Estado e cotações normalizadas |
| `POST /api/quotes/crypto/refresh` | Recarga por REST |
| `POST /api/quotes/crypto/symbols` | Troca os pares, validando em `exchangeInfo` |
| `GET /api/quotes/crypto/klines` | Candles de um par acompanhado |

Também chegam no instantâneo em `markets.CRYPTO.cryptoQuotes`.

## Unidade de distância (pip) em cripto

Cripto não tem pip. A convenção do projeto é **1 pip = 0,01% do preço**, e com preço real isso passou
a ser calculado sobre o **preço corrente**, não sobre o valor inicial do catálogo. Sem isso, "150
pips" derivado de um catálogo desatualizado significaria outra distância relativa assim que o mercado
andasse — com SOL saindo de 172 para cerca de 100, o erro passaria de 70%.

`pipSizeFor(instrumento, preço)` resolve isso: forex mantém o valor fixo da convenção, cripto
acompanha o preço.
