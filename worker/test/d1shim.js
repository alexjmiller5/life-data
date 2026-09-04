// Minimal D1-shaped wrapper over bun:sqlite, so hub logic (validate.js,
// index.js routes) can be tested locally without a real D1 binding.
import { Database } from "bun:sqlite";

export class D1Shim {
  constructor(path = ":memory:") {
    this.db = new Database(path);
  }
  prepare(sql) {
    const stmt = this.db.query(sql);
    let args = [];
    return {
      bind(...a) { args = a; return this; },
      async all() { return { results: stmt.all(...args) }; },
      async first() { return stmt.get(...args) ?? null; },
      async run() { stmt.run(...args); return {}; },
    };
  }
  // D1's batch: every statement in one transaction, in order.
  async batch(stmts) {
    this.db.exec("BEGIN");
    try {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}
