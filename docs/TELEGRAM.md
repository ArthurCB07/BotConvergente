# Telegram — MTProto com a sua conta

A integração conecta **a sua conta do Telegram** e acompanha as salas às quais você já tem acesso.
Não exige bot adicionado pelos administradores, não depende do Telegram Desktop aberto e funciona
mesmo que você seja apenas membro.

> **O que esta integração faz:** lê mensagens de texto e legendas das salas que você escolher.
> **O que ela não faz:** entrar em salas, enviar mensagens, reagir, apagar, ou contornar qualquer
> restrição de sala. É leitura, e só das salas selecionadas.

## 1. Credenciais

Obtenha os dois valores em <https://my.telegram.org> → *API development tools* e preencha no `.env`
da raiz do projeto:

```
TELEGRAM_API_ID=
TELEGRAM_API_HASH=
```

Depois **reinicie o backend**.

- São lidos **somente no backend**. Não vão para o frontend, para URLs, para logs nem para respostas
  da API.
- O painel mostra apenas **"Credenciais configuradas"** ou **"Configuração pendente"**.
- **Preencher as variáveis não conecta a conta.** Ter credencial é uma coisa; ter sessão autenticada
  é outra. O painel diferencia as duas o tempo todo.
- `.env` e arquivos de sessão estão no `.gitignore`.

## 2. Conexão

Na aba **Fontes**, seção **Telegram**, área *Conexão da conta*:

1. **Conectar Telegram** → campo de telefone com código do país.
2. **Código de verificação.** A tela mostra o método que o serviço **realmente** informou —
   aplicativo, SMS, chamada, chamada perdida, e-mail, Fragment, ou até palavra/frase por SMS. Nunca
   prometemos SMS por conta própria.
3. **Senha de duas etapas**, exibida **apenas quando o serviço pede**.
4. Confirmação, com nome, usuário e **telefone mascarado**.

| Situação | O que acontece |
|---|---|
| Código incorreto | Mensagem clara, o passo do código continua aberto, nada é reenviado sozinho |
| Código expirado | Explica que expirou e pede um novo código |
| Espera obrigatória | Mostra os segundos que o Telegram exigiu; nenhum pedido é refeito automaticamente |
| Senha incorreta | Volta ao passo da senha, sem perder a sessão de login |
| Falha de conexão | Estado `Erro na conexão`, com o motivo |

**Reenvio** tem botão próprio, respeita o tempo informado pelo serviço e para no terceiro pedido da
mesma tentativa. Não existe reenvio contínuo.

O código e a senha **não são gravados**: existem como argumento de função durante a chamada e somem.
A sessão autenticada fica no banco local (`kv`, chave `telegram.session`) e é reaproveitada após
reinícios. **Encerrar sessão** derruba apenas esta sessão — as suas outras sessões do Telegram
continuam intactas.

## 3. Salas

*Escolher salas* lista os grupos e canais acessíveis, com busca por nome. **Listar não habilita
leitura**: a sala só passa a ser lida depois de receber mercado e ter o monitoramento ligado.

Por sala:

| Campo | Para que serve |
|---|---|
| Nome de exibição | Nome seu, independente do título que o administrador usa |
| Mercado | Forex, Cripto ou ambos. Sem isso, o monitoramento não liga |
| Monitoramento | Liga e desliga a leitura |
| Perfil de interpretação | Genérico, Forex clássico, Cripto clássico ou Somente registro |
| Participa da convergência | Desligado, a sala continua sendo lida e exibida, porém não vota |
| Grupo de independência | Salas que replicam a mesma origem compartilham o valor e contam **um voto** |
| Tópicos | Em fóruns, lista de tópicos a ler. **Vazio = a sala inteira**; com tópicos escolhidos, mensagem de fora fica registrada como ignorada, com o motivo |

A sala é identificada pelo **ID estável do Telegram**, nunca pelo título — renomear a sala não
quebra nada.

A tabela *Salas monitoradas* mostra nome, mercado, estado, última mensagem, último sinal válido e
contagem de sinais válidos, com filtro Forex/Cripto e as ações **Ver atividade**, **Configurar** e
**Pausar**.

**Pausar não apaga histórico** e não interfere em posições abertas.

## 4. Leitura e interpretação

- Chegam mensagens novas e **edições**. Cada registro guarda origem, id da mensagem, horário de
  publicação (informado pelo Telegram), horário de recebimento e versão.
- Começa por **texto e legenda**. Imagem e áudio são registrados como *Formato ainda não suportado*,
  com o motivo — nunca são silenciosamente descartados.
- São extraídos ativo, direção, entrada, stop e alvo. O **texto original é preservado** e exibido
  lado a lado com o que foi lido.
