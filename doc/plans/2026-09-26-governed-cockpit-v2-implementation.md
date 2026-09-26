# Governed Coding Cockpit V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a separate Paperclip Standalone V2 app where one project coding pod moves an issue from owner implementation through exact-commit agent review to a board approval.

**Architecture:** Paperclip remains the only task and execution authority. A project pod selects existing agents; an issue binding snapshots the owner, reviewer, board user, and existing `review` → `approval` execution stages. A candidate row records the Git base/head for each owner-to-review transition. Ordinary issue updates and native finalization both commit that row before reviewer dispatch. Reviewer runs use a candidate-pinned worktree and run-scoped low-trust policy; the issue page presents the existing documents, workspace, runs, and stage decisions as one cockpit.

**Tech Stack:** macOS SwiftPM/AppKit/WebKit wrapper; Node.js 24, pnpm, Express, Drizzle/PostgreSQL, React/Vite, Vitest.

**Spec:** `doc/plans/2026-09-26-governed-cockpit-v2-design.md`

## Global Constraints

- Preserve `standalone-v1` and the signed V1 app. V2 uses `PaperclipStandaloneV2`, bundle ID `ing.paperclip.standalone.cnowlin.v2`, HTTP `3319`, embedded PostgreSQL `54333`, `~/Library/Application Support/Paperclip Standalone V2`, and `dist/Paperclip Standalone V2.app`.
- V2 starts with a separate empty instance. The installed app on `3317` and V1 dev app on `3318` stay runnable. No live agents run without a separate explicit user request.
- Keep company access, single-assignee, atomic checkout, budget hard stop, approval, activity-log, and native recovery invariants. Do not introduce a second scheduler or issue database.
- Pod configuration and issue attachment are board actions. Only the active stage participant may decide a stage, subject to existing board override and audit rules.
- The owner's issue policy has no `reviewPreset`. Only a reviewer run gets `low_trust_review` with an issue/project boundary and a separate candidate-pinned worktree.
- All UI visual values come from `ui/src/index.css` tokens; run `pnpm check:token-gates`. Use Node.js 24.11+ and macOS 14+.

## Review Focus

1. **V1/V2 collision:** Task 1 smoke check must show a V2 build/quit leaves both the V1 dev app and installed app reachable.
2. **Cross-company or changed pod configuration:** Tasks 2–3 tests must reject foreign agents and prove an attached issue keeps its pinned participants after the project pod changes.
3. **Dirty or moving Git candidate:** Tasks 4 and 6 tests must reject dirty/unresolved worktrees and stale board approval, leaving an explicit owner/recovery path.
4. **Native bypass or retry:** Task 5 tests must show native completion starts the same staged review as an ordinary issue update and replay creates one candidate and wake.
5. **Reviewer authority leak:** Task 6 tests must show the owner stays standard, reviewer gets only issue-scoped low trust and a separate worktree, and reviewer approval advances to the board rather than completing the issue.

---

### Task 1: Isolate the V2 macOS app

**Files:** Modify `macos/PaperclipStandaloneDev/Package.swift`, its three Swift source files, `script/build_and_run.sh`, `.codex/environments/environment.toml`, and `LOCAL_PROJECT.md`. Create `script/verify_standalone_v2.sh`.

**Interfaces:** Produces the independent V2 executable, app bundle, data path, and build/run command used by all later tasks. Keep `script/build_local_runtime.sh` as the source packaging path.

- [ ] **Step 1: Write the bundle smoke script.** It asserts the V2 plist keys, executable/process name, signed bundle, and bundled local CLI/server/UI files; when both apps are launched, it checks `3318` and `3319` health and that quitting V2 leaves `3318` and `3317` alive. It never starts agents.
- [ ] **Step 2: Run the script against the current tree.** Expected: fail because `Paperclip Standalone V2.app` does not exist.
- [ ] **Step 3: Change the SwiftPM product/target to `PaperclipStandaloneV2` using the current source directory as its target path.** Update the Swift labels/fallbacks and build script bundle name, executable, process stop target, bundle ID, ports, data name, and output; point the Codex Run action at the V2 script.
- [ ] **Step 4: Verify.** Run `swift build -c release --package-path macos/PaperclipStandaloneDev`, then `./script/build_and_run.sh --build-only`, then the smoke script. Expected: valid signature and separate health/quit behavior; V1 files and data unchanged.
- [ ] **Step 5: Commit** the app isolation and smoke script as `Isolate Paperclip Standalone V2 app`.

