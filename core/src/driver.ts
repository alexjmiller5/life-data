import type { Row } from './validate.ts';

export type Value = string | number | null;
/** Adapters serialize callers and provide real BEGIN IMMEDIATE/COMMIT/ROLLBACK.
 * Native hosts also hold the CLI's <database>.sync.lock around sync().
 * Browser hosts use a Web Lock for the database across tabs. */
export interface SqlDriver {
  /** Execute one read-only statement. Reject extra statements and read-side writes. */
  all(sql: string, params?: Value[]): Promise<Row[]>;
  run(sql: string, params?: Value[]): Promise<number>;
  transaction<T>(body: () => Promise<T>): Promise<T>;
}
export interface Hub {
  /** Canonical endpoint identity; a replica cannot switch datasets. */
  endpoint: string;
  post(route: string, body: Row): Promise<{ data: unknown; date?: string }>;
}
