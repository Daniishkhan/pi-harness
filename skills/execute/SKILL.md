---
name: execute
description: Execute an approved repo-local plan autonomously through a capability-restricted single-writer worker and independent reviewer/fix loop, applying conservative defaults to unsettled details without committing or pushing. Invoke explicitly with a ready plan path.
compatibility: Requires pi-subagents plus the plan-worker and spec-reviewer agents, and quality-reviewer when the plan declares review angles.
disable-model-invocation: true
---

# Execute

Implement a ready plan in a separate session. Keep the parent session as orchestrator, one capability-restricted `plan-worker` as the sole code-writing agent, and fresh-context `spec-reviewer` agents as independent gates.

Invoking this skill authorizes local edits and validation within the approved plan. It does not authorize commits, pushes, pull requests, releases, production changes, destructive Git operations, or scope beyond the plan.

## Invariants

- Require an explicit plan path and read the entire artifact.
- Require `status: ready`. If the plan is draft, missing, ambiguous, or internally inconsistent, stop and return to `/skill:plan`.
- Never edit the ready plan or maintain execution checkboxes/status in it.
- Do not create hand-maintained progress or task-state files. Use Pi-managed session and subagent run artifacts for transient state.
- Preserve all pre-existing user work. Never reset, discard, overwrite, stage, amend, rebase, or commit it.
- Use only one mutation-capable worker at a time in the active worktree.
- Reviewers are read-only, use fresh context, and inspect the actual plan, repository, and diff rather than trusting worker summaries.
- Decisions are front-loaded into the plan. During execution, resolve every unsettled detail with the most conservative default consistent with the plan and repository conventions, and record the choice. Pause for the user only when no safe default exists: destructive operations, production or external mutable systems, scope beyond the plan, or security and credential concerns.

## Preflight

1. Resolve the repository root and read its instructions.
2. Read the plan and verify its baseline branch, commit, requirements, non-goals, steps, and acceptance criteria.
3. Inspect `git status`, staged and unstaged diffs, untracked paths, current branch, and commits since the plan baseline.
4. Separate pre-existing work from implementation work. If material drift invalidates the plan or makes ownership ambiguous, stop and ask for replanning or an explicit decision. Never clean the tree automatically.
5. Determine the validation commands from repository instructions and the plan. The plan's Validation section is the pre-approved command allowlist.
6. Load the `pi-subagents` skill, call the subagent discovery/list action, and verify that `plan-worker` and `spec-reviewer` are executable; if the plan declares review angles, also verify `quality-reviewer` is executable. Confirm `plan-worker` has no shell tool and exposes `contact_supervisor`, and that every reviewer has no shell, edit, or write tools. Do not substitute broader-capability agents or silently collapse the roles.

A rerun after interruption may continue an existing partial implementation when the diff can be reconciled confidently with the plan. Otherwise stop and explain the ambiguity.

## Worker pass

Launch one asynchronous `plan-worker` as the sole code-writing agent, with attention monitoring (`control: { needsAttentionAfterMs: 300000, notifyOn: ["needs_attention"] }`), and wait for it when its result is needed. If the plan requires domain integrations, pass the matching skill through the launch `skill` parameter rather than enabling inheritSkills. Give it a compact contract containing:

- the absolute repository root and plan path;
- the approved requirements, non-goals, and acceptance criteria;
- the baseline and current working-tree state;
- relevant repository instructions;
- permission to implement only the plan, including tests and documentation required by it;
- authority to choose conservative defaults for details the plan does not settle, recording each decision and rationale;
- a ban on changing the ready plan, `.git`, task-state files, credentials, or unrelated scope;
- a requirement to escalate via `contact_supervisor` only when no safe default exists, then wait for the reply;
- validation the parent will run and evidence the worker must make possible.

After each wait or status check, answer outstanding worker asks via `subagent_supervisor({ action: "pending" })` and `reply`, resolving each from the plan and repository conventions yourself. Relay to the user only the no-safe-default cases listed in the invariants.

The restricted worker has no shell and therefore cannot stage, commit, push, run tests, install packages, or invoke generators. Ask it to return changed files, completed scope, anything left undone, decisions made with defaults and rationale, validation the parent should run, surprises, and residual risks. Never ask it to claim command results. Do not confuse worker self-attestation with independent review. Do not impose hard turn or tool-call caps on mutation-capable workers.

While the worker runs, the parent may prepare validation or inspect unaffected context, but must not edit the same worktree. When the plan flags external-dependency uncertainty, the parent may launch an async read-only researcher in parallel and feed results to the worker through `steer` or the fix loop. After the worker finishes, verify that `HEAD`, refs, index state, and remotes did not change unexpectedly. Any unauthorized Git mutation or external action ends the run as `NOT READY`; preserve evidence and do not attempt a history rewrite automatically.

