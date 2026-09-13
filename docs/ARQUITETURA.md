# Arquitetura

## Separação de camadas

```
 conectores        ingestão          convergência        risco            execução        registro
 ──────────       ──────────        ─────────────       ───────          ──────────      ──────────
 gerador     ──►  normaliza    ──►  agrupa por     ──►  portões    ──►   adaptador  ──►  eventos de
 webhook          valida            instrumento         de risco         de                auditoria
 manual           deduplica         + ambiente          +                corretora         + histórico
 (futuro:         versiona          1 voto por          dimensiona                         de posições
  Telegram,       expira            grupo de            o volume
  API)                              independência
```

Cada camada só conhece a anterior por tipos de dados. `server/src/core/` não faz I/O, não lê
relógio do sistema direto (recebe um `Clock`) e não depende de Express — por isso é testável
isoladamente e pode ser reutilizada em outro runtime.

## Decisões de modelagem

### Sinal

O sinal preserva a mensagem original intacta (`raw.text`, `raw.payload`) e normaliza o que
estiver disponível. Campos ausentes ficam `null` — o sistema não inventa preço, stop nem horário.

Estados: `VALID`, `INCOMPLETE`, `AMBIGUOUS`, `EXPIRED`, `CANCELLED`, `SUPERSEDED`, `DUPLICATE`,
`REJECTED`. Só `VALID` vota.

### Interpretação de texto livre

Qualquer interpretação probabilística (parser de regex ou, no futuro, modelo de linguagem) produz
apenas um **rascunho** com uma confiança. O rascunho passa por `validateSignal`, que é
determinístico: mesmas entradas, mesmo resultado, sem aleatoriedade e sem dependência de
configuração do usuário. Confiança abaixo de `MIN_PARSER_CONFIDENCE` (0,75) marca o sinal como
`AMBIGUOUS`, e sinal ambíguo nunca vota nem gera ordem.

Validações determinísticas aplicadas: instrumento no catálogo, ambiente coerente com o cadastro,
direção presente, preço plausível frente à referência do instrumento, stop e alvo do lado correto
da entrada, validade não vencida, emissão não futura, atraso de entrega sinalizado.

### Duplicatas, edições e cancelamentos

- **Mesmo `externalMessageId` + mesmo conteúdo** → duplicata, sem voto novo.
- **Mesmo `externalMessageId` + conteúdo diferente** → edição: nova versão, a anterior vira
  `SUPERSEDED` e para de votar.
- **`action: "CANCEL"` com `externalMessageId`** → o sinal alvo vira `CANCELLED` e sai do
  agrupamento.
- **Sem `externalMessageId`** → duplicata é detectada por impressão digital do conteúdo dentro de
  30 minutos. Com identificadores distintos, as mensagens são tratadas como distintas — o colapso
  para um voto por fonte já acontece no motor de convergência.

### Convergência

1. Filtra sinais `VALID`, de fontes ativas, dentro da idade máxima e da lista de inclusão/exclusão.
2. Agrupa por `mercado | instrumento | ambiente`. **OTC e regular nunca entram no mesmo balde.**
3. Reduz a **um voto vigente por grupo de independência** — o mais recente vence; o anterior vira
   não participante com o motivo explícito.
4. Ancora a janela no sinal mais recente e descarta o que estiver fora dela.
5. Escolhe a direção candidata pela soma de votos (ou de pesos, se ligado).
6. Calcula o preço de referência pela **mediana** das entradas concordantes.
7. Move para "não comparáveis" quem estiver fora da tolerância de preço em pips ou com horizonte
   fora da razão configurada.
8. **Denominador** = grupos de independência com sinal válido e comparável na janela. A política
   de contrários decide se o divergente entra no denominador, é ignorado ou bloqueia a
   convergência.
9. Fontes cadastradas e ativas que não participaram são listadas com o motivo.

A saída é uma avaliação por agrupamento — inclusive as que **não** passaram no corte, que
alimentam a tela Convergências.

### Identidade da oportunidade

`clusterKey = FX_SPOT|SÍMBOLO|AMBIENTE|DIREÇÃO`.

Enquanto uma oportunidade está dentro da validade, novas concordâncias a **atualizam** (versão +1)
em vez de criar outra. Passada a validade, uma nova concordância é outra oportunidade, com
identificador próprio. O limite `maxExecutionsPerOpportunity` (padrão 1) garante que atualização
não vira entrada involuntária.

### Risco

`evaluateRisk` avalia **todos** os portões, mesmo depois do primeiro bloqueio, para que a
interface mostre a lista completa em vez do primeiro motivo. Ordem: modo e pausa, conexão e
frescor da cotação, validade da oportunidade, idempotência, limites do dia, pausa por perdas,
intervalo entre entradas, posições abertas, janela de horário, spread, desvio de preço,
dimensionamento, exposição por ativo, exposição total, margem livre.

Nenhum modo operacional pula esses portões. "Executar sempre que convergir" dispensa a confirmação
manual, não os limites.

### Valor da ordem × valor arriscado

