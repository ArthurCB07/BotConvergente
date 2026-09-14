# Convergência de Sinais

Plataforma que recebe sinais de várias salas e provedores, compara o que é comparável e publica
uma oportunidade quando um número (ou percentual) configurável de fontes independentes concorda.
O diferencial é a rastreabilidade: cada oportunidade mostra quem votou, quem divergiu, quem não
participou e por que a operação foi liberada ou bloqueada.

> **Preços reais nos dois mercados.** Forex usa a **AwesomeAPI** (cotação de referência, requer
> `AWESOMEAPI_KEY`); Cripto usa a **Binance · Spot** (dados públicos, stream em tempo real, sem
> chave). São preços para exibição e conferência — não são preço executável, não conectam saldo e não
> enviam ordem. Detalhes em [docs/COTACOES.md](docs/COTACOES.md).

> **Salas do Telegram, pela sua própria conta.** A integração MTProto conecta a sua conta e lê as
> salas que você já acompanha — sem bot adicionado pelos administradores e sem Telegram Desktop
> aberto. Requer `TELEGRAM_API_ID` e `TELEGRAM_API_HASH` no backend; a conexão é feita no painel, na
> aba Fontes. Ela **lê** as salas selecionadas: nunca entra em salas nem envia mensagem. Detalhes em
> [docs/TELEGRAM.md](docs/TELEGRAM.md).

> **Conta simulada.** O protótipo roda contra um simulador local rotulado `SIMULADA` em toda a
> interface. Nenhuma corretora real está conectada e nenhuma conexão é falsificada. Os preços vêm
> de um passeio aleatório com semente fixa — servem para exercitar o fluxo, não para estimar
> rentabilidade.

## Dois mercados, separados de verdade

A plataforma opera **Forex** e **Cripto** como mercados independentes. Separados em tudo: fontes,
convergência, configurações, automação, limites diários e conta. Um sinal de um mercado **nunca**
entra na contagem, no percentual nem no peso do outro.

| | Forex | Cripto |
|---|---|---|
| Instrumentos | EURUSD, GBPUSD, USDJPY, AUDUSD, USDCHF, EURUSD-OTC | BTCUSDT, ETHUSDT, SOLUSDT (à vista), BTCUSDT-PERP, ETHUSDT-PERP |
| Produtos | `FX_SPOT` | `CRYPTO_SPOT` e `CRYPTO_PERP` — nunca comparados entre si |
| Funcionamento | seg a sex, janela configurável | 24 horas, 7 dias |
| Alavancagem simulada | 1:30 | 1:1 à vista, 1:5 perpétuo |
| Unidade da ordem | lote | unidade do ativo (BTC, ETH, SOL) ou contrato |

Dentro de cada mercado o `ProductType` decide o que é comparável. BTCUSDT à vista e BTCUSDT-PERP
são o mesmo par e **produtos diferentes**: nunca somam votos. O mesmo vale para OTC contra mercado
regular em Forex.

### Duas unidades de preço

- `tickSize` — menor incremento de preço, usado para **arredondar**.
- `pipSize` — unidade de **distância** para stops, alvos e tolerâncias.

Em forex o pip é a convenção de mercado (0,0001 nos majors). Em cripto não existe pip, então
1 pip = **0,01% do preço de referência** do instrumento. Assim "20 pips" significa a mesma distância
relativa em BTC e em SOL, e o mesmo motor de risco serve os dois mercados sem número mágico por
ativo.

## Como executar

Requisitos: Node.js 20 ou superior.

```bash
npm install
```

```bash
cp .env.example .env
```

Preencha `AWESOMEAPI_KEY` no `.env` para habilitar a cotação de referência de Forex. Sem a chave, a
interface mostra "Integração não configurada" e todo o resto continua funcionando.

```bash
npm run dev
```

- Backend: http://localhost:8787
- Interface: http://localhost:5173

O estado fica gravado em `server/data/app.db` (SQLite). Reiniciar o backend retoma de onde parou.

Outros comandos:

```bash
npm test
```

```bash
npm -w server run typecheck
```

Apagar o banco e recomeçar do ambiente de demonstração:

```bash
npm run db:reset
```

Para usar outro arquivo de banco, defina `DB_PATH` antes de subir o backend.

## Telas

| Tela | O que resolve |
|---|---|
| Home | Conta do mercado, limites do mercado **e** limites globais, oportunidades ativas, posições abertas, histórico |
| Fontes | Cadastro com **mercados por fonte**, agrupamento por independência, peso por mercado, gerador, webhook, entrada manual |
| Convergências | Todos os agrupamentos do mercado avaliados agora, inclusive os que **não** passaram — com o motivo e a regra do denominador |
| Operações | Ordens, posições e histórico do mercado, cada registro com mercado, conta e oportunidade de origem |
| Conexões | Conta usada por mercado, saldos por conta, consolidação com moeda e conversão declaradas, comparativo das integrações |
| Configurações | Todo parâmetro por mercado + limites globais, cada um com sugestão, explicação, efeito e botão de restaurar |

