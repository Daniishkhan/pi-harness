---
name: review
description: Adversarial pre-merge review of a finished feature. Use when implementation is done and the user wants gaps found before raising or merging a PR — reviews the diff against the actual codebase for database design flaws, duplication, performance problems, unnecessary complexity and engineering load, missing failure handling, and test bloat. Spawns fresh-context read-only reviewer subagents; the author never reviews its own work. Not for upfront design or spec writing.
---

# Adversarial pre-merge review

Find what's wrong with a finished feature before it merges. Run on the diff, judge against the actual codebase, and report only findings that come with a concrete failure scenario and a fix.

Core principle: **the author never reviews its own work.** If this session implemented the feature, the review must be done by fresh-context subagents. The implementing agent has already decided its choices are correct — it is the least adversarial reviewer available.

## Phase 1 — Target and intent

1. Determine the target: current branch vs base (`git diff <base>...HEAD`), uncommitted changes, or an existing PR (`gh pr diff <n>` if `gh` is available). Detect the base from the repo's default branch. Ask only if genuinely ambiguous.
2. Get the intent in one line — PR description, commit messages, or ask the user. A review without intent can find smells but not *gaps*.
3. Inventory the change: files touched, migrations or schema changes present, new endpoints, new dependencies. This decides which review lenses apply. Skip lenses that don't apply (no schema change → no database review).
4. Exclude generated files, lockfiles, snapshots, fixtures, and vendored code from review scope.

## Phase 2 — Independent review

Load the `pi-subagents` skill and list configured agents. Run these lenses in parallel, each as a separate fresh-context reviewer:

- **Database** → [references/database-review.md](references/database-review.md)
- **Code** (correctness, duplication, performance, complexity) → [references/code-review.md](references/code-review.md)
- **Tests & failure handling** → [references/test-review.md](references/test-review.md)
- **Correctness vs intent & gaps** → no checklist; assess the diff against the stated intent: error paths, edge cases, and what the intent implies but the diff omits.

Agent selection:

- Prefer the capability-restricted `quality-reviewer` agent for the three checklist lenses and `spec-reviewer` for correctness-vs-intent, when they are executable. These agents have no shell, edit, or write tools, so the parent must first create a mode-`0600` patch in the OS temporary directory containing the full diff, list untracked implementation files separately, and pass the patch path, changed-file list, and Git summaries. Delete the patch after all reviewers finish.
- Fallback when those agents are unavailable: generic fresh-context subagents that run `git diff <base>...HEAD` themselves. State in the report that this fallback was used.

Each reviewer prompt must include:

- the repo root plus the patch path and changed-file list (restricted agents) or the base ref to diff against (fallback), plus affected packages in a monorepo
- the one-line intent
- the path to its checklist file
- these instructions:

  - You are adversarial. Assume the diff has serious problems and find them. No praise, no executive summary.
  - Verify against the real code: read the full files, the callers, the schema. Never report from the diff alone — a finding contradicted by the code is worse than no finding.
  - Duplication findings must name the existing code (path) that should be reused instead.
  - Every finding needs: severity (blocker / should-fix / consider), file:line, the concrete failure scenario, and a specific fix. No failure scenario → it's a style opinion → drop it.
  - If a checklist section has no findings, state what you checked so silence is informative.

If subagents are unavailable in this session: run the lenses sequentially yourself, re-reading the code fresh for each, and state in the report that the review was not independent.

## Phase 3 — Triage and report

- Merge and dedupe findings across lenses. Spot-check every blocker against the code before including it.
- Drop style opinions and anything without a failure scenario.
- Add **gaps vs intent**: things the intent implies but the diff doesn't do — unhandled error paths, missing edge cases, constraints the schema should enforce but doesn't.

Report format:

```
## Review: <intent>
Target: <base>...<head> (<n> files, +x/-y)

### Blockers — must fix before merge
### Should fix — real cost, your call
### Worth considering — judgment calls
### Gaps vs intent
### Verdict
```

Verdict is one line: merge-ready after blockers are fixed, or needs rework.

Then ask the user which findings to fix. After fixes, re-run tests and re-review only the changed parts.

## Where this fits

This skill is the gate for code written **outside** the `plan → execute → ship` pipeline — ad-hoc features built in a normal session. If the change went through `/skill:execute` and was declared READY TO SHIP, spec and quality review already happened; run this only when the user wants the extra lenses (repo-wide duplication, test bloat, engineering load). After fixes, ship through the normal PR flow — `/skill:ship` requires a ready plan and does not apply to plan-less work.

## Rules

- Fresh context or it didn't happen.
- No finding without a failure scenario and a fix.
- Verify, then report.
- Blocker means data corruption, production breakage, security hole, or guaranteed rework — not "I would have done it differently."
- The best finding is code that can be deleted.
