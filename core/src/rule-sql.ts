// Conservative text boundary shared by UI and Worker enforcement. This is not
// a SQL parser or a proof about views, data-driven calls or custom functions.
// Reject all date/time function calls, including deterministic explicit-input
// forms, rather than guess whether their arguments can read the ambient clock.
// Rules can compare/slice the supplied now.ts with ordinary string functions.
const functions = 'random|randomblob|date|time|datetime|julianday|unixepoch|strftime|timediff|changes|total_changes|last_insert_rowid|sqlite_version|sqlite_source_id';
const trivia = String.raw`(?:\s|/\*[\s\S]*?\*/|--[^\n]*(?:\n|$))*`;
const calls = new RegExp(`\\b(?:${functions})["'\\x60\\]]?${trivia}\\(`, 'i');
const ambient = /\bcurrent_(?:timestamp|date|time)\b|localtime|'now'/i;

export function supportedRuleSql(sql: unknown): sql is string {
  return typeof sql === 'string' && /^\s*SELECT\b/i.test(sql)
    && !calls.test(sql) && !ambient.test(sql);
}
