import { qident, type Property, type Row } from "./validate.ts";
import { compileSearch } from './search.ts';

import type { View } from './contract.generated.ts';
export type { Filter, View } from './contract.generated.ts';

const SYSTEM_COLUMNS = new Set(["id", "created_at", "updated_at", "deleted_at"]);

function checkObject(value: unknown, keys: string[], label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).some((key) => !keys.includes(key))) {
    throw new Error(`Invalid ${label}`);
  }
}

/** Compile a catalog-scoped view. Equality is null-safe; contains is literal
 * (ASCII case-insensitive text, exact JSON array membership). Empty includes
 * NULL, empty strings and, for multi-value properties, empty JSON arrays.
 * Nonempty search requires the prepared local FTS index. Prefer readRows(),
 * which drains its queue and queries in the same transaction.
 */
export function compileView(view: View, properties: Property[]): { sql: string; params: (string | number | null)[] } {
  checkObject(view, ["table", "columns", "filters", "sort", "limit", "offset", "trash", "search"], "view");
  if (typeof view.table !== "string") throw new Error("Invalid table");
  const table = qident(view.table);
  const props = new Map(properties.filter((p) => p.tbl === undefined || p.tbl === view.table).map((p) => [p.col, p]));
  // Qualify every column: json_each has its own id/value columns.
  const row = qident("_view_row");
  const column = (name: unknown): string => {
    if (typeof name !== "string") throw new Error("Invalid column");
    const quoted = qident(name);
    if (!SYSTEM_COLUMNS.has(name) && !props.has(name)) throw new Error(`Unknown column: ${name}`);
    return `${row}.${quoted}`;
  };
  for (const key of ["columns", "filters", "sort"] as const) {
    if (view[key] !== undefined && !Array.isArray(view[key])) throw new Error(`Invalid ${key}`);
  }
  if (view.columns?.length === 0) throw new Error("columns must not be empty");
  if (view.trash !== undefined && typeof view.trash !== "boolean") throw new Error("Invalid trash flag");
  if (view.search !== undefined && typeof view.search !== "string") throw new Error("Invalid search");
  const limit = view.limit === undefined ? 50 : view.limit;
  const offset = view.offset === undefined ? 0 : view.offset;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("limit must be a positive safe integer");
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a nonnegative safe integer");

  const selected: string[] = [];
  for (const name of view.columns ?? []) selected.push(column(name));
  const params: (string | number | null)[] = [];
  const bind = (value: unknown): string => {
    if (value !== null && typeof value !== "string" && typeof value !== "boolean"
      && !(typeof value === "number" && Number.isFinite(value))) throw new Error("Invalid filter value");
    params.push(typeof value === "boolean" ? Number(value) : value as string | number | null);
    return "?";
  };
  const where = [`${column("deleted_at")} IS ${view.trash ? "NOT " : ""}NULL`];
  for (const filter of view.filters ?? []) {
    checkObject(filter, ["column", "op", "value"], "filter");
    const col = column(filter.column);
    const type = props.get(filter.column)?.type;
    const multi = type === "multi_select" || type === "multi_ref";
    // CASE guards both JSON functions, including against legacy malformed cells.
    const array = `CASE WHEN json_valid(${col}) THEN CASE WHEN json_type(${col}) = 'array' THEN ${col} END END`;
    switch (filter.op) {
      case "empty":
      case "not_empty": {
        if (filter.value !== undefined) throw new Error(`${filter.op} takes no value`);
        const empty = `(${col} IS NULL OR ${col} = ${bind("")}${multi ? ` OR json_array_length(${array}) IS ${bind(0)}` : ""})`;
        where.push(filter.op === "empty" ? empty : `NOT ${empty}`);
        break;
      }
      case "contains":
        if (multi) {
          const item = qident("_view_item");
          where.push(`EXISTS (SELECT 1 FROM json_each(${array}) AS ${item} WHERE ${item}.${qident("value")} IS ${bind(filter.value)})`);
        } else {
          if (typeof filter.value !== "string") throw new Error("Text contains requires a string");
          where.push(`instr(lower(${col}), lower(${bind(filter.value)})) > 0`);
        }
        break;
      case "eq":
      case "ne":
        where.push(`${col} IS ${filter.op === "ne" ? "NOT " : ""}${bind(filter.value)}`);
        break;
      case "gt":
      case "gte":
      case "lt":
      case "lte": {
        if (filter.value === null) throw new Error("Ordered comparisons require a non-null value");
        const op = { gt: ">", gte: ">=", lt: "<", lte: "<=" }[filter.op];
        where.push(`${col} ${op} ${bind(filter.value)}`);
        break;
      }
      default:
        throw new Error("Invalid filter operator");
    }
  }

  if (view.search) {
    const query = compileSearch(view.search);
    where.push(query ? `${column('id')} IN (SELECT d.row_id FROM _core_search_fts JOIN _core_search_docs AS d ON d.docid=_core_search_fts.rowid WHERE _core_search_fts MATCH ${bind(query)} AND d.tbl=${bind(view.table)})` : '0');
  }
  const order: string[] = [];
  let sortedById = false;
  for (const sort of view.sort ?? []) {
    checkObject(sort, ["column", "direction"], "sort");
    if (sort.direction !== "asc" && sort.direction !== "desc") throw new Error("Invalid sort direction");
    order.push(`${column(sort.column)} ${sort.direction.toUpperCase()}`);
    if (sort.column === "id") sortedById = true;
  }
  if (!sortedById) order.push(`${column("id")} ASC`);
  const sql = `SELECT ${selected.length ? selected.join(", ") : `${row}.*`} FROM ${table} AS ${row} WHERE ${where.join(" AND ")} ORDER BY ${order.join(", ")} LIMIT ${bind(Math.min(limit, 200))} OFFSET ${bind(offset)}`;
  return { sql, params };
}

/** Use only the configured scalar label, then id; never infer a schema. */
export function displayName(row: Row, displayColumn?: string | null): string {
  const label = (value: unknown): string => {
    if (typeof value === "string") return value.trim();
    if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return String(value);
    return "";
  };
  return (displayColumn ? label(row[displayColumn]) : "") || label(row.id) || "Untitled";
}