The parent owns validation and any plan-explicit package-manager or generator command. Run such commands serially, never against production or external mutable systems, capture their output and exit status, and treat every resulting file change as implementation scope subject to review. Run worker-requested commands that match the plan's validation allowlist without further user confirmation.

## Independent review

After every material worker pass, inspect the resulting status and diff, run the required parent-owned validation, then launch the plan's review set in parallel, every reviewer with fresh context:

- **Spec review (always):** at least one `spec-reviewer`. Add focused parallel `spec-reviewer` runs for broad or high-risk changes, choosing distinct contract-risk angles such as security, data integrity, concurrency, migrations, public API compatibility, or user-visible behavior.
- **Quality review (only when the plan declares review angles):** one `quality-reviewer` per declared angle, focused on engineering quality beyond the contract. Never launch quality reviewers for undeclared angles or add angles mid-run; record omissions in the final report.

Because reviewers have no shell, edit, or write tools, the parent must create a mode-`0600` patch in the operating system’s temporary directory containing the staged and unstaged diff, list untracked implementation files separately, and provide the plan path, changed-file list, Git summaries, and captured validation output (including benchmark or query-plan output when the plan requires it). Reviewers read the patch and final files directly. Delete the temporary patch after all reviewers for that round finish.

Every reviewer must be told not to edit files. Each `spec-reviewer` must assess:

- the implementation against each `R*` requirement and `AC*` criterion;
- correctness, regressions, edge cases, and error paths;
- test and validation adequacy;
- unintended scope or unrelated changes;
- repository conventions.

Each `quality-reviewer` must assess its declared angle against the actual code — for example unbounded or N+1 queries, missing indexes, quadratic behavior on user-controlled input, hot-path inefficiency, or structure that obscures behavior — verifying any quality-related acceptance criteria directly.

Require a structured verdict from every reviewer with:

- `verdict`: `pass`, `changes_requested`, or `needs_decision`;
- findings containing `severity` (`P0`–`P3`), `blocking`, requirement, acceptance, or angle ID, `path:line` when applicable, evidence, impact, and smallest fix direction;
- validation gaps and residual risks.

Severity guidance:

- **P0:** catastrophic safety, security, data-loss, or unusable result.
- **P1:** material correctness, security, regression, or required-behavior failure.
- **P2:** meaningful but non-blocking defect or maintainability risk.
- **P3:** optional improvement or polish.

A finding blocks when it is P0/P1 **or when any explicit requirement or acceptance criterion is unmet, regardless of severity**. The parent must verify and synthesize findings — merging duplicates when both reviewer types cover the same quality-related acceptance criterion — rather than forwarding reviewer output blindly.

## Fix loop

- Resolve reviewer `needs_decision` verdicts and ambiguous findings with the conservative default, recording the choice. Pause as `NEEDS DECISION` and ask the user only for the no-safe-default cases. Never amend the plan in this workflow.
- If verified blocking findings are fixable within approved scope, launch one `plan-worker` with the synthesized findings as the only additional scope. Keep it as the sole code-writing agent, rerun affected validation, then run another fresh review.
- Do not ask a reviewer to fix its own findings.
- Non-blocking P2/P3 findings may be reported or fixed only when the fix is clearly in scope, low risk, and does not create another review-worthy expansion. Do not loop for optional polish.
- Cap independent review at three rounds. If blockers remain after round three, stop with `NOT READY`; preserve the diff and report what remains.
- On a worker or reviewer failure, timeout, or malformed output, inspect the transcript (`status` with `view: "transcript"`), then `resume` once with clarified instructions when the cause is instruction-fixable; use `steer` for live mid-course corrections. Stop as `NOT READY` only after a second failure or an environmental cause, preserving the partial diff and reporting run IDs and artifact paths.
- Treat failed required validation as blocking. Send an attributable in-scope defect through the fix loop; otherwise stop as `NOT READY` or, for no-safe-default cases, `NEEDS DECISION`.

## Completion

Declare `READY TO SHIP` only when:

- no verified blocking findings remain;
- all requirements and acceptance criteria are satisfied;
- required validation passes, or any unavailable check is explicitly accepted by the user;
- the parent has inspected the final diff and confirmed no staging or commits were introduced.

Do not alter the plan status. Finish with:

- plan path and baseline;
- files changed and concise diff summary;
- defaults applied, each with rationale;
- validation commands and outcomes;
- review rounds, angles covered, fixes, and dispositioned P2/P3 findings (including advisory quality findings);
- residual risks or skipped checks;
- current Git status;
- the handoff command, only when ready:

```text
/skill:ship <actual-plan-path>
```
