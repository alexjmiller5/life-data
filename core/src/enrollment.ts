import type {
  EnrollmentApproval, EnrollmentApprovalArgs, EnrollmentPolicy, EnrollmentPollResult,
  ReplicaEligibility, ReplicaIneligibilityCode, SessionInfo, SessionReply, SessionRevocationResult,
  EnrollmentProfileExpectation, EnrollmentProfileReceipt,
} from './contract.generated.ts';

import {isGovernanceCapability,object} from './governance-wire.ts';
import {validEnrollmentScopes} from './enrollment-scopes.ts';
import {pushRegistrationCapability,pushEnrollmentProfiles} from './push-registration.ts';

/** Hosts own clocks, cancellation, cryptography, HTTP and credential storage. */
export const ENROLLMENT_POLICY: Readonly<EnrollmentPolicy> = Object.freeze({
  pollIntervalSeconds: 5, timeoutSeconds: 300, maxResponseBytes: 65_536,
});

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const fingerprint = (v: unknown): v is string => typeof v === 'string'
  && v.length === 64 && /^[0-9a-f]+$/.test(v);
const profileId = (v: unknown): v is string => typeof v === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(v);

function validateProfileExpectation(p: EnrollmentProfileExpectation): void {
  if (!record(p) || !profileId(p.id) || !validEnrollmentScopes(p.scopes)) throw new Error('invalid enrollment profile expectation');
}

/** Append this relative path only to the host's validated/canonical endpoint.
 * The only key here is a SHA-256 fingerprint, never the candidate bearer token. */
export function enrollmentApproval(args: EnrollmentApprovalArgs): EnrollmentApproval {
  if (!record(args) || !fingerprint(args.fingerprint) || typeof args.name !== 'string'
    || !args.name.trim().length || args.name.trim().length > 100 || /[\u0000-\u001f\u007f]/.test(args.name)
    || (Object.hasOwn(args,'profile') && !profileId(args.profile))) {
    throw new Error('invalid enrollment approval request');
  }
  // Match URLSearchParams' USVString conversion without requiring that browser
  // global in JSC. for-of retains paired surrogates; lone ones become U+FFFD.
  const label = Array.from(args.name.trim(), c => c.length === 1 && c.charCodeAt(0) >= 0xd800
    && c.charCodeAt(0) <= 0xdfff ? '\ufffd' : c).join('');
  return {
    path: `/login?key=${args.fingerprint}&name=${encodeURIComponent(label)}${args.profile === undefined ? '' : `&profile=${args.profile}`}`,
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
    if (!record(caps) || typeof caps.schema !== 'string' || typeof caps.replica_sync !== 'boolean'
      || caps.row_api !== 'v1' || caps.files !== 'opaque-key-v1'
      || (caps.subscriptions !== null && caps.subscriptions !== 'durable-pull-v1')) {
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
export function validateDeviceSession(data: unknown, expectedProfile?: EnrollmentProfileExpectation): SessionInfo {
  if (expectedProfile !== undefined) validateProfileExpectation(expectedProfile);
  if (!record(data) || typeof data.name !== 'string' || !data.name.trim()
    || !Array.isArray(data.scopes) || !data.scopes.every(s => typeof s === 'string' && s.length > 0)) {
    throw new Error('invalid device session');
  }
  if (data.name === 'admin' || data.scopes.includes('admin')) {
    throw new Error('admin tokens cannot be used as device credentials');
  }
  let enrollmentProfile: EnrollmentProfileReceipt | undefined;
  if (Object.hasOwn(data,'enrollmentProfile')) {
    const p=data.enrollmentProfile;
    if (!record(p) || !profileId(p.id) || !fingerprint(p.revision)) throw new Error('invalid enrollment profile receipt');
    enrollmentProfile={id:p.id,revision:p.revision};
  }
  if (expectedProfile) {
    const caps=data.capabilities;
    if (enrollmentProfile?.id !== expectedProfile.id || data.scopes.length !== expectedProfile.scopes.length
      || new Set(data.scopes).size !== data.scopes.length || !data.scopes.every(s=>expectedProfile.scopes.includes(s))
      || !record(caps) || caps.row_api !== 'v1' || caps.schema !== 'none' || caps.replica_sync !== false
      || (expectedProfile.scopes.some(s=>s.startsWith('tables:patch:')) && caps.conditional_patch !== 'revision-v1')
      || Object.hasOwn(caps,'governance')) throw new Error('device approval profile does not match');
  }
  const governance=object(data.capabilities)&&isGovernanceCapability(data.capabilities.governance)?data.capabilities.governance:undefined;
  const pushProfiles=record(data.capabilities)?pushEnrollmentProfiles(data.capabilities.push_profiles):undefined;
  const push=record(data.capabilities)?pushRegistrationCapability(data.capabilities.push_registration):undefined;
  return { name: data.name, scopes: [...data.scopes], replica: replicaEligibility(data, data.scopes),
    ...(enrollmentProfile?{enrollmentProfile}:{}), ...(governance?{governance:JSON.parse(JSON.stringify(governance))}: {}),
    ...(push?{pushRegistration:push}:{}),...(pushProfiles?{pushProfiles}:{}) };
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
export function enrollmentPollResult(reply: SessionReply, expectedFingerprint: string, expectedProfile?: EnrollmentProfileExpectation): EnrollmentPollResult {
  if (!fingerprint(expectedFingerprint)) throw new Error('invalid enrollment fingerprint');
  if (expectedProfile !== undefined) validateProfileExpectation(expectedProfile);
  validateReply(reply);
  if (reply.status === 200) {
    const session = validateDeviceSession(reply.data, expectedProfile);
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
