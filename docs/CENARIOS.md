# Cenários de demonstração

Rode pela tela **Configurações → Cenários de demonstração** (a lista mostra os do mercado
selecionado mais os que cobrem os dois), ou por linha de comando:

```bash
curl -X POST http://localhost:8787/api/scenarios/convergencia_forex
```

Cada cenário deixa o rastro no histórico de decisões, carimbado com o mercado.

## Forex

| Chave | O que exercita | Resultado esperado |
|---|---|---|
| `convergencia_forex` | Concordância que passa no corte | 3 de 4 fontes de Forex (75%). O espelho da Alfa não gera voto extra |
| `sinais_contrarios` | Direções opostas no mesmo instrumento | 50%, abaixo do corte. Nenhuma oportunidade |
| `expiracao` | Sinal fora da idade máxima | Dois sinais viram `EXPIRED` e param de votar |
| `duplicacao` | Mesma mensagem entregue duas vezes | Segunda entrega reconhecida pelo identificador |
| `edicao_mensagem` | Fonte corrige a mensagem, invertendo a direção | Versão 1 vira `SUPERSEDED`; só a versão 2 vota |
| `otc_nao_mistura` | EURUSD regular × EURUSD-OTC | Dois agrupamentos separados, 2 participantes cada |
| `timeout_reconciliacao` | Requisição expira sem resposta | Consulta a chave de cliente e confirma sem duplicar |
| `execucao_completa_forex` | Fluxo ponta a ponta | Publica, aprova, envia, abre e encerra no alvo |

## Cripto

| Chave | O que exercita | Resultado esperado |
|---|---|---|
| `convergencia_cripto` | Concordância em BTCUSDT à vista | Oportunidade de Cripto publicada; Forex não participa |
| `spot_vs_perp` | BTCUSDT à vista × BTCUSDT-PERP | Dois agrupamentos por tipo de produto, 2 participantes cada. Nenhum atinge o mínimo |
| `base_percentual` | Alterna a base do denominador | Com "sinais comparáveis", 3/3 = 100%. Com "fontes habilitadas", o denominador vira o total de grupos do mercado e o silêncio pesa contra |
| `execucao_completa_cripto` | Fluxo ponta a ponta em Cripto | Abre posição em BTC e encerra no alvo, com quantidade em BTC |

## Os dois mercados

| Chave | O que exercita | Resultado esperado |
|---|---|---|
| `mercado_nao_cadastrado` | Fonte de Forex envia sinal de BTCUSDT | `MARKET_MISMATCH`: registrado e visível, fora da convergência dos dois |
| `cripto_nao_afeta_forex` | Dois votos em EURUSD + seis em ETHUSDT | Forex continua com 2 participantes e abaixo do corte; Cripto publica a sua |
| `automacao_independente` | Automação de Cripto ligada, de Forex desligada | Cripto envia ordem. Forex publica a oportunidade e bloqueia com "automação desligada" |
| `execucao_simultanea` | Convergência elegível nos dois ao mesmo tempo | Duas ordens, uma por mercado, cada uma com sua conta e sua reserva de margem |
| `limite_global` | Máximo global de 1 posição | A segunda entrada é bloqueada pelo portão **GLOBAL**, com o limite individual livre |
| `stop_diario_mercado` | Stop diário de Forex atingido | Forex bloqueado; Cripto continua elegível |
| `falha_conexao` | Queda da conta compartilhada | Cotações param; conexão e idade da cotação bloqueiam envios nos mercados que usam essa conta |

## Observações

- Cenários que enviam ordem **abrem a janela de horário do mercado e registram um evento de
  auditoria dizendo exatamente o que mudaram**. Nenhuma configuração muda em silêncio. Use
  "Restaurar sugestão" em Configurações depois.
- `stop_diario_mercado` força o resultado realizado de Forex e registra isso como evento, para que o
  bloqueio seja atribuível ao cenário e não a operações reais.
- Todos os cenários operam sobre contas simuladas.

## Injeção de falhas manual

Na tela **Conexões**, aplicada à conta usada pelo mercado selecionado:

- *Simular queda de conexão* — congela as cotações e bloqueia envios.
- *Timeout nas ordens* — a conexão aceita internamente e não responde; exercita a reconciliação.
- *Rejeição nas ordens* — a conexão recusa; exercita o registro do motivo.
