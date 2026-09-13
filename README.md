# Convergência de Sinais

Plataforma que recebe sinais de várias salas e provedores, compara o que é comparável e publica
uma oportunidade quando um número (ou percentual) configurável de fontes independentes concorda.
O diferencial é a rastreabilidade: cada oportunidade mostra quem votou, quem divergiu, quem não
participou e por que a operação foi liberada ou bloqueada.

> **Conta simulada.** O protótipo roda contra um simulador local rotulado `SIMULADA` em toda a
> interface. Nenhuma corretora real está conectada e nenhuma conexão é falsificada. Os preços vêm
> de um passeio aleatório com semente fixa — servem para exercitar o fluxo, não para estimar
> rentabilidade.

## Mercado do MVP

**Forex spot, pares major** (EURUSD, GBPUSD, USDJPY, AUDUSD, USDCHF) — mais um instrumento OTC
proposital (`EURUSD-OTC`) para demonstrar que o motor nunca compara OTC com mercado regular.

Motivo da escolha: preço contínuo, stop loss e take profit nativos, dimensionamento por risco em
pips, conta demo oficial nas plataformas relevantes e APIs documentadas. Binárias, cripto e ações
têm regras de execução diferentes e ficam fora — o modelo de dados já separa mercado e ambiente
para permitir a extensão depois, sem misturar.

## Como executar

Requisitos: Node.js 20 ou superior.

```bash
npm install
```

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
| Home | Situação da conta, limites do dia, oportunidades ativas, posições abertas, histórico de decisões |
| Fontes | Cadastro, ativação, agrupamento por independência, peso, gerador, webhook, entrada manual, sinais recebidos |
| Convergências | Todos os agrupamentos avaliados agora, inclusive os que **não** passaram — com o motivo |
| Operações | Ordens, posições, histórico com bruto/custos/líquido, registro completo de decisões |
| Corretoras | Conta ativa e comparativo das integrações, com o que falta para habilitar cada uma |
| Configurações | Todo parâmetro com sugestão, explicação, efeito, dependências e botão de restaurar; estado do banco e reinício do ambiente |

A interface tem tema claro, escuro e "sistema". A escolha fica no navegador do usuário — não vai
para o backend nem para o banco.

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
server/src/sources/     gerador de sinais do protótipo
server/src/engine/      orquestrador: ingestão → convergência → risco → execução → registro
server/src/http.ts      API REST + fluxo de eventos (SSE)
web/src/                interface React, pt-BR
```

O fluxo completo está implementado ponta a ponta:
receber sinal → validar → comparar → publicar oportunidade → verificar regras → executar na conta
simulada → registrar resultado.

Detalhes em [docs/ARQUITETURA.md](docs/ARQUITETURA.md),
[docs/CORRETORAS.md](docs/CORRETORAS.md) e [docs/CENARIOS.md](docs/CENARIOS.md).

## Como ler o percentual de concordância

O denominador são os **grupos de independência** com sinal válido e comparável dentro da janela.
"3 de 4 fontes participantes — 75% de concordância" descreve quantas fontes disseram a mesma
coisa. **Não é probabilidade de ganho.** Fontes cadastradas que não participaram aparecem sempre,
com o motivo.

Uma fonte vale no máximo um voto vigente. Salas que compartilham origem (espelhos, revendas)
recebem o mesmo grupo de independência e contam uma vez só — nomes diferentes não provam origens
diferentes.

## Parâmetros iniciais da demonstração

Conta simulada · modo Observação · 3 fontes concordantes **e** 75% de concordância (ambos os
critérios) · pesos iguais · 1 operação aberta por vez · 1 execução por oportunidade · martingale
desativado · bloqueio de novas entradas ao atingir limite diário.

São pontos de partida para simulação, **não** parâmetros validados com dados. Cada campo em
Configurações declara a base da sugestão.

## Próximos passos

Ver a seção final de [ESTADO_DO_PROJETO.md](ESTADO_DO_PROJETO.md).
