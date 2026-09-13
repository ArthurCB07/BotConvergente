# Cenários de demonstração

Rode pela tela **Configurações → Cenários de demonstração**, ou por linha de comando:

```bash
curl -X POST http://localhost:8787/api/scenarios/convergencia_suficiente
```

Cada cenário deixa o rastro no histórico de decisões (Home e Operações).

| Chave | O que exercita | Resultado esperado |
|---|---|---|
| `convergencia_suficiente` | Concordância que passa no corte | 3 de 4 fontes participantes, 75%. O espelho da Alfa aparece como não participante, com o motivo |
| `sinais_contrarios` | Direções opostas no mesmo instrumento | 50% de concordância, abaixo do corte. Nenhuma oportunidade publicada |
| `expiracao` | Sinal fora da idade máxima | Dois sinais viram `EXPIRED` e param de votar; a contagem cai |
| `duplicacao` | Mesma mensagem entregue duas vezes | Segunda entrega reconhecida pelo identificador; nenhum voto novo |
| `edicao_mensagem` | Fonte corrige a mensagem, invertendo a direção | Versão 1 vira `SUPERSEDED`; só a versão 2 vota |
| `cancelamento` | Fonte cancela a mensagem | Voto sai do agrupamento imediatamente |
| `mensagem_ambigua` | Texto contraditório, confiança baixa | Sinal marcado `AMBIGUOUS` pela validação determinista; não vota |
| `otc_nao_mistura` | EURUSD regular × EURUSD-OTC | Dois agrupamentos separados, 2 participantes cada; nenhum atinge o mínimo |
| `horizonte_incompativel` | M5 contra swing de dias | Voto de horizonte longo vai para "não comparáveis"; denominador não infla |
| `stop_diario` | Limite diário atingido | Oportunidade publicada e **bloqueada** pelo portão de stop diário |
| `falha_conexao` | Queda da corretora | Cotações param; portões de conexão e de idade da cotação bloqueiam o envio |
| `timeout_reconciliacao` | Requisição expira sem resposta | Sistema consulta a chave de cliente e confirma a execução sem enviar ordem duplicada |
| `execucao_completa` | Fluxo ponta a ponta | Publica, aprova no risco, envia, abre posição e encerra no alvo, registrando o resultado |

## Observações

- `execucao_completa` e `timeout_reconciliacao` precisam enviar ordem. Se o momento atual estiver
  fora dos dias ou horários permitidos (fim de semana, por exemplo), esses cenários **abrem a
  janela de horário e registram um evento de auditoria dizendo exatamente o que mudaram**. Nenhuma
  configuração é alterada em silêncio. Use "Restaurar sugestão" em Configurações depois.
- `stop_diario` força o resultado realizado do dia para baixo do limite e registra isso como
  evento, para que o bloqueio seja claramente atribuível ao cenário e não a operações reais.
- Todos os cenários operam sobre a conta simulada.

## Injeção de falhas manual

Na tela **Corretoras**:

- *Simular queda de conexão* — congela as cotações e bloqueia envios.
- *Timeout nas ordens* — a corretora aceita internamente e não responde; exercita a reconciliação.
- *Rejeição nas ordens* — a corretora recusa; exercita o registro do motivo.
