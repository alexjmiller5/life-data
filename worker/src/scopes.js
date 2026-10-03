// Capabilities describe the protocol a credential may use; they never expand grants.
export const scopedReplicaUnsupported = Object.freeze({
  error: 'scoped_replica_unsupported',
  message: 'This credential supports direct API access only; replica synchronization requires broader table access.',
});

export function hasSchemaAccess(scopes) {
  return scopes.some(scope => ['admin', 'full', 'tables:read'].includes(scope));
}

export function sessionCapabilities(scopes) {
  return {
    row_api: 'v1',
    schema: hasSchemaAccess(scopes) ? 'full-ddl-v1' : 'none',
    replica_sync: scopes.some(scope => ['admin', 'full'].includes(scope)),
    subscriptions: null,
    files: 'opaque-key-v1',
  };
}
