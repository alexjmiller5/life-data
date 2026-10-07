# Apple push notifications

An operator can explicitly test delivery with
`POST /v1/notifications/test/<lowercase-v4-uuid>`. This inserts one fixed,
clearly labeled synthetic event in the normal feed and delivery path. Retrying
the same UUID does not insert another event. It does not manufacture usage
thresholds or change any existing event's read state; ordinary API usage is
metered normally. After delivery settles, `DELETE` on the same exact path
removes only that test event and its delivery receipts. Both methods require
admin scope; ordinary full-scope app sessions cannot manufacture events.

The hub owns the APNs sender and auth-store registration/delivery records. Native
clients never hold an Apple key, team identifier, topic or environment. The
client's existing authenticated device session resolves its principal. Explicit
Access-verified browser approval with a configured `pushProfile` binds that
session to one native app profile and a separate opaque session binding.

`APNS_CONFIG` and `APNS_PRIVATE_KEY` are service secrets in the project's ENV
item. Configuration contains a stable `deploymentIdentity`, Apple `teamId` and
`keyId`, and `profiles` entries with public `id`, `platform` (`ios`/`macos`),
`topic` and `environment` (`production`/`sandbox`). The private key is PKCS#8 PEM.
Use a dedicated topic-specific key, with only the intended environment. No key
or configuration means no advertised capability and no delivery attempts.

The existing `/v1/session` advertises `push_registration` only for a live,
explicitly approved native session. Its protocol is `apns-registration-v1`;
`deploymentIdentity`, `sessionBinding` and permitted app profile are server-owned.
Existing sessions without this approval remain unavailable. An operator or a
full-scope token name alone never grants native provenance.

## Registration

- `GET /v1/push/registration?appProfile=<id>` returns a baseline, never readiness.
- `POST /v1/push/registration` accepts exactly `appProfile`, lowercase opaque
  `deviceToken` hex, nullable `expectedRevision` and `requestId`.
- `POST /v1/push/registration/revoke` accepts the same fields except token.

A successful POST returns a request-bound current registration receipt. Compare
and swap protects token rotation and revoke/create ordering. A null-revision
revoke creates an absent-only revoked barrier. If create wins, current revoke
intent reads the new revision and retries. A later explicit register intent may
reactivate it. Reusing a request ID with different content fails; an exact retry
is confirmed only while its recorded revision is current. Superseded receipts
return `409 registration_changed` and cannot reactivate a token.

All three exact method/path combinations remain available when data usage is
capped. They touch the auth store only. Token hashes stay private; public session
and installation bindings are separate opaque identifiers. A session revoke
immediately removes authority to register or send.

## Delivery and identity

First registration and reactivation baseline the existing notification feed.
Rotation preserves its delivery cursor. A bounded drain runs after request and
scheduled accounting; the existing sweep provides retry opportunities while
clients are closed. Auth-store leases and durable retry timestamps prevent
concurrent drains and hot retries. A single drain is limited to 40 events,
20 eligible installations, four events per installation and a 20-second start
window. Provider requests time out after ten seconds. Large backlogs can require
multiple invocations. Provider tokens are reused for at most 50 minutes.

The collapse key is exactly 43 ASCII bytes:
`base64url_no_padding(SHA256(UTF8(JSON.stringify(["life-notification-v1", deploymentIdentity, exactEventId]))))`.
Use ECMAScript JSON string encoding, without normalization or slash escaping.
Token, topic and installation revision are excluded. Golden vectors in
`worker/test/apple-push.test.js` match the native canonical vectors.

Delivery receipts additionally belong to the installation subscription. Feed
sequence orders delivery only. Remote acceptance, display and shared read state
are distinct. APNs acceptance never marks an event read. Old-generation invalid
token responses cannot revoke a new generation. Ambiguous network failures can
retry with the same collapse key; APNs does not promise exactly-once display.

Once the client has a matching current authenticated receipt, push owns banners
and polling updates the inbox only. Permission, token callbacks and GET baselines
alone never suppress foreground alerts. Client token rotation, explicit revoke,
logout or session replacement invalidate local readiness before any suspension.

## Acceptance

Synthetic tests cover provenance, CAS, rotation, logout, cap exemptions, identity,
payload limits, durable retries and stale callbacks. These tests do not prove
Apple acceptance or OS presentation. Complete acceptance additionally requires a
signed entitled app, explicit user permission, supported native enrollment,
a current registration receipt, APNs provider acceptance and a visible notification
with the app closed on each physical platform. Preserve the installed client's
normal secure storage and use supported UI for consent and enrollment.
