# Estado do projeto

Resumo compacto para retomar o trabalho sem reler o histórico da conversa.
Atualizado em 13/09/2026 (extensão multimercado).

## O que é

Plataforma que agrega sinais de várias salas, detecta convergência entre fontes independentes e
publica oportunidades auditáveis. Modos: Observação, Semiautomático, Autônomo. Diferencial:
mostrar de onde veio cada sinal, por que houve convergência e por que a operação foi executada ou
bloqueada.

## Decisões já tomadas

| Tema | Decisão |
|---|---|
| Mercados | **Forex e Cripto**, separados em fontes, convergência, configuração, automação, limites e conta |
| Produto dentro do mercado | `ProductType` (`FX_SPOT`, `CRYPTO_SPOT`, `CRYPTO_PERP`). À vista e perpétuo nunca somam votos; OTC nunca soma com regular |
| Unidades de preço | `tickSize` arredonda, `pipSize` mede distância. Em cripto, 1 pip = 0,01% do preço de referência |
| Denominador | Configurável por mercado: `COMPARABLE_SIGNALS` (padrão) ou `ENABLED_SOURCES` (silêncio pesa contra). A regra aparece junto do numerador |
| Automação | Uma por mercado + pausa global. Bloqueiam só o envio **automático**; confirmação manual continua valendo |
| Limites | Individuais por mercado + globais (posições, exposição, stop diário, stop win). Global bloqueia os dois |
| Contas | Mapa `accountId` por mercado. `paper` (USD, atende os dois) e `paper-crypto` (USDT, só cripto). Saldo compartilhado usa **reserva de margem síncrona** |
| Conta | Simulada por adaptador local, rotulada `SIMULADA` na interface. Nenhuma conexão real |
| Denominador do percentual | Grupos de independência com sinal válido e comparável na janela |
| Voto | No máximo 1 vigente por grupo de independência. Espelhos são agrupados manualmente |
| Corte padrão | 3 fontes **e** 75%, ambos exigidos, em cada mercado |
| Idempotência | `clientOrderId = opp-<id>-v<tentativa>`, reconciliação antes de qualquer reenvio |
| Limites diários | Base = patrimônio na abertura do dia; contam só posições fechadas; depósitos e saques à parte |
| IA na leitura de mensagens | Produz rascunho com confiança; validação determinista decide. Confiança < 0,75 → `AMBIGUOUS`, não vota |
| Stack | Node + TypeScript + Express (backend), React + Vite (interface), npm workspaces |
| Persistência | SQLite pelo módulo nativo `node:sqlite`, sem dependência nativa. Arquivo em `server/data/app.db` |
| Formato das tabelas | Colunas indexáveis (inclui `market_id`) + coluna `data` em JSON, versão de esquema **3** |
| Tema | Claro, escuro e sistema. Preferência em `localStorage`, fora do backend |
| Cotação Forex | **Real**, AwesomeAPI, via `AWESOMEAPI_KEY` no backend. Referência para exibição; não é preço executável |
| Cotação Cripto | **Real**, Binance Spot por dados públicos (sem chave): streams `@bookTicker` e `@trade`, REST para carga e recuperação. Só à vista; perpétuos ficam marcados como incompatíveis |
| Unidade de pip | `pipSizeFor(instrumento, preço)`. Forex fixo; cripto 0,01% do **preço corrente**, não do catálogo |
| Telegram | MTProto pela **conta do usuário** (`teleproto`), não por bot. `TELEGRAM_API_ID`/`TELEGRAM_API_HASH` só no backend; sessão no banco; código e senha nunca persistidos |
| Sala do Telegram como fonte | Cada sala monitorada vira uma `Source` (`kind: 'TELEGRAM'`, id `src_tg_<peerId>`). Réplicas compartilham `independenceGroupId` e valem um voto |
| Idioma | Interface toda em pt-BR. Código e comentários sem acentuação, para evitar problemas de codificação no Windows |

## O que está pronto

- Núcleo puro em `server/src/core/`: tipos, instrumentos, ingestão, convergência, risco,
  descritores de configuração. Sem I/O, testável isoladamente.
- Motor de convergência completo: agrupamento por instrumento e ambiente, um voto por grupo de
  independência, janela ancorada, tolerância de preço em pips, compatibilidade de horizonte,
  políticas de sinais contrários, pesos, inclusão/exclusão de fontes, lista de não participantes
  com motivo.
- Motor de risco com 16 portões, todos avaliados (não para no primeiro), e dimensionamento por
  lote fixo ou percentual de risco, separando valor nocional de valor arriscado.
- Corretora simulada com preço por passeio aleatório com semente, spread, deslizamento, stop/alvo,
  comissão explícita, idempotência por chave de cliente e injeção de falhas (timeout, rejeição,
  desconexão).