### Task 2: Persist project coding-pod configuration

**Files:** Create `packages/db/src/schema/coding_pods.ts`, `packages/shared/src/types/coding-pod.ts`, `packages/shared/src/validators/coding-pod.ts`, `server/src/services/coding-pods.ts`, `server/src/routes/coding-pods.ts`, and `server/src/__tests__/coding-pod-routes.test.ts`; update schema/shared exports and `server/src/app.ts`. Generate the next Drizzle migration.

**Interfaces:** `CodingPod` has `id`, `companyId`, `projectId`, `ownerAgentId`, `reviewerAgentId`, `enabled`, timestamps. `upsertCodingPodSchema` accepts exactly those three mutable values. Mount `GET`/`PUT /api/companies/:companyId/projects/:projectId/coding-pod`; PUT is board-only, GET uses normal company access. The table has one row per project and a company index. `codingPodService(db).get(companyId, projectId): Promise<CodingPod | null>` and `.upsert(companyId, projectId, input: UpsertCodingPod): Promise<CodingPod>` supply Task 3.

- [ ] **Step 1: Write failing route tests.** Assert a board PUT persists a distinct active same-company owner/reviewer; repeated PUT updates one row; a foreign, identical, inactive, or unavailable-adapter agent and a non-Git project are rejected; an agent PUT is `403`; configuration queues no wake.
- [ ] **Step 2: Run `pnpm exec vitest run server/src/__tests__/coding-pod-routes.test.ts`.** Expected: missing route/service failures.
- [ ] **Step 3: Implement** the schema, validator/type, service, route, exports and migration (`pnpm db:generate`). Use `findActiveServerAdapter` and the project workspace's verified Git root; do not silently fall back to the process adapter. Return `422` for invalid pod inputs and `404` for inaccessible project scope.
- [ ] **Step 4: Run the focused test and `pnpm --filter @paperclipai/db build` plus shared/server typechecks.** Expected: green route tests and compiled contracts.
- [ ] **Step 5: Commit** as `Add company-scoped coding pod configuration`.

### Task 3: Attach a pod to a parked issue

**Files:** Create `packages/db/src/schema/coding_pod_issue_bindings.ts` and `server/src/__tests__/coding-pod-attachment.test.ts`; extend shared coding-pod types/validators, `server/src/services/coding-pods.ts`, `server/src/routes/coding-pods.ts`, and migration.

**Interfaces:** `attachCodingPodToIssue(db, {companyId, issueId, actorUserId}): Promise<CodingPodIssueBinding>` snapshots `podId`, owner/reviewer IDs, board user ID, review/approval stage IDs on a unique issue binding. `POST /api/companies/:companyId/issues/:issueId/coding-pod` has an empty strict body and is board-only. `GET` at the same path returns `CodingPodIssueView = { binding, candidate, phase }`, where phase is `not_configured | owner_working | review_pending | review_running | awaiting_board | candidate_stale | changes_requested | accepted`. Attachment accepts only a `backlog` issue in the pod's project with no active run or conflicting execution policy; it keeps `backlog`, sets the owner as the one assignee and responsible board user, and installs review-agent then approval-user stages. It does not wake an agent.

- [ ] **Step 1: Write failing attachment tests.** Assert exact stage order/participants and owner assignment; no wake; idempotent repeat; conflicting policy, active/terminal issue, cross-project issue rejected; changing the project pod later leaves the issue binding and stages unchanged.
- [ ] **Step 2: Run `pnpm exec vitest run server/src/__tests__/coding-pod-attachment.test.ts`.** Expected: absent attachment route/binding.
- [ ] **Step 3: Implement** the binding table, atomic attach service and route. Use `normalizeIssueExecutionPolicy`; put no issue-level review preset on the owner. Record issue and pod activity in the same transaction and keep the existing single-assignee rule.
- [ ] **Step 4: Regenerate migration and run the focused test plus shared/server typechecks.** Expected: tests pass and GET exposes the pinned binding.
- [ ] **Step 5: Commit** as `Attach coding pods to parked issues`.

