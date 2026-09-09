// D1 has transactional batch(), not an interactive JavaScript transaction.
// Keep preflight honest with read-set assertions inside the same batch.
import { historyPlan, historyStatements } from './history.js';
import { literal, qident, validatePush } from './validate.js';

const quoteColumn = (v) => '"' + v.replaceAll('"', '""') + '"';

export function checkedReads(db) {
  const reads = new Map();
  return {
    reads,
    prepare(sql) {
      let args = [];
      const read = async (first) => {
        const query = first ? `SELECT * FROM (${sql}) LIMIT 1` : sql;
        const key = JSON.stringify([query, args]);
        if (!reads.has(key)) {
          const { results } = await db.prepare(query).bind(...args).all();
          reads.set(key, { sql: query, args: [...args], rows: results ?? [] });
        }
        const rows = reads.get(key).rows;
        return first ? rows[0] ?? null : { results: rows };
      };
      return { bind(...values) { args = values; return this; }, all: () => read(false), first: () => read(true) };
    },
  };
}

function readGuards(db, reads, assertion) {
  return [...reads.values()].map(({ sql, args, rows }) => {
    let equal;
    if (!rows.length) equal = `NOT EXISTS (${sql})`;
    else {
      const cols = Object.keys(rows[0]);
      const expected = cols.map(c => `json_extract(value, ${literal('$."' + c + '"')}) AS ${quoteColumn(c)}`).join(',');
      equal = `WITH actual AS (${sql}), expected AS (SELECT ${expected} FROM json_each(?))
        SELECT (SELECT count(*) FROM actual) = (SELECT count(*) FROM expected)
        AND NOT EXISTS (SELECT * FROM actual EXCEPT SELECT * FROM expected)
        AND NOT EXISTS (SELECT * FROM expected EXCEPT SELECT * FROM actual)`;
    }
    return db.prepare(`INSERT INTO ${qident(assertion)} SELECT (${equal})`)
      .bind(...args, ...(rows.length ? [JSON.stringify(rows)] : []));
  });
}