- Orquestrador com auditoria de toda decisão, incluindo as negativas.
- API REST + SSE. Webhook funcional com parser de texto livre.
- Interface pt-BR com 6 telas, atualização ao vivo, e a barra de quórum que torna o denominador
  visível.
- Persistência em SQLite v2, com migração v1→v2 escrita e testada: fontes viram Forex preservando
  dados, `lots` vira `quantity`, `settings.*` vira `settings.*.FOREX`, e registro de mercado incerto
  fica **sem classificação** em vez de ser descartado.
- Separação multimercado ponta a ponta: pipeline por mercado, seletor Forex|Cripto em todas as abas
  (persistido no navegador), etiqueta de mercado em oportunidades, ordens, posições e eventos.
- Reserva de margem síncrona na conta compartilhada, antes de qualquer `await`.
- Tema claro, escuro e "sistema", sem cor fixa fora dos tokens. Cada mercado tem cor de identidade.
- Cotação de referência da AwesomeAPI em Forex: uma chamada por ciclo para todos os pares, cache
  compartilhado no processo, trava de concorrência, recuo exponencial, `Retry-After` respeitado,
  isolamento de par inválido e última cotação preservada quando a consulta falha.
- Integração com o Telegram via MTProto: fluxo de login em três passos com o método de entrega que
  o serviço informou, sessão reaproveitada após reinícios, seleção de salas com busca, configuração
  por sala (mercado, perfil, convergência, grupo de independência), leitura de texto e legenda,
  edições versionadas, recuperação de lacuna por último id lido, detecção de perda de acesso e
  painel de atividade com original × leitura lado a lado. Rotas protegidas por origem local e token
  opcional. **Não validada contra os servidores reais** — depende das credenciais do usuário.
- **154 testes automatizados** (`npm test`), typecheck limpo em backend e frontend.
- 18 cenários de demonstração, incluindo isolamento entre mercados, spot × perpétuo, automação
  independente, execução simultânea e limite global.

## O que NÃO está pronto

- Nenhuma integração real. MT5 e cTrader (Forex), Binance e Bybit (Cripto) estão catalogados com o
  que falta e com as restrições de cada um.
- Funding de perpétuo não é simulado. Ordem OCO (stop+alvo no spot de exchange) não é emulada.
- Cotação de **perpétuos** de cripto: fora do escopo. A integração cobre só o mercado à vista.
- A conta simulada compartilhada é denominada em USD enquanto os pares de cripto são cotados em
  USDT. A cotação exibe USDT corretamente e o consolidado declara a paridade 1,00. Para separar de
  vez, use a conta `paper-crypto`.
- A chave da AwesomeAPI **foi validada** contra o provedor real: cotações autenticadas dos 5 pares
  chegando e ancorando o preço simulado. A chave usada foi colada no chat e **precisa ser
  rotacionada**.
- Discord e APIs genéricas continuam sendo apenas tipo de cadastro. O Telegram tem integração real
  implementada, porém **a conexão com os servidores do Telegram não foi exercitada**: falta
  `TELEGRAM_API_ID`/`TELEGRAM_API_HASH` e uma conta autenticada no ambiente.
- Telegram: só texto e legenda. Imagem e áudio são registrados como formato não suportado, com o
  motivo — não são descartados em silêncio.
- Recuperação de lacuna busca até 50 mensagens por sala; acima disso o excedente é declarado como
  não recuperado.
- Sem autenticação, multiusuário ou criptografia de credenciais.
- Sem backtest, sem métricas de desempenho por fonte, sem ajuste de pesos por resultado.
- Conversão entre moedas é uma paridade declarada (USDT = 1,00 USD) do ambiente simulado. Em produção
  precisa de fonte identificada.
- `Order`/`Position` usam `quantity`; o campo de instrumento `pipSize` carrega dois significados
  distintos por mercado (pip real em Forex, 0,01% em Cripto) — documentado, porém é uma sutileza que
  precisa continuar explícita em qualquer extensão.

## Próximos passos sugeridos, em ordem

0. **Semear Cripto num banco já existente.** Um banco v1 migrado preserva as fontes de Forex e fica
   com Cripto vazio, o que é correto. Para a demonstração completa, cadastre as fontes de Cripto na
   tela Fontes ou use "Apagar banco e recomeçar" em Configurações.
1. **Conectar a conta do Telegram de verdade.** Preencher `TELEGRAM_API_ID` e `TELEGRAM_API_HASH`,
   reiniciar o backend e fazer o login pelo painel. Depois disso, o trabalho real é medir a taxa de
   ambiguidade do parser contra os formatos que as salas de fato usam, e criar perfis de leitura por
   sala onde o formato for previsível.
