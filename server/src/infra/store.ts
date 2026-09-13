import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  AuditEvent,
  Opportunity,
  Order,
  Position,
  Signal,
  Source,
} from '../core/types.ts';

/**
 * Persistencia em SQLite, via modulo nativo `node:sqlite`. Sem dependencia nativa
 * para compilar, o que evita exigir ferramentas de build no Windows.
 *
 * Formato das tabelas: colunas indexaveis para o que se consulta (data, situacao,
 * instrumento) mais uma coluna `data` com o registro completo em JSON. E um meio
 * termo deliberado: mantem o modelo de dominio livre para evoluir sem migracao a
 * cada campo novo, e ainda permite consulta e relatorio por SQL.
 *
 * O esquema tem versao. `SCHEMA_VERSION` sobe quando as colunas indexadas mudam.
 */

export const SCHEMA_VERSION = 1;

/** Quantidade maxima de eventos e sinais mantidos em disco. */
const EVENT_RETENTION = 5000;
const SIGNAL_RETENTION = 5000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  independence_group_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS signals (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  symbol TEXT,
  venue TEXT,
  side TEXT,
  status TEXT NOT NULL,
  received_at TEXT NOT NULL,
  external_message_id TEXT,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_signals_received ON signals (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_source ON signals (source_id, received_at DESC);

CREATE TABLE IF NOT EXISTS opportunities (
  id TEXT PRIMARY KEY,
  cluster_key TEXT NOT NULL,
  symbol TEXT NOT NULL,
  venue TEXT NOT NULL,
  side TEXT NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL,
  agreement_percent REAL NOT NULL,
  created_at TEXT NOT NULL,
  valid_until TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_opportunities_created ON opportunities (created_at DESC);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  client_order_id TEXT NOT NULL,
  opportunity_id TEXT,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_client ON orders (client_order_id);

CREATE TABLE IF NOT EXISTS positions (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  opportunity_id TEXT,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  status TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  close_reason TEXT,
  net_pnl REAL NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_positions_status ON positions (status, opened_at DESC);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_at ON events (at DESC);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export class Store {
  private db: DatabaseSync;
  readonly path: string;

  constructor(path: string) {
    this.path = path;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA);
    this.applyMigrations();
  }

  private applyMigrations(): void {
    const row = this.db.prepare('SELECT version FROM schema_meta WHERE id = 1').get() as
      | { version: number }
      | undefined;

    if (!row) {
      this.db
        .prepare('INSERT INTO schema_meta (id, version, created_at) VALUES (1, ?, ?)')
        .run(SCHEMA_VERSION, new Date().toISOString());
      return;
    }

    if (row.version > SCHEMA_VERSION) {
      // Fecha antes de falhar: senao o arquivo fica preso ate o processo terminar.
      this.db.close();
      throw new Error(
        `Banco na versao ${row.version}, mais nova que a versao ${SCHEMA_VERSION} suportada por este codigo. Atualize a aplicacao ou use outro arquivo.`,
      );
    }

    /*
     * Migracoes futuras entram aqui, uma por versao, em ordem crescente. Enquanto
     * so existe a versao 1 nao ha passo a executar.
     */
    if (row.version < SCHEMA_VERSION) {
      this.db.prepare('UPDATE schema_meta SET version = ? WHERE id = 1').run(SCHEMA_VERSION);
    }
  }

  close(): void {
    this.db.close();
  }

  /** Executa varias escritas em uma transacao. */
  transaction(fn: () => void): void {
    this.db.exec('BEGIN');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // --- Fontes ---------------------------------------------------------------

  saveSource(source: Source): void {
    this.db
      .prepare(
        `INSERT INTO sources (id, name, kind, enabled, independence_group_id, created_at, data)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           kind = excluded.kind,
           enabled = excluded.enabled,
           independence_group_id = excluded.independence_group_id,
           data = excluded.data`,
      )
      .run(
        source.id,
        source.name,
        source.kind,
        source.enabled ? 1 : 0,
        source.independenceGroupId,
        source.createdAt,
        JSON.stringify(source),
      );
  }

  deleteSource(sourceId: string): void {
    this.db.prepare('DELETE FROM sources WHERE id = ?').run(sourceId);
  }

  loadSources(): Source[] {
    const rows = this.db
      .prepare('SELECT data FROM sources ORDER BY created_at ASC')
      .all() as Array<{ data: string }>;
    return rows.map((r) => JSON.parse(r.data) as Source);
  }

  // --- Sinais ---------------------------------------------------------------

  saveSignal(signal: Signal): void {
    this.db
      .prepare(
        `INSERT INTO signals (id, source_id, symbol, venue, side, status, received_at, external_message_id, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           received_at = excluded.received_at,
           data = excluded.data`,
      )
      .run(
        signal.id,
        signal.sourceId,
        signal.symbol,
        signal.venue,
        signal.side,
        signal.status,
        signal.receivedAt,
        signal.raw.externalMessageId,
        JSON.stringify(signal),
      );
  }

  loadSignals(limit = 500): Signal[] {
    const rows = this.db
      .prepare('SELECT data FROM signals ORDER BY received_at DESC LIMIT ?')
      .all(limit) as Array<{ data: string }>;
    return rows.map((r) => JSON.parse(r.data) as Signal);
  }

  // --- Oportunidades --------------------------------------------------------

  saveOpportunity(opportunity: Opportunity): void {
    this.db
      .prepare(
        `INSERT INTO opportunities
           (id, cluster_key, symbol, venue, side, status, version, agreement_percent, created_at, valid_until, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           version = excluded.version,
           agreement_percent = excluded.agreement_percent,
           valid_until = excluded.valid_until,
           data = excluded.data`,
      )
      .run(
        opportunity.id,
        opportunity.clusterKey,
        opportunity.symbol,
        opportunity.venue,
        opportunity.side,
        opportunity.status,
        opportunity.version,
        opportunity.agreementPercent,
        opportunity.createdAt,
        opportunity.validUntil,
        JSON.stringify(opportunity),
      );
  }

  loadOpportunities(limit = 200): Opportunity[] {
    const rows = this.db
      .prepare('SELECT data FROM opportunities ORDER BY created_at DESC LIMIT ?')
      .all(limit) as Array<{ data: string }>;
    return rows.map((r) => JSON.parse(r.data) as Opportunity);
  }

  // --- Ordens ---------------------------------------------------------------

  saveOrder(order: Order): void {
    this.db
      .prepare(
        `INSERT INTO orders (id, client_order_id, opportunity_id, symbol, side, status, created_at, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           data = excluded.data`,
      )
      .run(
        order.id,
        order.clientOrderId,
        order.opportunityId,
        order.symbol,
        order.side,
        order.status,
        order.createdAt,
        JSON.stringify(order),
      );
  }

  loadOrders(limit = 200): Order[] {
    const rows = this.db
      .prepare('SELECT data FROM orders ORDER BY created_at DESC LIMIT ?')
      .all(limit) as Array<{ data: string }>;
    return rows.map((r) => JSON.parse(r.data) as Order);
  }

  // --- Posicoes -------------------------------------------------------------

  savePosition(position: Position): void {
    this.db
      .prepare(
        `INSERT INTO positions
           (id, order_id, opportunity_id, symbol, side, status, opened_at, closed_at, close_reason, net_pnl, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           opportunity_id = excluded.opportunity_id,
           status = excluded.status,
           closed_at = excluded.closed_at,
           close_reason = excluded.close_reason,
           net_pnl = excluded.net_pnl,
           data = excluded.data`,
      )
      .run(
        position.id,
        position.orderId,
        position.opportunityId,
        position.symbol,
        position.side,
        position.status,
        position.openedAt,
        position.closedAt,
        position.closeReason,
        position.netPnl,
        JSON.stringify(position),
      );
  }

  loadPositions(): Position[] {
    const rows = this.db
      .prepare('SELECT data FROM positions ORDER BY opened_at ASC')
      .all() as Array<{ data: string }>;
    return rows.map((r) => JSON.parse(r.data) as Position);
  }

  // --- Eventos --------------------------------------------------------------

  saveEvent(event: AuditEvent): void {
    this.db
      .prepare(
        `INSERT INTO events (id, at, kind, severity, title, data)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(event.id, event.at, event.kind, event.severity, event.title, JSON.stringify(event));
  }

  loadEvents(limit = 300): AuditEvent[] {
    const rows = this.db
      .prepare('SELECT data FROM events ORDER BY at DESC, rowid DESC LIMIT ?')
      .all(limit) as Array<{ data: string }>;
    return rows.map((r) => JSON.parse(r.data) as AuditEvent);
  }

  // --- Chave e valor --------------------------------------------------------

  put<T>(key: string, value: T): void {
    this.db
      .prepare(
        `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), new Date().toISOString());
  }

  get<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return undefined;
    }
  }

  // --- Manutencao -----------------------------------------------------------

  /** Descarta registros antigos para o arquivo nao crescer sem limite. */
  prune(): void {
    this.db
      .prepare(
        `DELETE FROM events WHERE id NOT IN (
           SELECT id FROM events ORDER BY at DESC, rowid DESC LIMIT ?
         )`,
      )
      .run(EVENT_RETENTION);
    this.db
      .prepare(
        `DELETE FROM signals WHERE id NOT IN (
           SELECT id FROM signals ORDER BY received_at DESC LIMIT ?
         )`,
      )
      .run(SIGNAL_RETENTION);
  }

  /** Apaga tudo. Usado pelo comando de reinicio do ambiente de demonstracao. */
  wipe(): void {
    this.transaction(() => {
      for (const table of ['sources', 'signals', 'opportunities', 'orders', 'positions', 'events', 'kv']) {
        this.db.prepare(`DELETE FROM ${table}`).run();
      }
    });
  }

  counts(): Record<string, number> {
    const tables = ['sources', 'signals', 'opportunities', 'orders', 'positions', 'events'];
    const result: Record<string, number> = {};
    for (const table of tables) {
      const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      result[table] = row.n;
    }
    return result;
  }
}