### Task 4: Capture an immutable candidate on ordinary issue updates

**Files:** Create `packages/db/src/schema/coding_pod_candidates.ts`, `server/src/services/coding-pod-candidates.ts`, and `server/src/__tests__/coding-pod-candidates.test.ts`; extend `server/src/routes/issues.ts`, shared coding-pod contracts, schema exports, and migration.

**Interfaces:** `CodingPodGitSnapshot = { workspaceId: string; baseSha: string; headSha: string }`. `readCodingPodCandidateSnapshot({companyId, issueId, workspaceId})` returns it using zero-cache Git reads and requires `git status --porcelain` to be empty. `insertCodingPodCandidate(tx, {binding, snapshot, reviewStageId, entryStatusVersion})` is unique by `(companyId, issueId, entryStatusVersion)` and returns an existing identical row on replay. The candidate also stores `reviewWorkspaceId: null` until Task 6. Ordinary `in_progress -> in_review|done` updates on a bound issue capture and insert before the reviewer stage/wake commits; dirty/unresolved Git returns a clear `409/422` and retains owner work.

- [ ] **Step 1: Write failing tests using temporary Git repos.** Assert clean commit captures exact base/head; dirty/untracked files and missing base ref fail; duplicate status transition reuses one candidate; status-version race leaves no reviewer assignment or candidate.
- [ ] **Step 2: Run `pnpm exec vitest run server/src/__tests__/coding-pod-candidates.test.ts`.** Expected: missing snapshot/transition behavior.
- [ ] **Step 3: Implement** bounded Git reads, company/workspace checks, transaction-scoped lifecycle lock, candidate insert, and the ordinary issue-update hook. Revalidate issue version before committing. No Git fetch occurs in this path.
- [ ] **Step 4: Regenerate migration and run the focused test plus `server/src/__tests__/issue-execution-policy-routes.test.ts`.** Expected: one candidate and one reviewer stage on success; owner retains a named repair path on failure.
- [ ] **Step 5: Commit** as `Snapshot coding candidates before review`.

### Task 5: Bridge native-run finalization into the pod review stage

**Files:** Extend `server/src/services/native-runtime/status-arbiter.ts`, `native-run-finalizer.ts`, `status-decision-committer.ts`, and `status-arbiter.test.ts`; create `server/src/services/native-runtime/coding-pod-native-finalization.test.ts`; reuse Task 4's candidate service.

**Interfaces:** Add `podReviewGate?: { reviewStageId: string; candidateSnapshot: CodingPodGitSnapshot }` to native arbitration input and effect `{ kind: 'activate_coding_pod_review'; reviewStageId: string; candidateSnapshot: CodingPodGitSnapshot }`. After higher-priority existing governance checks and before ordinary `done` completion, the arbiter selects `in_review` for a bound owner's successful completion/review request. The committer applies `applyIssueExecutionPolicyTransition` and inserts the candidate in its existing compare-and-swap transaction before any reviewer wake; replay uses the committed decision/candidate. Failed Git capture records a visible owner/recovery action and does not dispatch the reviewer. A reviewer native run still needs the existing explicit stage-decision write; its model's `done` claim alone does not approve the stage.

- [ ] **Step 1: Write failing pure and integration tests.** Assert owner native `done` becomes pending reviewer stage rather than `done`; failed/dirty workspace never wakes reviewer; status CAS race retries safely; replay creates one candidate and wake; unrelated native issue results are unchanged.
- [ ] **Step 2: Run `pnpm exec vitest run server/src/services/native-runtime/status-arbiter.test.ts server/src/services/native-runtime/coding-pod-native-finalization.test.ts`.** Expected: pod-specific failures.
- [ ] **Step 3: Implement** the new arbiter input/effect, finalizer candidate preparation, and atomic committer projection. Keep the existing status-decision effect ledger, audit, and bounded recovery semantics; do not send an untracked second wake.
- [ ] **Step 4: Run focused native finalization tests and Task 4 tests.** Expected: direct and native entry produce equivalent binding, candidate, and reviewer stage state.
- [ ] **Step 5: Commit** as `Apply pod review stages during native finalization`.

