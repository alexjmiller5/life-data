// Minimal D1-shaped wrapper over bun:sqlite, so hub logic (validate.js,
// index.js routes) can be tested locally without a real D1 binding.
import { Database } from "bun:sqlite";

export class D1Shim {
  constructor(path = ":memory:") {
    this.db = new Database(path);
  }
  prepare(sql) {
    const query = () => this.db.query(sql);
    let args = [];
    return {
      bind(...a) { args = a; return this; },
      async all() { return { results: query().all(...args) }; },
      async first() { return query().get(...args) ?? null; },
      async run() { return { results: query().all(...args) }; },
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