export async function enforcedRules(db, table) {
  if (!await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='catalog_rules'").first()) return [];
  const { results } = await db.prepare("SELECT * FROM catalog_rules WHERE deleted_at IS NULL AND tbl=? AND kind='invariant' AND enforce=1 ORDER BY id").bind(table).all();
  return results ?? [];
}

// Triggers exist only inside this batch transaction. No temp schema or user
// context tables; OLD/NEW have SQLite's actual types, defaults and values.
export async function commitChecked(db, reads, table, rules, statements, now, history = null, expected = []) {
  const key = '_life_write_' + crypto.randomUUID().replaceAll('-', '');
  const schema = (await db.prepare(`PRAGMA table_info(${qident(table)})`).all()).results;
  const cols = schema.map(c => c.name);
  const context = (prefix) => cols.map(c => `${prefix}.${qident(c)} AS ${qident(c)}`).join(',');
  const begin = [db.prepare(`CREATE TABLE ${qident(key)} (ok INTEGER CONSTRAINT life_write_conflict CHECK(ok=1))`), ...readGuards(db, reads, key)];
  const end = [db.prepare(`DROP TABLE ${qident(key)}`)];
  const approval = key + '_approved';
  if (expected.length) {
    begin.push(db.prepare(`CREATE TABLE ${qident(approval)} AS SELECT value FROM json_each(?)`)
      .bind(JSON.stringify(expected.map(({hub_at, ...row})=>row))));
    end.unshift(db.prepare(`DROP TABLE ${qident(approval)}`));
  }
  if (rules.length || expected.length) for (const event of ['INSERT', 'UPDATE']) {
    const trigger = key + '_' + event.toLowerCase();
    let checks = rules.map((rule, i) => {
      if (!/^\s*SELECT\b/i.test(rule.sql) || /random\s*\(|localtime|'now'/i.test(rule.sql)) throw new Error('invalid invariant SELECT');
      const before = event === 'UPDATE' ? `SELECT ${context('OLD')}` : `SELECT ${context('NEW')} WHERE 0`;
      return `SELECT RAISE(ABORT, 'life_invariant_${i}') WHERE EXISTS (
        WITH changed AS (SELECT ${context('NEW')}), before AS (${before}), now AS (SELECT ${literal(now)} AS ts)
        ${rule.sql});`;
    }).join('\n');
    if (expected.length) {
      const matches = cols.map(c=>`(json_type(value,${literal('$."'+c+'"')}) IS NULL OR NEW.${qident(c)} IS json_extract(value,${literal('$."'+c+'"')}))`).join(' AND ');
      checks += ` SELECT RAISE(ABORT, 'life_write_conflict') WHERE NOT EXISTS (SELECT 1 FROM ${qident(approval)} WHERE ${matches});`;
    }
    begin.push(db.prepare(`CREATE TRIGGER ${qident(trigger)} AFTER ${event} ON ${qident(table)} BEGIN ${checks} END`));
    end.unshift(db.prepare(`DROP TRIGGER ${qident(trigger)}`));
  }
  const log = historyStatements(db, table, key, history, now);
  return db.batch([...begin, ...log.begin, ...statements, ...log.end, ...end]);
}

export function queryBudget(db, maximum) {
  let queries = 0;
  return {
    prepare(sql) {
      if (++queries > maximum || new TextEncoder().encode(sql).length > 100_000) {
        throw new Error('life_write_budget');
      }
      return db.prepare(sql);
    },
    batch: statements => db.batch(statements),
  };
}

export async function pushChecked(db, table, rows, upsertSql, hubAt, stamping, history = []) {
  // Every prepared batch statement counts. Leave space for route plumbing
  // and the separately bounded background derivation (200 statements).
  return pushGroup(queryBudget(db, 750), table, rows, upsertSql, hubAt, stamping, history);
}

async function pushGroup(db, table, rows, upsertSql, hubAt, stamping, history = []) {
  try {
    return await pushAttempt(db, table, rows, upsertSql, hubAt, stamping, history);
  } catch (e) {
    if (!String(e).includes('life_write_budget')) throw e;
    return { accepted: [], rejected: rows.map(row => ({id:row.id, col:null, rule:'write-budget',
      message:'Write budget reached; retry this row in a smaller batch.'})) };
  }
}

async function pushAttempt(db, table, rows, upsertSql, hubAt, stamping, history = []) {
  if (!rows.length) return { accepted: [], rejected: [] };
  const view = checkedReads(db);
  // A concurrent DDL/trigger change also invalidates the validation decision.
  await view.prepare("SELECT name, sql FROM sqlite_master WHERE type IN ('table','trigger') AND name NOT LIKE '_cf_%' AND name NOT GLOB '_life_write_*' ORDER BY name").all();
  const { accepted, rejected, expected } = await validatePush(view, table, rows);
  if (!accepted.length) return { accepted, rejected };
  const rules = await enforcedRules(view, table);
  let log;
  try { log = await historyPlan(view, db, table, accepted, history); }
  catch (e) {
    if (!String(e).includes('life_history')) throw e;
    if (rows.length > 1) {
      const mid = Math.floor(rows.length / 2);
      const left = await pushGroup(db, table, rows.slice(0,mid), upsertSql, hubAt, stamping, history);
      const right = await pushGroup(db, table, rows.slice(mid), upsertSql, hubAt, stamping, history);
      return {accepted:[...left.accepted,...right.accepted], rejected:[...left.rejected,...right.rejected]};
    }
    return {accepted:[],rejected:[...rejected,{id:accepted[0].id,col:null,rule:'history',message:String(e)}]};
  }
  const groups = [];
  for (const row of accepted) {
    const cols = Object.keys(row);
    const last = groups.at(-1);
    if (last && last.cols.join(',') === cols.join(',')) last.rows.push(row);
    else groups.push({cols, rows:[row]});
  }
  const statements = groups.map(({ cols, rows }) => db.prepare(upsertSql(table, cols, stamping))
    .bind(...(stamping ? [hubAt, JSON.stringify(rows)] : [JSON.stringify(rows)])));
  try {
    await commitChecked(db, view.reads, table, rules, statements, hubAt || new Date().toISOString(), log, expected);
    return { accepted, rejected };
  } catch (e) {
    if (!/life_invariant_|life_write_conflict/.test(String(e))) throw e;
    // Revalidate after rollback. Split in order so one bad row cannot deny
    // valid siblings, and duplicate IDs see earlier accepted patches.
    if (rows.length > 1) {
      const mid = Math.floor(rows.length / 2);
      const left = await pushGroup(db, table, rows.slice(0, mid), upsertSql, hubAt, stamping, history);
      const right = await pushGroup(db, table, rows.slice(mid), upsertSql, hubAt, stamping, history);
      return { accepted: [...left.accepted, ...right.accepted], rejected: [...left.rejected, ...right.rejected] };
    }
    const index = /life_invariant_(\d+)/.exec(String(e));
    const rule = index ? rules[Number(index[1])] : null;
    return { accepted: [], rejected: [...rejected, { id: accepted[0].id, col: rule?.col ?? null,
      rule: rule?.id ?? 'write-conflict', message: rule?.text ?? 'Write could not be committed; retry against current state.' }] };
  }
}
