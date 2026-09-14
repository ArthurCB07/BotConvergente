import { useMemo, useState } from 'react';
import {
  MARKETS,
  MARKET_LABEL,
  PARSE_PROFILE_LABEL,
  ROOM_STATE_LABEL,
  api,
  getDashboardToken,
  setDashboardToken,
  type MarketId,
  type ParseProfile,
  type TelegramActivity,
  type TelegramRoom,
  type TelegramState,
} from '../api.ts';
import { Badge, Card, Empty, MarketChip, clock, dateTime, relative } from './ui.tsx';

/**
 * Painel do Telegram: conexao da conta, salas monitoradas e atividade de
 * recebimento.
 *
 * O que este painel NUNCA mostra: `api_hash`, sessao, telefone completo, codigo
 * de verificacao, senha de duas etapas ou conversa de sala nao selecionada. O
 * codigo e a senha sao digitados, enviados e esquecidos — nao ficam nem no
 * navegador nem no servidor.
 */

const STATE_TONE: Record<string, 'ok' | 'block' | 'watch' | 'risk' | 'neutral'> = {
  SEM_CREDENCIAIS: 'neutral',
  DESCONECTADO: 'neutral',
  CONECTANDO: 'watch',
  AGUARDANDO_CODIGO: 'watch',
  AGUARDANDO_SENHA: 'watch',
  CONECTADO: 'ok',
  ERRO: 'risk',
};

const STATE_LABEL: Record<string, string> = {
  SEM_CREDENCIAIS: 'Configuracao pendente',
  DESCONECTADO: 'Desconectado',
  CONECTANDO: 'Conectando',
  AGUARDANDO_CODIGO: 'Aguardando codigo',
  AGUARDANDO_SENHA: 'Aguardando senha de duas etapas',
  CONECTADO: 'Conectado',
  ERRO: 'Erro na conexao',
};

const ROOM_STATE_TONE: Record<TelegramRoom['state'], 'ok' | 'block' | 'watch' | 'risk' | 'neutral'> =
  {
    MONITORANDO: 'ok',
    PAUSADA: 'neutral',
    ACESSO_PERDIDO: 'risk',
    ERRO_INTERPRETACAO: 'block',
    NAO_SELECIONADA: 'neutral',
  };

const ACTIVITY_LABEL: Record<string, string> = {
  MENSAGEM_RECEBIDA: 'Mensagem recebida',
  SINAL_RECONHECIDO: 'Sinal reconhecido',
  MENSAGEM_IGNORADA: 'Mensagem ignorada',
  SINAL_PENDENTE: 'Sinal pendente',
  SINAL_ATUALIZADO: 'Sinal atualizado',
  SINAL_CANCELADO: 'Sinal cancelado',
  FORMATO_NAO_SUPORTADO: 'Formato nao suportado',
  CONEXAO_PERDIDA: 'Conexao perdida',
  CONEXAO_RECUPERADA: 'Conexao recuperada',
  ACESSO_PERDIDO: 'Acesso perdido',
  LACUNA_RECEBIMENTO: 'Lacuna de recebimento',
};

const PARSED_FIELD_LABEL: Record<string, string> = {
  symbol: 'Instrumento',
  marketId: 'Mercado',
  side: 'Direcao',
  entryPrice: 'Entrada',
  stopLoss: 'Stop',
  takeProfit: 'Alvo',
  timeframeMinutes: 'Tempo grafico',
  confidence: 'Confianca da leitura',
};

