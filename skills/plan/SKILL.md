---
name: plan
description: Run a terminal-first, repository-grounded planning interview and produce an approved implementation handoff artifact. Invoke explicitly before implementation.
compatibility: Requires pi-subagents and the capability-restricted spec-reviewer agent for non-trivial plan review.
disable-model-invocation: true
---

# Plan

Create a durable, repo-local implementation plan through an interactive planning-only workflow. The finished plan is the contract for a separate execution session.

## Invariants

- Work only inside a Git repository. Resolve and operate from its root.
- Always create a plan artifact once the goal is known. If planning is cancelled, leave the artifact in `draft` state.
- Do not implement the change. Do not modify source, configuration, tests, dependencies, lockfiles, generated assets, Git history, or task-state files.
- The only repository deliverable this workflow may create or edit is its plan artifact. Disable subagent debug/output artifacts for readiness review so it does not add repository files.
- Investigate facts with read-only tools instead of asking the user. Ask only for requirements, preferences, priorities, and trade-offs that the user owns.
- Front-load decisions: a ready plan leaves no user-owned choice unsettled. Anything the plan does not specify is explicitly delegated to conservative, repository-consistent executor defaults.
- Quality review angles are part of the contract: declare exactly the angles execution should enforce, or `None`. Do not leave the choice to the executor.
- Ask one decision question per turn. Include a recommended answer and brief rationale.
- Keep secrets, credentials, private personal information, and irrelevant local data out of the plan.
- A ready plan is immutable during execution. Amend it only through a new explicit planning invocation.

## Create the draft

1. Read repository instructions, relevant documentation, Git status and recent history, manifests, tests, and enough implementation code to understand the request.
2. Follow imports, callers, state transitions, error paths, and existing patterns where they affect the design. Fetch authoritative external references when the request depends on them.
3. Prefer an established repository plan location. Otherwise create `plans/<descriptive-kebab-case-slug>.md` at the repository root. Never overwrite an unrelated plan.
4. Before ending the first substantive planning turn, write a useful skeleton with `status: draft`. Capture discoveries as planning continues rather than waiting until the end.
5. If amending an existing ready plan, change it back to `draft`, increment `plan_version`, and preserve a concise amendment note.

Delegate deep investigation to the `planner` agent when it is executable: give it the task, the repository root, and focused questions on architecture, integration points, risks, edge cases, and reuse opportunities, and have it inspect the code directly. It is read-only and returns findings and a proposed task breakdown — you remain the author of the artifact and the owner of the interview, and you verify its load-bearing claims against the repository yourself. If `planner` is unavailable, perform the same investigation with your own read-only tools.

Use this structure:

```markdown
---
plan_version: 1
status: draft
created: YYYY-MM-DD
updated: YYYY-MM-DD
baseline_branch: <branch>
baseline_commit: <full commit SHA>
---

# <Plan title>

## Objective
## Context
## Requirements
- R1: ...

## Non-goals
## Decisions
## Existing code and reuse
## Proposed changes
## Implementation steps
1. ...

## Files affected
## Validation
- AC1: ...

## Review angles
- <quality angle: one-line focus, e.g. db-performance: query count on the new endpoint; or None>

## Risks and mitigations
## Rollback or recovery
## Open questions
## Execution handoff
```

Use numbered requirements (`R1`, `R2`) and acceptance criteria (`AC1`, `AC2`) so implementation and review can cite them. Use numbered implementation steps, not mutable task checkboxes. Record pre-existing working-tree changes in the context without copying sensitive diff content.

End the Decisions section with the standard delegation line — “Any detail this plan does not settle is delegated to conservative, repository-consistent executor defaults, recorded in the execution report” — plus any explicit exceptions.

Spec review always runs during execution; do not list it as an angle. Under `## Review angles`, declare quality review angles (for example performance, db-performance, smells, maintainability) only when the change surface warrants them, each with a one-line focus, or write `None`. Execute launches no quality reviewer for undeclared angles. Express measurable quality expectations (query counts, latency bounds) as acceptance criteria so violations block. Propose angles when the change touches query-heavy, hot-path, or broadly refactored code, and confirm them through the normal decision dialogue. Security concerns stay with the spec review fanout during execution; do not declare them as quality angles.

## Planning dialogue

After each user answer:

1. Update the draft with the decision and its implications.
2. Inspect any newly relevant code or evidence.
3. Resolve routine engineering details yourself and record the choice.
4. Ask the next single unresolved user-owned decision with your recommendation.

Do not present a large questionnaire. Walk dependent decisions in order. If the user delegates remaining choices, choose conservative defaults consistent with the repository and record them as decisions or assumptions.

## Readiness review

A plan is ready only when it identifies the intended behavior, non-goals, exact integration points, reuse opportunities, ordered changes, validation contract, review angles suited to the change surface, risks, and recovery path, with every user-owned decision recorded in Decisions and no unresolved execution-blocking questions.

Before marking a non-trivial plan ready:

1. Load the `pi-subagents` skill and list configured agents before delegation.
2. Verify the capability-restricted `spec-reviewer` agent is executable. It must expose no shell, edit, or write tools; do not substitute the mutation-capable builtin reviewer.
3. Launch `spec-reviewer` with fresh context and with run/output artifacts disabled. Give it the exact plan path, repository root, relevant instruction paths, and a parent-produced read-only Git summary.
4. Ask it to inspect the plan and repository directly for missing requirements, unsupported assumptions, architecture conflicts, vague steps, absent validation, and choices an implementer would otherwise have to guess.
5. Correct evidence-backed engineering gaps yourself. Put newly discovered user decisions through the one-question dialogue.
6. Keep the plan in `draft` while any blocker remains.

If reviewer discovery, launch, timeout, or output validation fails, leave the artifact in `draft`, report the failure and run identifier when available, and stop. Do not mark a non-trivial plan ready without the independent review.

Treat work as non-trivial when it changes behavior across multiple components, affects data, security, public APIs, migrations, dependencies, concurrency, or has meaningful regression risk. For a truly small and obvious change, perform the same checklist yourself and note that independent plan review was skipped as disproportionate.

## Approval and exit

When the plan has passed readiness review, summarize the final approach and ask for explicit approval to mark it ready. An earlier instruction such as “finalize using your defaults” counts only if no material changes were made afterward; otherwise ask again.

On approval:

1. Set `status: ready`, update the date, make `Open questions` explicitly say `None`, and verify the Decisions delegation line is present.
2. Re-read the artifact to verify it is self-contained and internally consistent.
3. Stop planning. Do not begin implementation or launch a worker.
4. Return the plan path, baseline, and exact handoff command using the artifact’s actual repo-relative path, including any established location such as `docs/plans/`:

```text
/skill:execute <actual-plan-path>
```

After this response, the planning workflow is finished. Handle later requests normally unless the user explicitly invokes the skill again.
