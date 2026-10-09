import type { Row } from './validate.ts';

export type Value = string | number | null;
export type SqlReadStatement = { sql: string; params?: Value[] };
export type SqlReadContext = { ownedTempTables: readonly string[] };
/** Core bounds preparation work; sqlLength counts UTF-16 code units (JS length).
 * Native adapters can rely on this trusted caller limit instead of duplicating it. */
export const READ_DEPENDENCY_LIMITS = Object.freeze({ statements: 128, sqlLength: 524_288, tables: 4096 });
/** Adapters serialize callers and provide real BEGIN IMMEDIATE/COMMIT/ROLLBACK.
 * Native hosts also hold the CLI's <database>.sync.lock around sync().
 * Browser hosts use a Web Lock for the database across tabs. */
export interface SqlDriver {
  /** Execute one read-only statement. Reject extra statements and read-side writes. */
  all(sql: string, params?: Value[]): Promise<Row[]>;
  run(sql: string, params?: Value[]): Promise<number>;
  transaction<T>(body: () => Promise<T>): Promise<T>;
  /** Prepare fresh read-only statements without stepping, on this transaction's
   * connection. Return the conservative union of ordinary main table reads,
   * expanding views. Never parse SQL to infer dependencies. null means the
   * complete set cannot be established; core fails closed. If absent, core
   * retains full-global coverage. context asserts TEMP tables created by the
   * trusted core in this transaction, not permission inferred from their names.
   * See tests/fixtures/read-dependencies.json and core/README.md for conformance. */
  readDependencies?(statements: readonly SqlReadStatement[], context: SqlReadContext): Promise<{ tables: string[] } | null>;
}
/** Where a sync round stands: tables finished out of the round's tables, and
 * rows received out of the rows its full pulls expect (null when the round only
 * pulls changes, whose size is unknown). `table` is the table being pulled. */
export type SyncProgress = { tablesDone: number; tablesTotal: number; rowsReceived: number; rowsExpected: number | null; table: string | null };
export interface Hub {
  /** Canonical endpoint identity; a replica cannot switch datasets. */
  endpoint: string;
  post(route: string, body: Row): Promise<{ data: unknown; date?: string }>;
  /** Optional: told as a sync round advances, for host status. */
  progress?(state: SyncProgress): void;
}