export function TelegramPanel({
  telegram,
  now,
  needsToken,
  error,
  reload,
}: {
  telegram: TelegramState | null;
  now: string;
  needsToken: boolean;
  error: string | null;
  reload: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [phone, setPhone] = useState('+55 ');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState(getDashboardToken());
  const [search, setSearch] = useState('');
  const [showDialogs, setShowDialogs] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [detail, setDetail] = useState<TelegramActivity | null>(null);
  const [activityFilter, setActivityFilter] = useState<string>('TODAS');

  const run = async (fn: () => Promise<{ ok: boolean; message: string }>) => {
    setBusy(true);
    try {
      const result = await fn();
      setFeedback(result.message);
      reload();
      return result;
    } catch (e) {
      setFeedback((e as Error).message);
      return { ok: false, message: (e as Error).message };
    } finally {
      setBusy(false);
    }
  };

  if (needsToken) {
    return (
      <Card title="Telegram">
        <p className="small">
          As rotas de configuracao e autenticacao estao protegidas por token. Informe o valor de{' '}
          <code>DASHBOARD_TOKEN</code> definido no ambiente do backend.
        </p>
        <div className="row" style={{ marginTop: 10 }}>
          <input
            type="password"
            value={token}
            placeholder="Token do painel"
            onChange={(e) => setToken(e.target.value)}
            style={{ maxWidth: 260 }}
          />
          <button
            className="btn btn-primary"
            onClick={() => {
              setDashboardToken(token.trim());
              reload();
            }}
          >
            Usar token
          </button>
        </div>
      </Card>
    );
  }

  if (!telegram) {
    return (
      <Card title="Telegram">
        <p className="small dim">{error ?? 'Carregando o estado da integracao.'}</p>
      </Card>
    );
  }

  return (
    <div className="stack">
      <Conexao
        telegram={telegram}
        busy={busy}
        feedback={feedback}
        phone={phone}
        setPhone={setPhone}
        code={code}
        setCode={setCode}
        password={password}
        setPassword={setPassword}
        run={run}
      />

      {telegram.state === 'CONECTADO' && (
        <>
          <Salas
            telegram={telegram}
            now={now}
            busy={busy}
            search={search}
            setSearch={setSearch}
            showDialogs={showDialogs}
            setShowDialogs={setShowDialogs}
            editing={editing}
            setEditing={setEditing}
            run={run}
            onVerActividade={(peerId) => setActivityFilter(peerId)}
          />

          <Atividade
            telegram={telegram}
            now={now}
            filter={activityFilter}
            setFilter={setActivityFilter}
            detail={detail}
            setDetail={setDetail}
          />
        </>
      )}
    </div>
  );
}

// --- Area 1: conexao da conta ----------------------------------------------

function Conexao({
  telegram,
  busy,
  feedback,
  phone,
  setPhone,
  code,
  setCode,
  password,
  setPassword,
  run,
}: {
  telegram: TelegramState;
  busy: boolean;
  feedback: string | null;
  phone: string;
  setPhone: (v: string) => void;
  code: string;
  setCode: (v: string) => void;
  password: string;
  setPassword: (v: string) => void;
  run: (fn: () => Promise<{ ok: boolean; message: string }>) => Promise<{ ok: boolean }>;
}) {
  const nome = [telegram.account?.firstName, telegram.account?.lastName].filter(Boolean).join(' ');

  return (
    <Card
      title="Conexao da conta"
      aside={
        <Badge tone={STATE_TONE[telegram.state] ?? 'neutral'}>
          {STATE_LABEL[telegram.state] ?? telegram.state}
        </Badge>
      }
    >
      <div className="row" style={{ marginBottom: 10 }}>
        <Badge tone={telegram.configured ? 'ok' : 'neutral'}>
          {telegram.configured ? 'Credenciais configuradas' : 'Configuracao pendente'}
        </Badge>
        <span className="tiny dim">
          Ter as variaveis preenchidas nao conecta a conta: a conexao e feita aqui.
        </span>
      </div>

      {!telegram.configured && (
        <div className="notice notice-warn small">
          <strong>Falta configurar.</strong> {telegram.setupHint}
        </div>
      )}

      {telegram.error && (
        <div className="notice notice-risk small">
          {telegram.error.message}
          {telegram.error.waitSeconds != null && (
            <>
              {' '}
              <strong>A espera e exigida pelo proprio Telegram.</strong> Nenhum pedido e refeito
              automaticamente.
            </>
          )}
        </div>
      )}

      {/* Passo 1: telefone */}
      {telegram.configured &&
        (telegram.state === 'DESCONECTADO' ||
          telegram.state === 'ERRO' ||
          telegram.state === 'CONECTANDO') && (
          <form
            className="stack-sm"
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => api.telegramLogin(phone));
            }}
          >
            <label className="field">
              <span className="small">Telefone com codigo do pais</span>
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+55 11 90000-0000"
                style={{ maxWidth: 260 }}
              />
            </label>
            <p className="tiny dim">
              O numero fica apenas no backend e volta mascarado para esta tela.
            </p>
            <div>
              <button className="btn btn-primary" disabled={busy}>
                Conectar Telegram
              </button>
            </div>
          </form>
        )}

      {/* Passo 2: codigo */}
      {telegram.state === 'AGUARDANDO_CODIGO' && telegram.pending && (
        <form
          className="stack-sm"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => api.telegramCode(code)).then(() => setCode(''));
          }}
        >
          <p className="small">
            <strong>{telegram.pending.delivery.label}</strong>
          </p>
          <p className="tiny dim">
            Enviado para {telegram.pending.phoneMasked}
            {telegram.pending.delivery.length != null && (
              <> · {telegram.pending.delivery.length} caracteres</>
            )}
          </p>
          <label className="field">
            <span className="small">Codigo de verificacao</span>
            <input
              value={code}
              inputMode="numeric"
              autoComplete="one-time-code"
              onChange={(e) => setCode(e.target.value)}
              style={{ maxWidth: 180 }}
            />
          </label>
          <div className="row">
            <button className="btn btn-primary" disabled={busy}>
              Confirmar codigo
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={() => void run(() => api.telegramResend())}
            >
              Pedir novo codigo
            </button>
          </div>
          <p className="tiny dim">
            Nenhum reenvio acontece sozinho. O botao respeita a espera informada pelo servico
            {telegram.pending.delivery.timeoutSeconds != null && (
              <> ({telegram.pending.delivery.timeoutSeconds} s)</>
            )}
            .
          </p>
        </form>
      )}

      {/* Passo 3: senha de duas etapas, apenas quando o servico pede */}
      {telegram.state === 'AGUARDANDO_SENHA' && (
        <form
          className="stack-sm"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => api.telegramPassword(password)).then(() => setPassword(''));
          }}
        >
          <p className="small">
            Esta conta usa verificacao em duas etapas. Digite a senha para concluir.
          </p>
          <label className="field">
            <span className="small">Senha de duas etapas</span>
            <input
              type="password"
              value={password}
              autoComplete="current-password"
              onChange={(e) => setPassword(e.target.value)}
              style={{ maxWidth: 260 }}
            />
          </label>
          <div>
            <button className="btn btn-primary" disabled={busy}>
              Concluir conexao
            </button>
          </div>
          <p className="tiny dim">A senha nao e gravada em lugar nenhum.</p>
        </form>
      )}

      {/* Conectado */}
      {telegram.state === 'CONECTADO' && telegram.account && (
        <div className="stack-sm">
          <p className="small">
            Conectado como <strong>{nome || telegram.account.username || 'conta do Telegram'}</strong>
            {telegram.account.username && <span className="dim"> (@{telegram.account.username})</span>}
            {telegram.account.phoneMasked && (
              <span className="dim num"> · {telegram.account.phoneMasked}</span>
            )}
          </p>
          <p className="tiny dim">
            Sessao aberta em {dateTime(telegram.account.connectedAt)}. A integracao apenas le as
            salas escolhidas: nunca entra em salas novas e nunca envia mensagem.
          </p>
          <div className="row">
            <button
              className="btn btn-sm"
              disabled={busy}
              onClick={() => void run(() => api.telegramReconnect())}
            >
              Reconectar
            </button>
            <button
              className="btn btn-sm btn-danger"
              disabled={busy}
              onClick={() => void run(() => api.telegramLogout())}
            >
              Encerrar sessao
            </button>
          </div>
          <p className="tiny dim">
            Encerrar aqui derruba somente esta sessao. Suas outras sessoes do Telegram continuam
            intactas.
          </p>
        </div>
      )}

      {feedback && <p className="small" style={{ marginTop: 10 }}>{feedback}</p>}
    </Card>
  );
}

