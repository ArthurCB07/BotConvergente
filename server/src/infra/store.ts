import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { getInstrument } from '../core/instruments.ts';
import type {
  AuditEvent,
  MarketId,
  Opportunity,
  Order,
  Position,
  Signal,
  Source,
} from '../core/types.ts';
import type { TelegramActivity, TelegramRoom } from '../telegram/types.ts';

/**
 * Persistencia em SQLite, via modulo nativo `node:sqlite`. Sem dependencia nativa
 * para compilar, o que evita exigir ferramentas de build no Windows.
 *
 * Formato das tabelas: colunas indexaveis para o que se consulta (data, situacao,
 * mercado, instrumento) mais uma coluna `data` com o registro completo em JSON.
 *
 * O esquema tem versao. `SCHEMA_VERSION` sobe quando as colunas indexadas ou o
 * formato do JSON mudam, e cada passo de migracao roda uma vez, em ordem.
 */

export const SCHEMA_VERSION = 3;

/** Quantidade maxima de eventos e sinais mantidos em disco. */
const EVENT_RETENTION = 5000;
const SIGNAL_RETENTION = 5000;
const TELEGRAM_ACTIVITY_RETENTION = 2000;

/*
 * Tabelas e indices sao aplicados em momentos diferentes: os indices da versao 2
 * referenciam colunas que so existem apos a migracao, entao eles rodam DEPOIS dela.
 */
const SCHEMA_TABLES = `
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
  markets TEXT NOT NULL DEFAULT '',
  independence_group_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS signals (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  market_id TEXT NOT NULL DEFAULT 'FOREX',
  product_type TEXT NOT NULL DEFAULT 'FX_SPOT',
  symbol TEXT,
  venue TEXT,
  side TEXT,
  status TEXT NOT NULL,
  received_at TEXT NOT NULL,
  external_message_id TEXT,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS opportunities (
  id TEXT PRIMARY KEY,
  cluster_key TEXT NOT NULL,
  market_id TEXT NOT NULL DEFAULT 'FOREX',
  product_type TEXT NOT NULL DEFAULT 'FX_SPOT',
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

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  client_order_id TEXT NOT NULL,
  market_id TEXT NOT NULL DEFAULT 'FOREX',
  account_id TEXT NOT NULL DEFAULT '',
  opportunity_id TEXT,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS positions (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  market_id TEXT NOT NULL DEFAULT 'FOREX',
  account_id TEXT NOT NULL DEFAULT '',
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

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL,
  market_id TEXT,
  title TEXT NOT NULL,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS telegram_rooms (
  peer_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  markets TEXT NOT NULL DEFAULT '',
  monitoring INTEGER NOT NULL DEFAULT 0,
  source_id TEXT,
  created_at TEXT NOT NULL,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS telegram_activity (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL,
  peer_id TEXT,
  market_id TEXT,
  data TEXT NOT NULL
);
`;

