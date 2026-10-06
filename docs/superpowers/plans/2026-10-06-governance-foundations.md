# Governance Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate canonical governance data shapes and implement selected-change inverse planning without advertising unimplemented service operations.

**Architecture:** Extend the existing contract generator with named discriminated object unions. A pure shared planner consumes trusted, complete, ordered history evidence from a future service loader and returns selected field differences or conflicts; it cannot authenticate, issue previews, or write data.

**Tech Stack:** TypeScript, Bun tests, existing JSON contract and Swift generator.

**Spec:** `docs/governance-api-contract.md`

## Global Constraints

- Selected inverse preserves unrelated later edits; same-column later unselected changes conflict.
- Existing history remains canonical; absent typed or continuity evidence fails closed.
- No client second writer, personal schemas, service capability advertisement, deployment, or credential changes.
- Root owns downstream UI generated integration; this branch owns canonical source and outputs only.

## Review Focus

- Unknown or repeated union discriminants must fail instead of selecting an arbitrary variant.
- A missing historical event cannot be inferred from matching values.
- Typed SQL null, unknown history, empty text, and large integers remain distinct.
- Same-column value cycles cannot bypass conflict detection.
- Inputs and unrelated fields remain unchanged even when one selected field conflicts.

### Task 1: Canonical governance DTO generation

**Files:** `scripts/generate-core-contract.ts`, `core/contract/core.json`, generated TS/Swift, `core/test/contract.test.ts` and typecheck fixture.

**Interfaces:** Named `oneOf` object variants with one common required singleton string discriminator; concrete governance request/result definitions matching the spec. No additions to `CoreOperations` until handlers exist.

- [ ] Add failing generation tests for named union output, repeated/absent discriminants, and unsupported inline alternatives.
- [ ] Run `bun test core/test/contract.test.ts` and confirm the supported union fixture fails generation.
- [ ] Generate TypeScript unions and Swift tagged enums with explicit discriminator decoding and tag validation on encode. Preserve existing nullable unions.
- [ ] Add exact typed cell/history/proposal/preview/result and argument definitions, regenerate canonical outputs, and verify discriminant narrowing in TypeScript.
- [ ] Run core generation/typecheck and isolated Swift codec verification; mutate discriminator checks and verify rejection tests fail.
- [ ] Commit and push the canonical DTO prerequisite.

### Task 2: Selected historical inverse planner

**Files:** new `core/src/governance.ts`, `core/test/governance.test.ts`; export through `core/src/index.ts`; update core README/AGENTS with current implemented boundary.

**Interfaces:** `planSelectedInverse({target,eventIds}, evidence)` where evidence contains current typed cells, current revision, ordered canonical events, and explicit completeness. Returns `{changes, selectedEventIds, conflicts}` using Task 1 types. This trusted internal seam is not an RPC accepting caller-asserted evidence.

- [ ] Write failing tests: selected name edit with later unrelated quantity change preserves quantity; later same-column edit and value cycle conflict; selected contiguous changes reverse in order; missing/incomplete/untyped/broken-chain evidence fails; duplicate IDs fail; null/empty/int64 values remain exact; multi-column conflict yields no partial changes and frozen inputs survive.
- [ ] Run `bun test core/test/governance.test.ts` and confirm the planner is absent.
- [ ] Implement one linear reverse walk over relevant ordered events, validate typed values/identity/completeness, and emit only selected columns. Never coerce legacy TEXT history, infer ordering from timestamps, or return a partial patch after conflict.
- [ ] Run focused and full core/Worker suites plus typecheck. Mutate same-column conflict, completeness, typed-value distinction, and partial-result guards.
- [ ] Request independent branch review, fix findings, commit and push. Report the exact source SHA and the remaining service prerequisites: trusted evidence loader, actor/approval authority, inert authenticated preview, atomic proposal/receipt persistence.
