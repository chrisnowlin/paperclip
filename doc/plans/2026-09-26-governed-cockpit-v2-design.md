# Governed Coding Cockpit V2 — Design

Status: design for review · 2026-09-26

## Intent and baseline

V2 adds one governed coding pod to the standalone Paperclip app. A board member can direct a coding issue to an owner agent, see the exact commit submitted for review, receive a distinct agent's review, and make the final approval decision. The issue remains the authoritative work record. Paperclip's existing staged execution policy, checkout, session, workspace, budget, approval, activity, and recovery rules continue to govern execution.

The verified V1 source is commit `0f355c0`, preserved on `standalone-v1` and tag `standalone-v1-verified-2026-09-26`. A signed V1 app copy exists at `~/Applications/Paperclip Standalone Dev V1.app`. V2 starts from that commit on `codex/governed-cockpit-v2`. The first V2 instance starts empty; it does not copy V1 or installed-app data.

This milestone is for one owner/reviewer pair per Git-backed project. It does not add a second agent scheduler, a tmux daemon, cross-device session migration, a general chat system, or a replacement for GitHub code review. Later pod templates and attachable terminals can use this workflow after it is proven.

## Product model

| Identity | Authority in V2 |
| --- | --- |
| Company agent | Existing Paperclip employee and adapter configuration; owner and reviewer are two distinct agents in the same company. |
| Coding pod | Project-scoped configuration naming those two agents; it does not own tasks or provider sessions. |
| Source issue | The sole task, budget, approval, and completion authority. It has one assignee at a time: owner during implementation, reviewer during the review stage, board user during final approval. Existing execution policy records the return assignee. |
| Review stage | Paperclip's existing `review` execution stage, with the reviewer as typed participant and the existing review-contained trust preset. It is not a second task. |
| Approval stage | Paperclip's existing `approval` stage, with the board user as typed participant after reviewer approval. |
| Candidate | A snapshot of the exact Git base and head commits associated with one owner-to-review transition. It is evidence, not a separate task status. |
| Session/run/workspace | Existing Paperclip records. Sessions stay task-scoped, runs remain bounded invocations, and workspaces remain managed by Paperclip. |

The first cockpit lives on the existing issue detail page. It groups the plan document, owner run, workspace and Git candidate, review stage, evidence, and board approval stage in that order. Existing issue documents, work products, workspace card, run ledger, and review controls remain the underlying surfaces; the cockpit is a focused read model over them.

## V2 app boundary

V2 has a distinct SwiftPM executable/process `PaperclipStandaloneV2`, app name `Paperclip Standalone V2`, bundle ID `ing.paperclip.standalone.cnowlin.v2`, HTTP port `3319`, embedded PostgreSQL port `54333`, data directory `~/Library/Application Support/Paperclip Standalone V2`, and output `dist/Paperclip Standalone V2.app`. Its build and stop logic targets only the V2 process. The separate bundle ID also separates macOS user defaults. The source build still packages local CLI, server, and UI artifacts as V1 does.

The installed app on `3317`, the V1 dev app on `3318`, and V2 on `3319` must launch and quit independently. V2 onboarding creates a new instance; importing an existing company is a later, explicit operation using Paperclip's normal portability path.

## Coding pod configuration and workflow

A company-scoped `coding_pods` record is unique per project and stores the owner and reviewer agent IDs plus whether the pod is enabled. Configuration is a board action. Both agents must be active, distinct, in the project's company, and use an available local coding adapter. A pod cannot start work for a project without a Git-backed workspace. Existing project and issue permissions still apply. Editing this configuration does not rewrite the staged policy already pinned to an active issue.

The board opts an ordinary project issue into the pod before starting it. A company-scoped issue binding snapshots the selected pod, owner, reviewer, board user, and two stage IDs; changing the project pod later does not rewrite this binding. Attachment pins an execution policy with a reviewer-agent `review` stage followed by a board-user `approval` stage. The board user is the current actor (`local-board` in local-trusted mode); the issue retains that responsible user for escalation. The owner is the initial assignee. No agent starts merely because a pod is configured, V2 launches, or a project is opened. The owner works in a Paperclip execution workspace and uses its existing task session. Plans and implementation evidence stay on the same issue. The issue policy itself does not carry `reviewPreset`: that would incorrectly place the owner's implementation run in low-trust mode.

