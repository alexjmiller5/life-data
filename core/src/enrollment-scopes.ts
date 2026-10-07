/** Scope grammar shared by browser approval and native enrollment validation. */
export function validEnrollmentScopes(scopes: unknown): scopes is string[] {
  if (!Array.isArray(scopes) || !scopes.length || scopes.length > 256
    || new Set(scopes).size !== scopes.length) return false;
  return scopes.every(scope => {
    if (typeof scope === 'string' && /^captures:(submit|read):[a-z][a-z0-9-]{0,63}$/.test(scope)) return true;
    const p = typeof scope === 'string'
      ? /^(tables:read|tables:patch|catalog:read):([A-Za-z][A-Za-z0-9_]*):([A-Za-z_][A-Za-z0-9_]*)$/.exec(scope) : null;
    if (!p || /^(?:sqlite_|catalog_)/i.test(p[2]!) || /^(?:history|provenance|purges)$/i.test(p[2]!)
      || !scopes.includes(`tables:read:${p[2]}:id`)) return false;
    if (p[1] === 'catalog:read') return scopes.includes(`tables:read:${p[2]}:${p[3]}`);
    return p[1] === 'tables:read' || (!['id','created_at','updated_at','hub_at','deleted_at'].includes(p[3]!)
      && [p[3], 'updated_at', 'hub_at'].every(c => scopes.includes(`tables:read:${p[2]}:${c}`)));
  });
}
