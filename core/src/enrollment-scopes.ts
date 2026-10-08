/** Scope grammar shared by browser approval and native enrollment validation.
 * tests/fixtures/enrollment-scopes.json is the contract; src/life_data/login.py
 * implements the same grammar for the CLI. Full, admin and token administration
 * are never profile grants. */
const simple = new RegExp('^(?:tables:read|tables:write|streams:append'
  + '|captures:(?:submit|read):[a-z][a-z0-9-]{0,63}'
  + '|streams:(?:read|append):[A-Za-z0-9_-]{1,64}'
  + '|subscriptions:consume:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
  + '|rows:create:[a-z][a-z0-9_-]{0,63}:[0-9a-f]{64}'
  // Literal object-key namespaces; no segment can be empty, "." or "..".
  + '|files:(?:read|write):(?:[A-Za-z0-9_][A-Za-z0-9._-]*/)+)$');
const reserved = (table: string) => /^(?:sqlite_|catalog_)/i.test(table) || /^(?:history|provenance|purges)$/i.test(table);

export function validEnrollmentScopes(scopes: unknown): scopes is string[] {
  if (!Array.isArray(scopes) || !scopes.length || scopes.length > 256
    || new Set(scopes).size !== scopes.length) return false;
  return scopes.every(scope => {
    if (typeof scope !== 'string') return false;
    if (simple.test(scope)) return true;
    const whole = /^tables:(?:read|write):([A-Za-z][A-Za-z0-9_]*)$/.exec(scope);
    if (whole) return !reserved(whole[1]!);
    const p = /^(tables:read|tables:patch|catalog:read):([A-Za-z][A-Za-z0-9_]*):([A-Za-z_][A-Za-z0-9_]*)$/.exec(scope);
    if (!p || reserved(p[2]!) || !scopes.includes(`tables:read:${p[2]}:id`)) return false;
    if (p[1] === 'catalog:read') return scopes.includes(`tables:read:${p[2]}:${p[3]}`);
    return p[1] === 'tables:read' || (!['id','created_at','updated_at','hub_at','deleted_at'].includes(p[3]!)
      && [p[3], 'updated_at', 'hub_at'].every(c => scopes.includes(`tables:read:${p[2]}:${c}`)));
  });
}