The owner requests `in_review` or claims completion through Paperclip's ordinary status path. Before the execution policy activates the reviewer and queues a wake, V2 validates that the owner run has settled, the selected workspace is Git-backed and clean, and a candidate commit is reachable from that workspace. A transaction-scoped workspace lifecycle lock prevents concurrent archive/reopen while it captures the resolved base and candidate SHAs; the issue status/version is revalidated before the transition and a company-scoped `coding_pod_candidates` record commit together. The record is unique by source issue and the new status version; retries reuse it. This lock does not fence arbitrary external Git writers, so board approval checks the worktree again. A dirty or unresolved candidate keeps work with the owner and surfaces a specific commit/repair action; it must not wake the reviewer on an unfixed diff.

The existing staged execution policy places the same issue in `in_review` and makes the reviewer the current participant; its `returnAssignee` preserves the owner. The reviewer run alone gets a run-scoped `low_trust_review` preset with a boundary restricted to this issue/project, plus the fixed base-to-candidate diff in a separate candidate-pinned review workspace. It cannot write the owner's working branch. The reviewer submits an approval or changes-requested decision with a required comment through the existing stage-decision path. Changes requested returns the issue to the owner for another bounded implementation round. Reviewer approval advances to the board-user approval stage. The review comment and any linked work product cite the candidate SHA; the reviewer cannot complete the issue alone.

The cockpit shows the board participant **Approve** or **Request changes** using Paperclip's existing approval-stage action. Before an approval decision, V2 checks that the source workspace still matches the reviewed candidate SHA and has no uncommitted changes, the reviewer stage was approved, no owner run is active, and no higher-priority gate remains. An outdated candidate cannot be accepted through the pod path; it returns to the owner for a new review. Board override remains an explicit, audited Paperclip control. No pod action bypasses ordinary approvals, budget pauses, or issue ownership.

## Contracts and failure behavior

The implementation adds company-scoped project pod configuration, issue bindings, candidate records, pod-attachment/read routes, and the candidate snapshot/guard around the existing stage transition. Each candidate records company, project, issue, workspace, owner, reviewer, base SHA, head SHA, review-stage ID, and entry status version. Ordinary issue updates already invoke staged execution policy, but native runner finalization commits through a separate status path; V2 must apply the pod's staged policy and candidate guard there before reviewer dispatch as well. The shared validators and types, database schema/migration, server services/routes, UI API client, and issue/project views change together. Pod configuration and attachment are board-only, enforce company/project/issue membership, and log activity. Reviewer and board decisions continue through existing participant-authorized issue updates. Candidate creation uses the new issue status version for idempotency; a failed snapshot cannot leave the issue assigned to a reviewer with no valid candidate.

The cockpit distinguishes `not configured`, `owner working`, `review pending`, `review running`, `awaiting board`, `candidate stale`, `changes requested`, and `accepted` from authoritative issue, run, workspace, execution-policy, and candidate state. It shows failures rather than silently hiding them. A reviewer failure follows Paperclip's bounded participant recovery; exhaustion exposes an explicit blocked/recovery action. Cancellation stops new work and preserves candidate and decision evidence. Provider transcripts remain with their existing session/host rules; V2 does not claim to migrate them between agents or devices.

## Acceptance and implementation order

1. Isolate and smoke-test the V2 macOS app. Prove independent ports, bundle/process IDs, data paths, and quit behavior while V1 remains runnable.
2. Add the project pod configuration and company-scoped validation. Prove configuring a pod alone starts no agents.
3. Add pod attachment, staged review/approval policy, and atomic candidate capture before reviewer dispatch. Exercise failed Git validation, status races, duplicate transitions, and reviewer recovery with disposable fixtures, without starting the user's existing agents.
4. Add the issue cockpit over existing issue components. Verify reviewer approval advances to the board, changes requested returns to the owner, and a stale candidate cannot be accepted.
5. Run targeted tests first, then the repository's required typecheck/test/build and token gate for a PR-ready handoff. Build and launch the V2 bundle, check `/api/health`, and verify V1 and the installed app remain healthy. Live agent execution requires a separate explicit user request.

The first usable slice is complete when a board user can configure one pod, run a disposable coding issue, obtain review of a fixed commit, inspect the evidence, and accept or return that candidate without disturbing V1. Additional pod sizes, cross-device sync, and live terminal attachment remain later work.