2. **Uma corretora demo.** Recomendação: **cTrader Open API** primeiro — não exige terminal local
   e permite conceder leitura de conta sem autorização de negociação, o que combina com o modo
   Observação. Começar por saldo, equity e posições; envio de ordem só depois.
3. **Reconciliação periódica** com a corretora: comparar posições locais e remotas a cada N
   segundos e sinalizar divergência, não só reconciliar no momento do envio.
4. **Relatórios de desempenho por fonte** sobre os dados que já estão no banco, com o cuidado
   documentado: custos, tamanho da amostra, dependência entre fontes e validação fora da amostra.
   Nada de ajustar pesos automaticamente sem ação do usuário.

## Armadilhas conhecidas no código

- `Engine.runPipeline()` dispara execuções assíncronas. Em teste ou cenário, chame
  `await engine.flush()` antes de inspecionar ordens ou mexer no preço.
- `upsertOpportunity` só reusa uma oportunidade dentro da validade. Mudar isso faz uma oportunidade
  executada engolir todas as convergências seguintes do mesmo par e direção.
- O parser de texto livre só aceita como instrumento aquilo que está no catálogo — sem essa
  checagem, "COMPRA" (seis letras) era lido como par de moedas.
- Dedupe por conteúdo só vale quando a origem **não** manda identificador de mensagem.
- O mercado do sinal vem **do instrumento**, nunca do campo declarado pela origem. O campo declarado
  só gera aviso quando diverge.
- O pacote `telegram` (GramJS) está arquivado no npm. O projeto usa o fork mantido **`teleproto`**.
- A mensagem do Telegram vira sinal com `externalMessageId = tg:<peerId>:<messageId>`. É isso que faz
  duplicata e edição caírem na máquina que já existia, sem código novo de deduplicação.
- `Store.wipe()` **preserva** a sessão e as salas do Telegram (chaves `telegram.*`): reiniciar o
  ambiente de simulação não deve exigir novo login. As fontes somem, então cada sala fica com
  `sourceId` nulo e recria o vínculo na próxima mensagem.
- No teste, o cliente MTProto falso precisa entregar cada evento a **um** manipulador. Entregar a
  todos faz a mesma mensagem ser lida como nova e como editada.
- Sinal de mercado fora do cadastro da fonte vira `MARKET_MISMATCH`: fica registrado e visível, fora
  da convergência dos dois. Classificar a fonte **resgata** os sinais preservados.
- A reserva de margem precisa acontecer **antes do primeiro `await`** de `executeInner`. Mover para
  depois reintroduz o comprometimento duplo do mesmo saldo.
- A âncora do preço simulado é **recusada quando há posição aberta** no instrumento. Remover essa
  guarda faz um salto de preço disparar stop ou alvo por motivo que não é movimento de mercado.
- O evento de ancoragem é emitido **uma vez por símbolo**. Emitir a cada ciclo encheria o histórico
  com 7.200 eventos por dia sem acrescentar informação.
- Um único par inválido derruba o lote inteiro na AwesomeAPI (404 `CoinNotExists`). Por isso o
  cliente isola o par citado e repete sem ele, no máximo uma vez.
- Chave inválida na AwesomeAPI devolve **HTTP 403**, não 401.
- O limiar de desatualização é `max(15 min, 10× o intervalo)` mais carência de 60 min após a abertura
  de domingo. Valores menores geram falso alarme: cada par tem cadência própria no provedor.
- O stream `@bookTicker` da Binance **não envia horário**, só um id de atualização. Registrar um
  timestamp ali seria inventar dado.
- `close(1006)` é recusado pelo WebSocket nativo: 1006 é código reservado. Para encerrar, use 1000.
- O cão de guarda por ausência de dados é o que detecta conexão aberta porém silenciosa; ping sozinho
  não pega esse caso.
- Índices que citam colunas novas rodam **depois** da migração: `SCHEMA_TABLES` → migração →
  `SCHEMA_INDEXES`. Juntar tudo quebra a abertura de um banco v1.
- `Store` fecha o banco antes de lançar erro de versão de esquema. Sem isso, o arquivo fica preso
  no Windows até o processo terminar.
- `persistRuntime()` é limitada a uma gravação a cada 5 s. Toda mudança que precisa sobreviver
  imediatamente (ordem, fechamento de posição, mudança de controle) chama com `force = true`.
- O caminho do banco é ancorado em `import.meta.dirname`, não em `process.cwd()`: `npm run dev` na
  raiz e `npm start` dentro de `server/` precisam abrir o mesmo arquivo.
- Nenhuma cor fica fora de token no CSS. Texto sobre fundo sólido usa `--on-ink` / `--on-accent`,
  que invertem com o tema; cor fixa quebra o modo escuro em silêncio.