// --- Area 2: salas monitoradas ---------------------------------------------

function Salas({
  telegram,
  now,
  busy,
  search,
  setSearch,
  showDialogs,
  setShowDialogs,
  editing,
  setEditing,
  run,
  onVerActividade,
}: {
  telegram: TelegramState;
  now: string;
  busy: boolean;
  search: string;
  setSearch: (v: string) => void;
  showDialogs: boolean;
  setShowDialogs: (v: boolean) => void;
  editing: string | null;
  setEditing: (v: string | null) => void;
  run: (fn: () => Promise<{ ok: boolean; message: string }>) => Promise<{ ok: boolean }>;
  onVerActividade: (peerId: string) => void;
}) {
  const [marketFilter, setMarketFilter] = useState<'TODOS' | MarketId>('TODOS');
  /** Mercados marcados na lista de conversas, antes de virar sala monitorada. */
  const [pick, setPick] = useState<Record<string, MarketId[]>>({});

  const rooms = telegram.rooms.filter(
    (room) => marketFilter === 'TODOS' || room.markets.includes(marketFilter),
  );

  const dialogs = useMemo(() => {
    const term = search.trim().toLowerCase();
    return telegram.dialogs.filter(
      (d) => !term || d.title.toLowerCase().includes(term) || (d.username ?? '').toLowerCase().includes(term),
    );
  }, [telegram.dialogs, search]);

  return (
    <Card
      title="Salas monitoradas"
      aside={
        <div className="row">
          <div className="seg">
            {(['TODOS', ...MARKETS] as const).map((option) => (
              <button
                key={option}
                aria-pressed={marketFilter === option}
                onClick={() => setMarketFilter(option as 'TODOS' | MarketId)}
              >
                {option === 'TODOS' ? 'Todos' : MARKET_LABEL[option as MarketId]}
              </button>
            ))}
          </div>
          <button
            className="btn btn-sm"
            disabled={busy}
            onClick={() => {
              setShowDialogs(!showDialogs);
              if (!showDialogs) void api.telegramDialogs(true).catch(() => undefined);
            }}
          >
            {showDialogs ? 'Fechar lista' : 'Escolher salas'}
          </button>
        </div>
      }
    >
      <p className="tiny dim" style={{ marginBottom: 10 }}>
        Listar uma conversa nao habilita a leitura dela. Uma sala so passa a ser lida quando recebe
        mercado e o monitoramento e ligado.
      </p>

      {showDialogs && (
        <div className="stack-sm" style={{ marginBottom: 14 }}>
          <p className="small">
            Marque o mercado que a sala publica e clique em <strong>Monitorar</strong>. A leitura
            comeca na hora; perfil e agrupamento podem ser ajustados depois, em Configurar.
          </p>
          <input
            value={search}
            placeholder="Buscar por nome"
            onChange={(e) => setSearch(e.target.value)}
            style={{ maxWidth: 300 }}
          />
          <div className="table-wrap" style={{ maxHeight: 300, overflowY: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Conversa</th>
                  <th>Tipo</th>
                  <th>O que ela publica</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {dialogs.map((dialog) => {
                  const picked = pick[dialog.peerId] ?? [];
                  const toggle = (id: MarketId) =>
                    setPick({
                      ...pick,
                      [dialog.peerId]: picked.includes(id)
                        ? picked.filter((m) => m !== id)
                        : [...picked, id],
                    });

                  return (
                    <tr key={dialog.peerId}>
                      <td>
                        {dialog.title}
                        {dialog.username && <span className="tiny dim"> @{dialog.username}</span>}
                      </td>
                      <td className="small dim">{dialog.kind === 'CANAL' ? 'Canal' : 'Grupo'}</td>
                      <td>
                        {dialog.configured ? (
                          <span className="tiny dim">Ja esta na sua lista, abaixo.</span>
                        ) : (
                          <div className="row" style={{ gap: 10 }}>
                            {MARKETS.map((id) => (
                              <label key={id} className="row small" style={{ gap: 5 }}>
                                <input
                                  type="checkbox"
                                  style={{ width: 'auto' }}
                                  checked={picked.includes(id)}
                                  onChange={() => toggle(id)}
                                />
                                {MARKET_LABEL[id]}
                              </label>
                            ))}
                          </div>
                        )}
                      </td>
                      <td>
                        {dialog.configured ? (
                          <Badge tone={dialog.monitoring ? 'ok' : 'neutral'}>
                            {dialog.monitoring ? 'Monitorando' : 'Pausada'}
                          </Badge>
                        ) : (
                          <button
                            className="btn btn-primary btn-sm"
                            disabled={busy || picked.length === 0}
                            title={
                              picked.length === 0
                                ? 'Marque Forex, Cripto ou os dois antes de monitorar.'
                                : undefined
                            }
                            onClick={() =>
                              void run(() =>
                                api.telegramConfigureRoom({
                                  peerId: dialog.peerId,
                                  title: dialog.title,
                                  markets: picked,
                                  // Uma etapa so: a sala ja entra lendo.
                                  monitoring: true,
                                  profile:
                                    picked.length === 1
                                      ? picked[0] === 'FOREX'
                                        ? 'FOREX_CLASSICO'
                                        : 'CRIPTO_CLASSICO'
                                      : 'GENERICO',
                                }),
                              )
                            }
                          >
                            Monitorar
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {dialogs.length === 0 && (
                  <tr>
                    <td colSpan={4} className="small dim">
                      Nenhuma conversa encontrada.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {rooms.length === 0 ? (
        <Empty>
          {telegram.rooms.length === 0
            ? 'Nenhuma sala escolhida ainda. Clique em "Escolher salas", marque o mercado que cada uma publica e confirme em Monitorar.'
            : 'Nenhuma sala deste mercado. Troque o filtro acima para ver as demais.'}
        </Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Sala</th>
                <th>Mercado</th>
                <th>Estado</th>
                <th>Ultima mensagem</th>
                <th>Ultimo sinal valido</th>
                <th className="num">Sinais validos</th>
                <th>Acoes</th>
              </tr>
            </thead>
            <tbody>
              {rooms.map((room) => (
                <RoomRow
                  key={room.peerId}
                  room={room}
                  now={now}
                  busy={busy}
                  telegram={telegram}
                  editing={editing === room.peerId}
                  setEditing={setEditing}
                  run={run}
                  onVerActividade={onVerActividade}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function RoomRow({
  room,
  now,
  busy,
  telegram,
  editing,
  setEditing,
  run,
  onVerActividade,
}: {
  room: TelegramRoom;
  now: string;
  busy: boolean;
  telegram: TelegramState;
  editing: boolean;
  setEditing: (v: string | null) => void;
  run: (fn: () => Promise<{ ok: boolean; message: string }>) => Promise<{ ok: boolean }>;
  onVerActividade: (peerId: string) => void;
}) {
  const [draft, setDraft] = useState({
    displayName: room.displayName,
    markets: room.markets,
    profile: room.profile,
    participatesInConvergence: room.participatesInConvergence,
    independenceGroupId: room.independenceGroupId,
  });

  const toggleMarket = (id: MarketId) =>
    setDraft((d) => ({
      ...d,
      markets: d.markets.includes(id) ? d.markets.filter((m) => m !== id) : [...d.markets, id],
    }));

  return (
    <>
      <tr>
        <td>
          {room.displayName}
          {room.displayName !== room.title && <div className="tiny dim">Titulo atual: {room.title}</div>}
          <div className="tiny dim">
            {PARSE_PROFILE_LABEL[room.profile]}
            {!room.participatesInConvergence && ' · fora da convergencia'}
          </div>
        </td>
        <td>
          {room.markets.length === 0 ? (
            <span className="tiny dim">Sem mercado</span>
          ) : (
            <div className="row" style={{ gap: 4 }}>
              {room.markets.map((m) => (
                <MarketChip key={m} marketId={m} />
              ))}
            </div>
          )}
        </td>
        <td>
          <Badge tone={ROOM_STATE_TONE[room.state]}>{ROOM_STATE_LABEL[room.state]}</Badge>
          {room.stateDetail && <div className="tiny dim">{room.stateDetail}</div>}
        </td>
        <td className="small dim">{relative(room.lastMessageAt, now)}</td>
        <td className="small dim">{relative(room.lastValidSignalAt, now)}</td>
        <td className="num">{room.validSignals}</td>
        <td>
          <div className="row" style={{ gap: 6 }}>
            <button className="btn btn-sm" onClick={() => onVerActividade(room.peerId)}>
              Ver atividade
            </button>
            <button className="btn btn-sm" onClick={() => setEditing(editing ? null : room.peerId)}>
              Configurar
            </button>
            <button
              className="btn btn-sm"
              disabled={busy}
              onClick={() => void run(() => api.telegramSetMonitoring(room.peerId, !room.monitoring))}
            >
              {room.monitoring ? 'Pausar' : 'Retomar'}
            </button>
          </div>
        </td>
      </tr>

      {editing && (
        <tr>
          <td colSpan={7}>
            <div className="stack-sm" style={{ padding: '8px 0' }}>
              <div className="row">
                <label className="field">
                  <span className="tiny dim">Nome de exibicao</span>
                  <input
                    value={draft.displayName}
                    onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
                    style={{ maxWidth: 240 }}
                  />
                </label>
                <label className="field">
                  <span className="tiny dim">Perfil de interpretacao</span>
                  <select
                    value={draft.profile}
                    onChange={(e) => setDraft({ ...draft, profile: e.target.value as ParseProfile })}
                  >
                    {telegram.profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span className="tiny dim">Grupo de independencia</span>
                  <input
                    value={draft.independenceGroupId}
                    onChange={(e) => setDraft({ ...draft, independenceGroupId: e.target.value })}
                    style={{ maxWidth: 220 }}
                  />
                </label>
              </div>

              <p className="tiny dim">
                {telegram.profiles.find((p) => p.id === draft.profile)?.description}
              </p>

              <div className="row">
                <span className="tiny dim">Mercados:</span>
                {MARKETS.map((m) => (
                  <label key={m} className="row small" style={{ gap: 5 }}>
                    <input
                      type="checkbox"
                      style={{ width: 'auto' }}
                      checked={draft.markets.includes(m)}
                      onChange={() => toggleMarket(m)}
                    />
                    {MARKET_LABEL[m]}
                  </label>
                ))}
                <label className="row small" style={{ gap: 5 }}>
                  <input
                    type="checkbox"
                    style={{ width: 'auto' }}
                    checked={draft.participatesInConvergence}
                    onChange={(e) =>
                      setDraft({ ...draft, participatesInConvergence: e.target.checked })
                    }
                  />
                  Participa da convergencia
                </label>
              </div>

              <p className="tiny dim">
                Salas que repetem a mesma origem devem compartilhar o grupo de independencia: assim
                contam como um voto so, e nao como duas confirmacoes.
              </p>

              <div className="row">
                <button
                  className="btn btn-primary btn-sm"
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      api.telegramConfigureRoom({ peerId: room.peerId, ...draft }),
                    ).then((r) => r.ok && setEditing(null))
                  }
                >
                  Salvar
                </button>
                <button className="btn btn-sm" onClick={() => setEditing(null)}>
                  Cancelar
                </button>
                <button
                  className="btn btn-sm btn-danger"
                  disabled={busy}
                  onClick={() => void run(() => api.telegramRemoveRoom(room.peerId))}
                >
                  Remover sala
                </button>
                <span className="tiny dim">
                  Remover tira a sala da integracao. O historico de atividade permanece.
                </span>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// --- Area 3: atividade de recebimento ---------------------------------------

function Atividade({
  telegram,
  now,
  filter,
  setFilter,
  detail,
  setDetail,
}: {
  telegram: TelegramState;
  now: string;
  filter: string;
  setFilter: (v: string) => void;
  detail: TelegramActivity | null;
  setDetail: (v: TelegramActivity | null) => void;
}) {
  const entries = telegram.activity.filter((a) => filter === 'TODAS' || a.peerId === filter);

  return (
    <Card
      title="Atividade de recebimento"
      aside={
        <select value={filter} onChange={(e) => setFilter(e.target.value)} style={{ maxWidth: 220 }}>
          <option value="TODAS">Todas as salas</option>
          {telegram.rooms.map((room) => (
            <option key={room.peerId} value={room.peerId}>
              {room.displayName}
            </option>
          ))}
        </select>
      }
      tight
    >
      {entries.length === 0 ? (
        <Empty>
          {telegram.monitoredCount === 0
            ? 'Nenhuma sala monitorada ainda.'
            : 'Conectado, sem mensagens novas nas salas monitoradas.'}
        </Empty>
      ) : (
        <div className="log">
          {entries.map((entry) => (
            <div key={entry.id} className="log-row">
              <span className="log-time">{clock(entry.at)}</span>
              <span className={`log-bar log-${entry.severity}`} />
              <div>
                <div className="log-title">
                  {entry.title}
                  <span className="tiny dim"> · {ACTIVITY_LABEL[entry.kind] ?? entry.kind}</span>
                  {entry.marketId && (
                    <>
                      {' '}
                      <MarketChip marketId={entry.marketId} />
                    </>
                  )}
                  {entry.messageVersion > 1 && (
                    <span className="tiny dim num"> v{entry.messageVersion}</span>
                  )}
                </div>
                <div className="log-detail small">{entry.detail}</div>
                {entry.originalText && (
                  <button
                    className="btn btn-sm"
                    style={{ marginTop: 6 }}
                    onClick={() => setDetail(detail?.id === entry.id ? null : entry)}
                  >
                    {detail?.id === entry.id ? 'Ocultar mensagem' : 'Ver mensagem e leitura'}
                  </button>
                )}
                {detail?.id === entry.id && <ComparacaoOriginal entry={entry} now={now} />}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/** Mensagem original de um lado, campos lidos do outro. */
function ComparacaoOriginal({ entry, now }: { entry: TelegramActivity; now: string }) {
  const parsed = entry.parsed ?? {};
  return (
    <div className="grid grid-2" style={{ marginTop: 8, gap: 12 }}>
      <div>
        <div className="tiny dim">Mensagem como chegou</div>
        <pre className="tiny" style={{ whiteSpace: 'pre-wrap', margin: '4px 0' }}>
          {entry.originalText}
        </pre>
        <div className="tiny dim">
          Publicada {entry.publishedAt ? dateTime(entry.publishedAt) : 'sem horario informado'} ·
          recebida {dateTime(entry.receivedAt)} ({relative(entry.receivedAt, now)})
          {entry.messageId != null && <> · mensagem {entry.messageId}</>}
        </div>
      </div>
      <div>
        <div className="tiny dim">O que foi lido</div>
        <dl className="param-note" style={{ marginTop: 4 }}>
          {Object.entries(PARSED_FIELD_LABEL).map(([key, label]) =>
            parsed[key] == null ? null : (
              <div key={key} style={{ display: 'contents' }}>
                <dt>{label}</dt>
                <dd className="small">{String(parsed[key])}</dd>
              </div>
            ),
          )}
        </dl>
        {Array.isArray(parsed.notes) && parsed.notes.length > 0 && (
          <p className="tiny dim">{parsed.notes.join(' ')}</p>
        )}
        {entry.signalId && <p className="tiny dim">Sinal {entry.signalId}</p>}
      </div>
    </div>
  );
}

/**
 * Resumo compacto para a Home. Separa "conectado sem mensagens novas" de
 * "desconectado": sao situacoes diferentes e nao podem parecer a mesma coisa.
 */
export function TelegramResumo({
  telegram,
  now,
  onGerenciar,
}: {
  telegram: TelegramState | null;
  now: string;
  onGerenciar: () => void;
}) {
  if (!telegram) return null;

  const conectado = telegram.state === 'CONECTADO';
  const semNovidade = conectado && telegram.monitoredCount > 0 && telegram.lastMessageAt == null;

  return (
    <Card
      title="Telegram"
      aside={
        <Badge tone={STATE_TONE[telegram.state] ?? 'neutral'}>
          {STATE_LABEL[telegram.state] ?? telegram.state}
        </Badge>
      }
    >
      {!telegram.configured ? (
        <p className="small">
          Configuracao pendente. {telegram.setupHint}
        </p>
      ) : !conectado ? (
        <p className="small">
          Conta desconectada: nenhuma sala esta sendo lida agora.
          {telegram.error && <span className="dim"> {telegram.error.message}</span>}
        </p>
      ) : (
        <div className="stack-sm">
          <div className="row">
            <span className="figure-sm num">{telegram.monitoredCount}</span>
            <span className="small dim">
              sala(s) monitorada(s) de {telegram.configuredCount} cadastrada(s)
            </span>
          </div>
          <p className="small">
            {semNovidade ? (
              <>Conectado, sem mensagens novas nas salas monitoradas.</>
            ) : (
              <>
                Ultima mensagem {relative(telegram.lastMessageAt, now)} · ultimo sinal valido{' '}
                {relative(telegram.lastSignalAt, now)}.
              </>
            )}
          </p>
        </div>
      )}
      <div style={{ marginTop: 10 }}>
        <button className="btn btn-sm" onClick={onGerenciar}>
          Gerenciar Telegram
        </button>
      </div>
    </Card>
  );
}