Em **todas** as abas há um seletor **Forex | Cripto** no topo. Ele define o que aparece e fica
guardado ao navegar entre abas e ao recarregar a página. Cada mercado tem seus próprios dados e seus
próprios estados vazios; oportunidades, ordens e posições carregam a etiqueta do mercado.

A interface tem tema claro, escuro e "sistema". A escolha e o mercado selecionado ficam no navegador
do usuário — não vão para o backend nem para o banco.

## Automação e limites

Três controles, independentes:

- **Automação Forex** — liga/desliga só o envio automático de Forex.
- **Automação Cripto** — liga/desliga só o envio automático de Cripto.
- **Pausar tudo** — pausa global, bloqueia novas entradas automáticas nos dois.

As quatro combinações funcionam. Desligar a automação de um mercado **não** encerra posições nem
remove stop e alvo: o mercado continua recebendo sinais, publicando oportunidades e gerindo o que já
está aberto. Confirmação manual no modo semiautomático continua disponível — automação desligada
trava o automático, não o operador.

**Limites individuais** bloqueiam apenas o mercado correspondente. **Limites globais** (posições,
exposição, stop diário, stop win) somam os dois e bloqueiam ambos — nenhum mercado pode ignorá-los.
Quando os dois mercados usam a **mesma conta**, a margem é reservada de forma coordenada antes de
cada envio, para que duas ordens simultâneas não comprometam o mesmo saldo. Com contas diferentes,
os saldos aparecem separados e todo total consolidado declara a moeda de referência e a conversão
usada.

## Arquitetura

```
server/src/core/        núcleo puro, sem I/O — testável isoladamente
  types.ts              modelo de domínio
  instruments.ts        catálogo de instrumentos, pips, margem, nocional
  ingestion.ts          normalização, validação determinista, duplicata/edição/cancelamento
  convergence.ts        motor de convergência
  risk.ts               portões de risco e dimensionamento
  settings.ts           padrões e descritores de cada parâmetro
server/src/brokers/     contrato de corretora + simulador + catálogo de integrações
server/src/infra/       persistência em SQLite (node:sqlite, sem dependência nativa)
server/src/quotes/      preços externos: AwesomeAPI (Forex) e Binance Spot (Cripto), com cache,
                        agendamento, stream e reconexão
server/src/sources/     gerador de sinais do protótipo
server/src/engine/      orquestrador: ingestão → convergência → risco → execução → registro
server/src/telegram/     integração MTProto: autenticação, salas, leitura e atividade
server/src/http.ts      API REST + fluxo de eventos (SSE)
web/src/                interface React, pt-BR
```

O fluxo completo está implementado ponta a ponta:
receber sinal → validar → comparar → publicar oportunidade → verificar regras → executar na conta
simulada → registrar resultado.

Detalhes em [docs/ARQUITETURA.md](docs/ARQUITETURA.md), [docs/COTACOES.md](docs/COTACOES.md),
[docs/TELEGRAM.md](docs/TELEGRAM.md), [docs/CORRETORAS.md](docs/CORRETORAS.md) e
[docs/CENARIOS.md](docs/CENARIOS.md).

## Como ler o percentual de concordância

O denominador são os **grupos de independência** com sinal válido e comparável dentro da janela.
"3 de 4 fontes participantes — 75% de concordância" descreve quantas fontes disseram a mesma
coisa. **Não é probabilidade de ganho.** Fontes cadastradas que não participaram aparecem sempre,
com o motivo.

Uma fonte vale no máximo um voto vigente. Salas que compartilham origem (espelhos, revendas)
recebem o mesmo grupo de independência e contam uma vez só — nomes diferentes não provam origens
diferentes.

## Parâmetros iniciais da demonstração

Contas simuladas · os dois mercados em Observação, automação desligada · 3 fontes concordantes **e**
75% de concordância · pesos iguais · 1 operação aberta por mercado · 1 execução por oportunidade ·
martingale desativado · bloqueio ao atingir limite diário.

Forex e Cripto têm padrões **diferentes** de propósito, e nada é copiado de um para o outro. Onde
divergem, o motivo está declarado no campo — volatilidade típica, horário de funcionamento ou
alavancagem. Exemplos: janela de 15 min em Forex e 10 min em Cripto; tolerância de entrada de 8 pips
(0,08%) em Forex e 40 pips (0,40%) em Cripto; stop padrão de 20 pips contra 150 pips.

São pontos de partida para simulação, **não** parâmetros validados com dados. Cada campo em
Configurações declara a base da sugestão.

## Próximos passos

Ver a seção final de [ESTADO_DO_PROJETO.md](ESTADO_DO_PROJETO.md).
