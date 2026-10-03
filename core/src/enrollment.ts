import type {
  EnrollmentApproval, EnrollmentApprovalArgs, EnrollmentPolicy, EnrollmentPollResult,
  ReplicaEligibility, ReplicaIneligibilityCode, SessionInfo, SessionReply, SessionRevocationResult,
} from './contract.generated.ts';

/** Hosts own clocks, cancellation, cryptography, HTTP and credential storage. */
export const ENROLLMENT_POLICY: Readonly<EnrollmentPolicy> = Object.freeze({
  pollIntervalSeconds: 5, timeoutSeconds: 300, maxResponseBytes: 65_536,
});

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const fingerprint = (v: unknown): v is string => typeof v === 'string'
  && v.length === 64 && /^[0-9a-f]+$/.test(v);

/** Append this relative path only to the host's validated/canonical endpoint.
 * The only key here is a SHA-256 fingerprint, never the candidate bearer token. */
export function enrollmentApproval(args: EnrollmentApprovalArgs): EnrollmentApproval {
  if (!record(args) || !fingerprint(args.fingerprint) || typeof args.name !== 'string'
    || !args.name.trim().length || args.name.trim().length > 100 || /[\u0000-\u001f\u007f]/.test(args.name)) {
    throw new Error('invalid enrollment approval request');
  }
  // Match URLSearchParams' USVString conversion without requiring that browser
  // global in JSC. for-of retains paired surrogates; lone ones become U+FFFD.
  const label = Array.from(args.name.trim(), c => c.length === 1 && c.charCodeAt(0) >= 0xd800
    && c.charCodeAt(0) <= 0xdfff ? '\ufffd' : c).join('');
  return {
    path: `/login?key=${args.fingerprint}&name=${encodeURIComponent(label)}`,
    approvalCode: args.fingerprint.slice(0, 8), deviceName: `device:${args.fingerprint}`,
    policy: { ...ENROLLMENT_POLICY },
  };
}

function denied(code: ReplicaIneligibilityCode, message: string): ReplicaEligibility {
  return { allowed: false, reason: { code, message } };
}

function replicaEligibility(data: Record<string, unknown>, scopes: string[]): ReplicaEligibility {
  if (Object.hasOwn(data, 'capabilities')) {
    const caps = data.capabilities;
    if (!record(caps) || typeof caps.schema !== 'string' || typeof caps.replica_sync !== 'boolean') {
      return denied('invalid_capabilities', 'The hub returned invalid replica capabilities.');
    }
    if (caps.schema === 'none') return denied('schema_unavailable', 'This token does not allow replica schema access.');
    if (caps.replica_sync === false) return denied('replica_sync_disabled', 'This token does not allow replica sync.');
    if (caps.schema !== 'full-ddl-v1') return denied('schema_unavailable', 'This token does not allow replica schema access.');
  }
  if (!scopes.includes('full')) return denied('full_scope_required', 'Replica sync requires a full device token.');
  return { allowed: true, reason: null };
}

/** Identity validation is separate from replica eligibility. Manual dedicated
 * nonadmin names are valid here; only approval polling binds a fingerprint. */
export function validateDeviceSession(data: unknown): SessionInfo {
  if (!record(data) || typeof data.name !== 'string' || !data.name.trim()
    || !Array.isArray(data.scopes) || !data.scopes.every(s => typeof s === 'string' && s.length > 0)) {
    throw new Error('invalid device session');
  }
  if (data.name === 'admin' || data.scopes.includes('admin')) {
    throw new Error('admin tokens cannot be used as device credentials');
  }
  return { name: data.name, scopes: [...data.scopes], replica: replicaEligibility(data, data.scopes) };
}

function validateReply(reply: SessionReply): void {
  if (!record(reply) || !Number.isInteger(reply.status) || reply.status < 100 || reply.status > 599
    || !Object.hasOwn(reply, 'data') || reply.data === undefined
    || (Object.hasOwn(reply, 'retryAfterSeconds') && (!Number.isSafeInteger(reply.retryAfterSeconds)
      || reply.retryAfterSeconds! < 0))) {
    throw new Error('invalid session reply');
  }
}

/** One response only. Hosts retain a monotonic deadline and never accept a late
 * reply from a cancelled, expired or replaced enrollment attempt. */
export function enrollmentPollResult(reply: SessionReply, expectedFingerprint: string): EnrollmentPollResult {
  if (!fingerprint(expectedFingerprint)) throw new Error('invalid enrollment fingerprint');
  validateReply(reply);
  if (reply.status === 200) {
    const session = validateDeviceSession(reply.data);
    if (session.name !== `device:${expectedFingerprint}`) throw new Error('device approval identity does not match');
    return { state: 'approved', session, retryAfterSeconds: null };
  }
  if ([401, 403, 429].includes(reply.status) || reply.status >= 500) {
    const retry = reply.status === 429 || reply.status === 503 ? reply.retryAfterSeconds ?? 0 : 0;
    return { state: 'pending', session: null, retryAfterSeconds: Math.max(ENROLLMENT_POLICY.pollIntervalSeconds, retry) };
  }
  throw new Error(`hub returned HTTP ${reply.status} while checking approval`);
}

/** A 401 is not revocation proof: the hub cannot cancel a not-yet-approved key. */
export function sessionRevocationResult(reply: SessionReply): SessionRevocationResult {
  validateReply(reply);
  if (reply.status === 401) return { state: 'unauthorized' };
  if (reply.status === 200 && record(reply.data) && reply.data.logged_out === true) return { state: 'revoked' };
  throw new Error(`hub did not revoke the device (HTTP ${reply.status})`);
}
