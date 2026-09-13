# Estado do projeto

Resumo compacto para retomar o trabalho sem reler o histórico da conversa.
Atualizado em 13/09/2026.

## O que é

Plataforma que agrega sinais de várias salas, detecta convergência entre fontes independentes e
publica oportunidades auditáveis. Modos: Observação, Semiautomático, Autônomo. Diferencial:
mostrar de onde veio cada sinal, por que houve convergência e por que a operação foi executada ou
bloqueada.

## Decisões já tomadas

| Tema | Decisão |
|---|---|
| Mercado do MVP | Forex spot, pares major. OTC existe no modelo só para provar que não se mistura com o regular |
| Conta | Simulada por adaptador local, rotulada `SIMULADA` na interface. Nenhuma conexão real |
| Denominador do percentual | Grupos de independência com sinal válido e comparável na janela |
| Voto | No máximo 1 vigente por grupo de independência. Espelhos são agrupados manualmente |
| Corte padrão | 3 fontes **e** 75%, ambos exigidos |
| Idempotência | `clientOrderId = opp-<id>-v<tentativa>`, reconciliação antes de qualquer reenvio |
| Limites diários | Base = patrimônio na abertura do dia; contam só posições fechadas; depósitos e saques à parte |
| IA na leitura de mensagens | Produz rascunho com confiança; validação determinista decide. Confiança < 0,75 → `AMBIGUOUS`, não vota |
| Stack | Node + TypeScript + Express (backend), React + Vite (interface), npm workspaces |
| Persistência | SQLite pelo módulo nativo `node:sqlite`, sem dependência nativa. Arquivo em `server/data/app.db` |
| Formato das tabelas | Colunas indexáveis + coluna `data` em JSON, com versão de esquema |
| Tema | Claro, escuro e sistema. Preferência em `localStorage`, fora do backend |
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
- Persistência em SQLite: fontes, sinais, oportunidades, ordens, posições e eventos gravados por
  linha; modo, pausa, configurações, estado do dia e estado do simulador em chave e valor. Retomada
  completa após reiniciar o processo, inclusive a idempotência das ordens.
- Tema claro, escuro e "sistema", sem cor fixa fora dos tokens.
- 43 testes automatizados (`npm test`), typecheck limpo em backend e frontend.
- 13 cenários de demonstração cobrindo concordância, divergência, expiração, duplicação, edição,
  cancelamento, ambiguidade, OTC, horizonte, stop diário, falha de conexão, timeout com
  reconciliação e execução completa.

## O que NÃO está pronto

- Nenhuma integração real de corretora. MT5 e cTrader estão catalogados com o que falta.
- Nenhum conector de mensageria. Telegram, Discord e APIs existem como tipo de cadastro apenas.
- Sem autenticação, multiusuário ou criptografia de credenciais.
- Sem backtest, sem métricas de desempenho por fonte, sem ajuste de pesos por resultado.
- Só existe a versão 1 do esquema: não há migração escrita para exercitar o caminho de atualização.

## Próximos passos sugeridos, em ordem

1. **Uma fonte real.** Webhook já funciona: o caminho mais curto é um relay que lê um canal de
   Telegram autorizado e faz POST em `/api/webhook/<token>`. Verificar os termos da plataforma e
   usar credencial própria do usuário. Trabalho principal: normalizar formatos reais de mensagem e
   medir a taxa de ambiguidade antes de confiar no parser.
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
- `Store` fecha o banco antes de lançar erro de versão de esquema. Sem isso, o arquivo fica preso
  no Windows até o processo terminar.
- `persistRuntime()` é limitada a uma gravação a cada 5 s. Toda mudança que precisa sobreviver
  imediatamente (ordem, fechamento de posição, mudança de controle) chama com `force = true`.
- O caminho do banco é ancorado em `import.meta.dirname`, não em `process.cwd()`: `npm run dev` na
  raiz e `npm start` dentro de `server/` precisam abrir o mesmo arquivo.
- Nenhuma cor fica fora de token no CSS. Texto sobre fundo sólido usa `--on-ink` / `--on-accent`,
  que invertem com o tema; cor fixa quebra o modo escuro em silêncio.