const SCHEMA_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_signals_received ON signals (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_market ON signals (market_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_opportunities_created ON opportunities (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_opportunities_market ON opportunities (market_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_client ON orders (client_order_id);
CREATE INDEX IF NOT EXISTS idx_orders_market ON orders (market_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_positions_status ON positions (status, opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_positions_market ON positions (market_id, opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_at ON events (at DESC);
CREATE INDEX IF NOT EXISTS idx_telegram_activity_at ON telegram_activity (at DESC);
CREATE INDEX IF NOT EXISTS idx_telegram_activity_peer ON telegram_activity (peer_id, at DESC);
`;

/** Relatorio da migracao, para o motor poder avisar o usuario. */
export interface MigrationReport {
  fromVersion: number;
  toVersion: number;
  sourcesMigrated: number;
  sourcesNeedingClassification: string[];
  signalsMigrated: number;
  recordsMigrated: number;
}

export class Store {
  private db: DatabaseSync;
  readonly path: string;
  /** Preenchido quando uma migracao rodou nesta abertura. */
  lastMigration: MigrationReport | null = null;

  constructor(path: string) {
    this.path = path;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA_TABLES);
    this.applyMigrations();
    this.db.exec(SCHEMA_INDEXES);
  }

  private columnExists(table: string, column: string): boolean {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.some((r) => r.name === column);
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    if (!this.columnExists(table, column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
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

    if (row.version < 2) this.migrateV1ToV2();
    /*
     * v2 -> v3: entraram as tabelas `telegram_rooms` e `telegram_activity`. Elas sao
     * criadas por `CREATE TABLE IF NOT EXISTS` antes daqui, entao nao ha dado a
     * converter: nenhuma tabela existente muda de formato.
     */

    if (row.version < SCHEMA_VERSION) {
      this.db.prepare('UPDATE schema_meta SET version = ? WHERE id = 1').run(SCHEMA_VERSION);
    }
  }

  /**
   * v1 -> v2: o produto passou de um mercado (forex) para dois (forex e cripto).
   *
   * Toda a base v1 e de forex, entao fontes, sinais, oportunidades, ordens e
   * posicoes existentes vao para FOREX com os dados preservados. Registros cujo
   * instrumento nao esta no catalogo NAO sao descartados: a fonte correspondente
   * fica sem mercado classificado e a interface pede a classificacao.
   */
  private migrateV1ToV2(): void {
    const report: MigrationReport = {
      fromVersion: 1,
      toVersion: 2,
      sourcesMigrated: 0,
      sourcesNeedingClassification: [],
      signalsMigrated: 0,
      recordsMigrated: 0,
    };

    // Colunas novas em bancos que ja existiam.
    this.addColumnIfMissing('sources', 'markets', "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing('signals', 'market_id', "TEXT NOT NULL DEFAULT 'FOREX'");
    this.addColumnIfMissing('signals', 'product_type', "TEXT NOT NULL DEFAULT 'FX_SPOT'");
    this.addColumnIfMissing('opportunities', 'market_id', "TEXT NOT NULL DEFAULT 'FOREX'");
    this.addColumnIfMissing('opportunities', 'product_type', "TEXT NOT NULL DEFAULT 'FX_SPOT'");
    this.addColumnIfMissing('orders', 'market_id', "TEXT NOT NULL DEFAULT 'FOREX'");
    this.addColumnIfMissing('orders', 'account_id', "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing('positions', 'market_id', "TEXT NOT NULL DEFAULT 'FOREX'");
    this.addColumnIfMissing('positions', 'account_id', "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing('events', 'market_id', 'TEXT');

    const marketOf = (symbol: string | null | undefined): MarketId | null => {
      if (!symbol) return null;
      return getInstrument(symbol)?.marketId ?? null;
    };
    const productOf = (symbol: string | null | undefined): string =>
      (symbol && getInstrument(symbol)?.productType) || 'FX_SPOT';

    this.transaction(() => {
      // --- Fontes -----------------------------------------------------------
      const sourceRows = this.db.prepare('SELECT id, data FROM sources').all() as Array<{
        id: string;
        data: string;
      }>;
      for (const sourceRow of sourceRows) {
        const source = JSON.parse(sourceRow.data) as Record<string, unknown> & { weight?: number };

        // Os simbolos ja vistos por esta fonte dizem a que mercado ela pertence.
        const symbolRows = this.db
          .prepare('SELECT DISTINCT symbol FROM signals WHERE source_id = ?')
          .all(sourceRow.id) as Array<{ symbol: string | null }>;
        const knownMarkets = new Set<MarketId>();
        let sawUnknownSymbol = false;
        for (const { symbol } of symbolRows) {
          const market = marketOf(symbol);
          if (market) knownMarkets.add(market);
          else if (symbol) sawUnknownSymbol = true;
        }

        let markets: MarketId[];
        if (knownMarkets.size > 0) {
          markets = [...knownMarkets];
        } else if (sawUnknownSymbol) {
          // Origem incerta: preserva tudo e pede classificacao ao usuario.
          markets = [];
          report.sourcesNeedingClassification.push(String(source.name ?? sourceRow.id));
        } else {
          // Sem historico de sinais: a base v1 era exclusivamente de forex.
          markets = ['FOREX'];
        }

        const weight = typeof source.weight === 'number' ? source.weight : 1;
        const migrated = {
          ...source,
          markets,
          weightByMarket: { FOREX: weight, CRYPTO: weight },
        };
        delete (migrated as Record<string, unknown>).weight;

        this.db
          .prepare('UPDATE sources SET markets = ?, data = ? WHERE id = ?')
          .run(markets.join(','), JSON.stringify(migrated), sourceRow.id);
        report.sourcesMigrated += 1;
      }

      // --- Sinais -----------------------------------------------------------
      const signalRows = this.db.prepare('SELECT id, symbol, data FROM signals').all() as Array<{
        id: string;
        symbol: string | null;
        data: string;
      }>;
      for (const signalRow of signalRows) {
        const signal = JSON.parse(signalRow.data) as Record<string, unknown>;
        const marketId = marketOf(signalRow.symbol) ?? 'FOREX';
        const productType = productOf(signalRow.symbol);
        const instrument = signalRow.symbol ? getInstrument(signalRow.symbol) : undefined;
        const migrated = {
          ...signal,
          marketId,
          productType,
          quoteCurrency: instrument?.quote ?? 'USD',
        };
        delete (migrated as Record<string, unknown>).market;
        this.db
          .prepare('UPDATE signals SET market_id = ?, product_type = ?, data = ? WHERE id = ?')
          .run(marketId, productType, JSON.stringify(migrated), signalRow.id);
        report.signalsMigrated += 1;
      }

      // --- Oportunidades ----------------------------------------------------
      const opportunityRows = this.db
        .prepare('SELECT id, symbol, cluster_key, data FROM opportunities')
        .all() as Array<{ id: string; symbol: string; cluster_key: string; data: string }>;
      for (const opportunityRow of opportunityRows) {
        const opportunity = JSON.parse(opportunityRow.data) as Record<string, unknown>;
        const marketId = marketOf(opportunityRow.symbol) ?? 'FOREX';
        const productType = productOf(opportunityRow.symbol);
        const instrument = getInstrument(opportunityRow.symbol);
        // A chave de agrupamento ganhou mercado e produto no prefixo.
        const clusterKey = `${marketId}|${productType}|${opportunityRow.symbol}|${(opportunity.venue as string) ?? 'REGULAR'}|${(opportunity.side as string) ?? 'BUY'}`;
        const migrated = {
          ...opportunity,
          marketId,
          productType,
          clusterKey,
          quoteCurrency: instrument?.quote ?? 'USD',
          denominatorMode: 'COMPARABLE_SIGNALS',
          denominatorRule: 'Base: fontes com sinal valido e comparavel na janela (registro migrado da versao 1).',
        };
        delete (migrated as Record<string, unknown>).market;
        this.db
          .prepare(
            'UPDATE opportunities SET market_id = ?, product_type = ?, cluster_key = ?, data = ? WHERE id = ?',
          )
          .run(marketId, productType, clusterKey, JSON.stringify(migrated), opportunityRow.id);
        report.recordsMigrated += 1;
      }

      // --- Ordens e posicoes: `lots` virou `quantity` ------------------------
      const orderRows = this.db.prepare('SELECT id, symbol, data FROM orders').all() as Array<{
        id: string;
        symbol: string;
        data: string;
      }>;
      for (const orderRow of orderRows) {
        const order = JSON.parse(orderRow.data) as Record<string, unknown> & { lots?: number };
        const marketId = marketOf(orderRow.symbol) ?? 'FOREX';
        const instrument = getInstrument(orderRow.symbol);
        const migrated = {
          ...order,
          marketId,
          productType: productOf(orderRow.symbol),
          accountId: 'SIM-PAPER',
          brokerId: 'paper',
          quantity: order.quantity ?? order.lots ?? 0,
          quantityLabel: instrument?.quantityLabel ?? 'lote',
        };
        delete (migrated as Record<string, unknown>).lots;
        this.db
          .prepare('UPDATE orders SET market_id = ?, account_id = ?, data = ? WHERE id = ?')
          .run(marketId, 'SIM-PAPER', JSON.stringify(migrated), orderRow.id);
        report.recordsMigrated += 1;
      }

      const positionRows = this.db.prepare('SELECT id, symbol, data FROM positions').all() as Array<{
        id: string;
        symbol: string;
        data: string;
      }>;
      for (const positionRow of positionRows) {
        const position = JSON.parse(positionRow.data) as Record<string, unknown> & { lots?: number };
        const marketId = marketOf(positionRow.symbol) ?? 'FOREX';
        const instrument = getInstrument(positionRow.symbol);
        const migrated = {
          ...position,
          marketId,
          productType: productOf(positionRow.symbol),
          accountId: 'SIM-PAPER',
          brokerId: 'paper',
          quantity: position.quantity ?? position.lots ?? 0,
          quantityLabel: instrument?.quantityLabel ?? 'lote',
        };
        delete (migrated as Record<string, unknown>).lots;
        this.db
          .prepare('UPDATE positions SET market_id = ?, account_id = ?, data = ? WHERE id = ?')
          .run(marketId, 'SIM-PAPER', JSON.stringify(migrated), positionRow.id);
        report.recordsMigrated += 1;
      }

      // --- Eventos ----------------------------------------------------------
      const eventRows = this.db.prepare('SELECT id, data FROM events').all() as Array<{
        id: string;
        data: string;
      }>;
      for (const eventRow of eventRows) {
        const event = JSON.parse(eventRow.data) as Record<string, unknown>;
        const migrated = { ...event, marketId: event.marketId ?? 'FOREX' };
        this.db
          .prepare('UPDATE events SET market_id = ?, data = ? WHERE id = ?')
          .run('FOREX', JSON.stringify(migrated), eventRow.id);
      }

      // --- Chave e valor: configuracoes globais viram configuracoes de FOREX --
      const move = (from: string, to: string, transform?: (v: unknown) => unknown) => {
        const found = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(from) as
          | { value: string }
          | undefined;
        if (!found) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(found.value);
        } catch {
          return;
        }
        const next = transform ? transform(parsed) : parsed;
        this.db
          .prepare(
            `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          )
          .run(to, JSON.stringify(next), new Date().toISOString());
        this.db.prepare('DELETE FROM kv WHERE key = ?').run(from);
      };

      move('settings.convergence', 'settings.convergence.FOREX', (v) => ({
        ...(v as object),
        denominatorMode: 'COMPARABLE_SIGNALS',
        allowedSymbols: null,
      }));
      move('settings.risk', 'settings.risk.FOREX', (v) => {
        const risk = v as Record<string, unknown>;
        const next: Record<string, unknown> = {
          ...risk,
          fixedQuantity: risk.fixedQuantity ?? risk.fixedLots ?? 0.05,
        };
        delete next.fixedLots;
        if (next.sizingMode === 'FIXED_LOTS') next.sizingMode = 'FIXED_QUANTITY';
        return next;
      });
      move('runtime.day', 'runtime.day.FOREX');
      move('runtime.mode', 'runtime.market.FOREX', (v) => ({
        mode: v,
        // Automacao nasce desligada: o usuario liga conscientemente cada mercado.
        automationEnabled: false,
        accountId: 'paper',
      }));
      this.db.prepare('DELETE FROM kv WHERE key = ?').run('runtime.automationPaused');
    });

    this.lastMigration = report;
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
        `INSERT INTO sources (id, name, kind, enabled, markets, independence_group_id, created_at, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           kind = excluded.kind,
           enabled = excluded.enabled,
           markets = excluded.markets,
           independence_group_id = excluded.independence_group_id,
           data = excluded.data`,
      )
      .run(
        source.id,
        source.name,
        source.kind,
        source.enabled ? 1 : 0,
        source.markets.join(','),
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
        `INSERT INTO signals (id, source_id, market_id, product_type, symbol, venue, side, status, received_at, external_message_id, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           received_at = excluded.received_at,
           data = excluded.data`,
      )
      .run(
        signal.id,
        signal.sourceId,
        signal.marketId,
        signal.productType,
        signal.symbol,
        signal.venue,
        signal.side,
        signal.status,
        signal.receivedAt,
        signal.raw.externalMessageId,
        JSON.stringify(signal),
      );
  }

  loadSignals(limit = 600): Signal[] {
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
           (id, cluster_key, market_id, product_type, symbol, venue, side, status, version, agreement_percent, created_at, valid_until, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        opportunity.marketId,
        opportunity.productType,
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

  loadOpportunities(limit = 240): Opportunity[] {
    const rows = this.db
      .prepare('SELECT data FROM opportunities ORDER BY created_at DESC LIMIT ?')
      .all(limit) as Array<{ data: string }>;
    return rows.map((r) => JSON.parse(r.data) as Opportunity);
  }

  // --- Ordens ---------------------------------------------------------------

  saveOrder(order: Order): void {
    this.db
      .prepare(
        `INSERT INTO orders (id, client_order_id, market_id, account_id, opportunity_id, symbol, side, status, created_at, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           data = excluded.data`,
      )
      .run(
        order.id,
        order.clientOrderId,
        order.marketId,
        order.accountId,
        order.opportunityId,
        order.symbol,
        order.side,
        order.status,
        order.createdAt,
        JSON.stringify(order),
      );
  }

  loadOrders(limit = 240): Order[] {
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
           (id, order_id, market_id, account_id, opportunity_id, symbol, side, status, opened_at, closed_at, close_reason, net_pnl, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        position.marketId,
        position.accountId,
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
        `INSERT INTO events (id, at, kind, severity, market_id, title, data)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        event.id,
        event.at,
        event.kind,
        event.severity,
        event.marketId,
        event.title,
        JSON.stringify(event),
      );
  }

  loadEvents(limit = 400): AuditEvent[] {
    const rows = this.db
      .prepare('SELECT data FROM events ORDER BY at DESC, rowid DESC LIMIT ?')
      .all(limit) as Array<{ data: string }>;
    return rows.map((r) => JSON.parse(r.data) as AuditEvent);
  }

  // --- Telegram -------------------------------------------------------------

  saveTelegramRoom(room: TelegramRoom): void {
    this.db
      .prepare(
        `INSERT INTO telegram_rooms (peer_id, title, markets, monitoring, source_id, created_at, data)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(peer_id) DO UPDATE SET
           title = excluded.title,
           markets = excluded.markets,
           monitoring = excluded.monitoring,
           source_id = excluded.source_id,
           data = excluded.data`,
      )
      .run(
        room.peerId,
        room.title,
        room.markets.join(','),
        room.monitoring ? 1 : 0,
        room.sourceId,
        room.createdAt,
        JSON.stringify(room),
      );
  }

  deleteTelegramRoom(peerId: string): void {
    this.db.prepare('DELETE FROM telegram_rooms WHERE peer_id = ?').run(peerId);
  }

  loadTelegramRooms(): TelegramRoom[] {
    const rows = this.db
      .prepare('SELECT data FROM telegram_rooms ORDER BY created_at ASC')
      .all() as Array<{ data: string }>;
    return rows.map((r) => JSON.parse(r.data) as TelegramRoom);
  }

  saveTelegramActivity(entry: TelegramActivity): void {
    this.db
      .prepare(
        `INSERT INTO telegram_activity (id, at, kind, severity, peer_id, market_id, data)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(entry.id, entry.at, entry.kind, entry.severity, entry.peerId, entry.marketId, JSON.stringify(entry));
  }

  loadTelegramActivity(limit = 200, peerId?: string): TelegramActivity[] {
    const rows = peerId
      ? (this.db
          .prepare('SELECT data FROM telegram_activity WHERE peer_id = ? ORDER BY at DESC, rowid DESC LIMIT ?')
          .all(peerId, limit) as Array<{ data: string }>)
      : (this.db
          .prepare('SELECT data FROM telegram_activity ORDER BY at DESC, rowid DESC LIMIT ?')
          .all(limit) as Array<{ data: string }>);
    return rows.map((r) => JSON.parse(r.data) as TelegramActivity);
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

  remove(key: string): void {
    this.db.prepare('DELETE FROM kv WHERE key = ?').run(key);
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
    this.db
      .prepare(
        `DELETE FROM telegram_activity WHERE id NOT IN (
           SELECT id FROM telegram_activity ORDER BY at DESC, rowid DESC LIMIT ?
         )`,
      )
      .run(TELEGRAM_ACTIVITY_RETENTION);
  }

  /**
   * Reinicia o ambiente de simulacao.
   *
   * A conexao do Telegram NAO e um dado de simulacao: a sessao autenticada e as
   * salas escolhidas sobrevivem ao reinicio, senao reiniciar o ambiente exigiria
   * um novo login. As fontes somem junto com o resto, entao cada sala perde o
   * vinculo com a fonte e recria na proxima mensagem.
   */
  wipe(): void {
    this.transaction(() => {
      for (const table of ['sources', 'signals', 'opportunities', 'orders', 'positions', 'events']) {
        this.db.prepare(`DELETE FROM ${table}`).run();
      }
      this.db.prepare("DELETE FROM kv WHERE key NOT LIKE 'telegram.%'").run();

      const rows = this.db.prepare('SELECT peer_id, data FROM telegram_rooms').all() as Array<{
        peer_id: string;
        data: string;
      }>;
      for (const row of rows) {
        const room = { ...(JSON.parse(row.data) as TelegramRoom), sourceId: null };
        this.db
          .prepare('UPDATE telegram_rooms SET source_id = NULL, data = ? WHERE peer_id = ?')
          .run(JSON.stringify(room), row.peer_id);
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

  /** Contagem por mercado, util para conferir a separacao. */
  countsByMarket(): Record<string, Record<string, number>> {
    const result: Record<string, Record<string, number>> = {};
    for (const table of ['signals', 'opportunities', 'orders', 'positions']) {
      const rows = this.db
        .prepare(`SELECT market_id AS m, COUNT(*) AS n FROM ${table} GROUP BY market_id`)
        .all() as Array<{ m: string; n: number }>;
      result[table] = Object.fromEntries(rows.map((r) => [r.m, r.n]));
    }
    return result;
  }
}