- Mensagem incompleta ou ambígua **fica pendente** e não vira entrada automática.
- **Conteúdo recebido é dado, nunca instrução.** Nada vindo de uma mensagem altera configuração,
  executa código ou toca em credencial.

## 5. Separação entre mercados

O mercado sai do **instrumento**, não do que a mensagem declara:

- Sinal de Forex só entra na análise de Forex; sinal de cripto, só na de cripto.
- Em sala mista, a classificação é **por sinal**.
- Sinal de um mercado que a sala não cobre fica pendente, visível, fora da convergência.
- Spot, futuros e perpétuos não se misturam (o catálogo separa `CRYPTO_SPOT` de `CRYPTO_PERP`).

**Duplicação e edição** reaproveitam a máquina que já existia: o id da mensagem do Telegram vira o
identificador externo do sinal (`tg:<peerId>:<messageId>`). A mesma mensagem entregue duas vezes não
cria voto novo; uma edição gera nova **versão** do mesmo sinal, sem voto adicional.

## 6. Atividade e transparência

O painel *Atividade de recebimento* registra: mensagem recebida, sinal reconhecido, mensagem
ignorada, sinal pendente, sinal atualizado, sinal cancelado, formato não suportado, conexão perdida,
conexão recuperada, acesso perdido e lacuna de recebimento. Cada linha com texto abre a comparação
**original × leitura**.

Filtro por sala, e o botão *Ver atividade* de cada sala leva direto ao filtro dela.

## 7. Continuidade

- Reconexão automática da biblioteca, mais botão **Reconectar**.
- Um vigia confere a conexão a cada 60 s. Sem ele, uma queda silenciosa deixaria a tela dizendo
  "conectado" sem receber nada — e *conectado e quieto* não pode parecer igual a *fora do ar*. A
  queda e a volta ficam registradas na atividade.
- O último id de mensagem lido por sala fica gravado. Ao voltar, a integração busca o que ficou para
  trás e registra a lacuna de forma visível. **Sinais já vencidos entram apenas como histórico** — a
  validação de idade do motor impede que disparem operação.
- Se a busca de lacuna passar de 50 mensagens, o excedente é declarado como não recuperado, em vez
  de fingir que tudo foi lido.
- Perda de acesso a uma sala vira o estado `Sem acesso a sala`, com o motivo. A integração **não
  tenta contornar restrições**.

## 8. Proteção do painel

As rotas `/api/telegram/*` são de configuração e autenticação, e por isso têm guarda própria:

- Só aceitam chamada vinda da **própria máquina** onde o backend roda.
- Com `DASHBOARD_TOKEN` definido no ambiente, exigem também o cabeçalho `x-dashboard-token`.

A proteção por endereço impede acesso de outra máquina da rede; ela **não** separa usuários
diferentes do mesmo computador. Para isso, defina o token.

O painel nunca exibe `api_hash`, sessão, telefone completo, código, senha ou conversas de salas não
selecionadas.

## 9. O que foi e o que não foi validado

Testado com um cliente MTProto falso (`server/test/telegram.test.ts`, 24 testes): seleção de salas,
identificação por id estável, interpretação, formato não suportado, perfis, isolamento Forex/Cripto,
sala mista, duplicação, edição, réplicas com um voto só, pausa sem perda de histórico, recuperação de
lacuna, perda de acesso, persistência entre reinícios e o que o painel expõe.

**Não validado:** a conversa real com os servidores do Telegram. Isso depende de `TELEGRAM_API_ID` e
`TELEGRAM_API_HASH` reais e de uma conta autenticada — passo que só você pode executar.

Esta etapa **não** habilita operações reais. As contas continuam simuladas.

## Rotas internas

| Rota | O que faz |
|---|---|
| `GET /api/telegram/state` | Estado, salas, atividade e perfis |
| `POST /api/telegram/login` | Passo do telefone |
| `POST /api/telegram/code` | Passo do código |
| `POST /api/telegram/password` | Passo da senha de duas etapas |
| `POST /api/telegram/resend` | Pede novo código, respeitando a espera |
| `POST /api/telegram/reconnect` | Reconecta com a sessão salva |
| `POST /api/telegram/logout` | Encerra apenas esta sessão |
| `GET /api/telegram/dialogs` | Conversas acessíveis |
| `POST /api/telegram/rooms` | Cria ou atualiza a configuração de uma sala |
| `POST /api/telegram/rooms/:peerId/monitoring` | Liga e desliga a leitura |
| `DELETE /api/telegram/rooms/:peerId` | Remove a sala da integração |
| `GET /api/telegram/activity` | Atividade, com filtro por sala |