### Task 6: Contain reviewer runs and guard decisions

**Files:** Extend `server/src/services/run-trust-preset.ts`, `server/src/services/heartbeat.ts`, the issue stage-decision paths in `server/src/routes/issues.ts`, and `server/src/services/coding-pod-candidates.ts`; create `server/src/__tests__/coding-pod-review-run.test.ts` and `server/src/__tests__/coding-pod-decisions.test.ts`.

**Interfaces:** Extend `resolveAndRetainRunTrustPreset` with the issue ID; only when `executionState.currentStageId` matches the binding's review stage and `currentParticipant` is the pinned reviewer, seed the run context with `{ id: 'low_trust_review', version: 1, rawOutputDisposition: 'quarantine' }` and an `authorizationPolicy.trustBoundary` restricted to that company, project, issue, and reviewer; allow `git.read`, `github.pr.read`, and `tests.local`. Resolve the reviewer to a derived isolated workspace with `baseRef=headSha`, persist its ID on the candidate, and leave the owner's issue workspace binding unchanged. `assertCodingPodCandidateFreshForDecision` rejects reviewer or board approval if the source worktree is dirty or `HEAD !== headSha`; call it from ordinary PATCH, comment auto-approval, and recovery verdict paths. Existing explicit board override remains audited.

- [ ] **Step 1: Write failing tests.** Assert owner run is standard; reviewer run has only the scoped low-trust policy and candidate worktree; a native `done` claim without a stage decision does not approve review; an explicit review approval advances to board stage; changes requested returns to owner; stale Git rejects approval through every decision entry path; a reviewer budget stop leaves a visible recovery path; no reviewer run can write the owner branch.
- [ ] **Step 2: Run both focused test files.** Expected: missing run boundary/workspace/decision guards.
- [ ] **Step 3: Implement** the stage-specific run policy and workspace resolver, then the shared freshness guard in every authorized decision route. Preserve existing participant authorization and recovery behavior.
- [ ] **Step 4: Run both focused files, `server/src/__tests__/issue-execution-policy-routes.test.ts`, and native recovery tests touching review participants.** Expected: green; no owner trust-policy change.
- [ ] **Step 5: Commit** as `Contain coding pod review runs and decisions`.

### Task 7: Present the issue cockpit and qualify V2

**Files:** Create `ui/src/components/ProjectCodingPodCard.tsx`, `ui/src/components/IssueCodingPodPanel.tsx`, and focused tests; add `ui/src/api/codingPods.ts`; integrate in `ui/src/pages/ProjectDetail.tsx` and `IssueDetail.tsx`; update `LOCAL_PROJECT.md`.

**Interfaces:** Project card configures/validates one pod and offers the existing instance-settings path if isolated workspaces are disabled. Issue panel displays `not configured`, `owner working`, `review pending/running`, `awaiting board`, `candidate stale`, `changes requested`, and `accepted` from the GET read model. It links to the existing plan document, workspace, run ledger, work products, and stage comments; it does not duplicate their editors. Pod attachment is an explicit board action. Show API errors and stale-candidate repair instructions.

- [ ] **Step 1: Write failing React tests.** Assert empty/invalid setup, explicit attach with no automatic start, stage progress, exact SHA/diff link, stale warning, board decision controls, and visible API failure.
- [ ] **Step 2: Run `pnpm exec vitest run ui/src/pages/ProjectDetail.test.tsx ui/src/pages/IssueDetail.test.tsx` plus new component tests.** Expected: new cockpit cases fail.
- [ ] **Step 3: Implement** the API client, cards, query invalidation, and issue/project integrations using only `ui/src/index.css` tokens.
- [ ] **Step 4: Verify focused tests, `pnpm check:token-gates`, `pnpm -r typecheck`, `pnpm test:run`, and `pnpm build`; then `./script/build_and_run.sh --build-only` and the Task 1 app smoke script.** Confirm V1 and installed-app health, V2 local-source bundle and separate data. Use disposable fixtures for pod flow; do not start the user's agents without explicit authorization.
- [ ] **Step 5: Commit** as `Add governed coding cockpit to V2` and report any unrun live-agent qualification separately.