- **Nocional**: lotes × tamanho do contrato × preço. É o tamanho da posição.
- **Arriscado**: distância até o stop, em pips, × valor do pip × lotes. É o quanto se perde se o
  stop for atingido no preço configurado.

Os dois aparecem separados na interface. Stops não garantem preço exato de execução: gaps e
deslizamento podem ultrapassá-los.

### Resultado diário

- **Base do dia** = patrimônio na abertura do dia operacional, no fuso configurado.
- **Base dos limites** = apenas o resultado **realizado** (posições fechadas, já com custos).
- Posições abertas aparecem à parte e **não** disparam os limites.
- Depósitos e saques entram no saldo e ficam fora do resultado operacional.

Ao atingir um limite, novas entradas são bloqueadas até a virada do dia. Cancelar ordens pendentes
e encerrar posições abertas são configurações **separadas**.

### Execução e idempotência

`clientOrderId = opp-<idDaOportunidade>-v<tentativa>`, determinístico. Antes de enviar, o
orquestrador consulta a corretora por essa chave; se já houver execução, não reenvia. Se a
requisição expirar sem resposta, ele **consulta o estado antes de qualquer reenvio** e reconcilia.
Uma trava em memória impede que duas passagens do pipeline entrem no mesmo envio.

## Contrato de corretora

`BrokerAdapter` define conta, cotação, envio, busca por chave de cliente, posições, encerramento e
cancelamento de pendentes. O `PaperBroker` implementa tudo localmente. MetaTrader 5 e cTrader
aparecem no catálogo com `status: NOT_IMPLEMENTED` e a lista do que falta.

Credenciais ficam no backend, fora do frontend e fora dos logs. Nenhum `describe()` devolve
segredo.

## Transporte

REST para comandos e leitura de estado; `GET /api/stream` (SSE) para avisar a interface de que o
estado mudou — a interface então recarrega o instantâneo. Simples de entender e suficiente para o
protótipo; substituível por WebSocket com diffs quando o volume justificar.

## Persistência

SQLite pelo módulo nativo `node:sqlite` — sem dependência para compilar, o que evita exigir
ferramentas de build no Windows. Arquivo padrão: `server/data/app.db`, ancorado no próprio módulo
para que `npm run dev` na raiz e `npm start` dentro de `server/` abram o mesmo banco. `DB_PATH`
sobrescreve.

**Formato das tabelas.** Colunas indexáveis para o que se consulta — data, situação, instrumento,
chave de cliente — mais uma coluna `data` com o registro completo em JSON. É um meio termo
deliberado: o modelo de domínio evolui sem migração a cada campo novo, e relatórios por SQL
continuam possíveis. O esquema tem versão; um banco mais novo que o código é recusado na abertura
em vez de ser lido pela metade.

**O que é gravado por linha:** fontes, sinais, oportunidades, ordens, posições e eventos de
auditoria — no momento da mudança.

**O que é gravado em chave e valor:** modo operacional, pausa da automação, configurações de
convergência e de risco, estado do dia e estado do simulador (saldo, posições abertas, mapa de
chaves de cliente, preços e semente do passeio aleatório). Essas gravações são agrupadas e
limitadas a uma a cada 5 segundos, com gravação forçada em toda mudança de controle, execução de
ordem, fechamento de posição e no encerramento do processo.

**Na volta.** `Engine.hydrate()` carrega tudo. Duas garantias importantes:

1. Oportunidade que venceu enquanto o processo estava fora do ar volta como `EXPIRED`, nunca
   elegível — o preço andou sem supervisão.
2. O mapa de chaves de cliente do simulador volta junto, então a idempotência de ordem atravessa o
   reinício: uma ordem já executada continua sendo reconhecida como já executada.

Banco vazio faz o servidor semear o ambiente de demonstração. `POST /api/db/reset` (com
`{"confirm":"APAGAR"}`) apaga tudo e semeia de novo; a interface pede confirmação em dois passos.
Eventos e sinais têm retenção de 5.000 registros, aplicada na entrada e na saída do processo.

## Tema da interface

Três estados: claro, escuro e sistema. Escolha explícita marca `data-theme` na raiz e vence a
media query nos dois sentidos; "sistema" não marca nada e deixa `prefers-color-scheme` decidir. A
preferência fica em `localStorage`, com leitura protegida por `try/catch` — navegador anônimo ou
armazenamento bloqueado cai no padrão. Um script mínimo no `index.html` aplica o tema antes da
primeira pintura, para a página não piscar clara.

Toda cor sai de token. Texto sobre fundo sólido usa `--on-ink` e `--on-accent`, que invertem junto
com o tema; bordas de distintivo derivam da própria cor do estado por `color-mix`, em vez de lista
fixa. A gramática de cor é a mesma nos dois temas: estado de decisão primeiro, direção em azul e
laranja, verde e vermelho só para dinheiro.

## Limitações conhecidas do protótipo

- Sem autenticação nem multiusuário.
- Preço simulado não reproduz liquidez, gaps de notícia nem rejeições reais.
- Conectores de Telegram, Discord e APIs de terceiros existem apenas como tipo de cadastro.
