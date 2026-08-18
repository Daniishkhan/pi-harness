---
name: ship
description: Validate a completed plan, create the appropriate Git branch and commit, push it, and open a ready-for-review GitHub pull request targeting main. Invoke explicitly to authorize those external Git/GitHub actions.
compatibility: Requires Git, authenticated GitHub CLI (`gh`), pi-subagents, and the capability-restricted spec-reviewer agent, plus quality-reviewer when the plan declares review angles.
disable-model-invocation: true
---

# Ship

Turn a completed local implementation into a focused GitHub pull request targeting `main`.

Explicit invocation authorizes the normal shipping sequence for the supplied plan: create a branch when needed, stage in-scope files, create a commit, push the current feature branch, and open one pull request to `main`. It does **not** authorize force-pushes, history rewrites, merges, auto-merge, tags, releases, branch deletion, changing repository settings, or publishing packages.

## Safety boundaries

- Require an explicit ready plan path and read it in full. Use its requirements, files, and validation contract as the intended scope.
- Read repository contribution, commit, and pull-request instructions before acting.
- Never expose or pass credentials through tool arguments. Use existing Git and `gh` authentication.
- Never use `git add -A`, bypass hooks, force-push, amend, rebase, reset, clean, stash, or discard changes without separate explicit approval.
- Do not include secrets, private local data, unrelated files, or unrelated commits.
- Do not merge the pull request. Opening a ready-for-review PR is the end of this workflow.
- If the required remote or base differs from GitHub `origin` and `main`, stop and ask rather than silently substituting another target.

## Preflight

1. Resolve the Git root and read repository instructions.
2. Verify the plan has `status: ready`; a ready plan is read-only and must not be changed during shipping.
3. Inspect the current branch, remotes, tracking branch, status, staged/unstaged/untracked changes, recent history, and the commit range relative to `origin/main`.
4. Fetch `origin/main` without modifying the working tree.
5. Confirm the implementation diff and branch commits match the plan. Distinguish unrelated local work and leave it untouched. Stop when scope cannot be separated confidently.
6. Check for conflict markers, whitespace errors, accidentally added binaries or generated files, suspicious sensitive filenames, and likely merge conflicts.
7. Run the repository-required checks and the plan’s validation commands. Stop before staging or pushing when a required check fails. Do not bypass failing hooks or checks.
8. Load the `pi-subagents` skill, list configured agents, and verify the capability-restricted `spec-reviewer` is executable with no shell, edit, or write tools. If the plan declares review angles and a fresh review is needed (next step), also verify `quality-reviewer` is executable with the same restrictions.
9. Create a mode-`0600` patch in the operating system’s temporary directory containing the staged and unstaged diff. If `/skill:execute` declared `READY TO SHIP` in this session and the working tree, diff, and plan are unchanged since its final review (verify with `git status` and diff comparison), reuse that review instead of launching a new one. Otherwise give the plan's review set — a fresh-context `spec-reviewer`, plus one `quality-reviewer` per declared review angle — the ready plan, patch, changed and untracked file lists, Git summaries, and validation output. Reviewers must independently check their assigned surface: the `spec-reviewer` covers every requirement and acceptance criterion; each `quality-reviewer` covers its declared angle and any quality-related acceptance criteria. Delete the patch after review.
10. Stop and hand back to `/skill:execute <actual-plan-path>` if review returns P0/P1, any unmet requirement or acceptance criterion, `needs_decision`, malformed output, or a reviewer launch/failure. Shipping never fixes code.
11. Verify `gh` is installed, authenticated for the target host, and able to identify the repository. Do not print authentication details.

If currently on `main`, create a focused branch using repository conventions. Otherwise default to `fix/<slug>` for defects, `feat/<slug>` for features, and `chore/<slug>` for maintenance. Avoid renaming an existing suitable feature branch.

Being behind `origin/main` is not by itself permission to rewrite history. Report material divergence or conflicts and ask before any rebase or merge operation.

## Stage and commit

- Build an explicit list of intended paths from the plan and inspected diff, then stage only those paths.
- Include the ready plan artifact in the commit by default so the approved contract travels with the change. Exclude it when repository instructions say plans are local-only or the user explicitly requests exclusion.
- Leave unrelated changes unstaged and list them in the final report. Stop if they make validation or commit scope unreliable.
- Review the staged diff before committing.
- Preserve existing commits. If in-scope changes are uncommitted, create one coherent commit by default, following repository history and Conventional Commit style when no stronger convention exists.
- Let configured hooks run. If a hook fails or mutates files, inspect the result and revalidate; never use `--no-verify` automatically.
- Confirm the resulting commit range contains only intended work.

## Push and open the PR

1. Check whether the current branch already has an open pull request. Never create a duplicate. If its base is not `main`, stop and ask rather than retargeting it silently.
2. Push with upstream tracking using a normal non-force push.
3. If no PR exists, create a non-draft GitHub pull request with the current branch as head and `main` as base. If an existing PR is a draft, run the normal GitHub “ready for review” transition after the push; explicit invocation of this skill authorizes that transition.
4. Derive the title from the plan and commit convention. Write the body through a temporary file rather than fragile shell interpolation.
5. Include these sections:
   - **Summary**
   - **Plan and requirements**
   - **Changes**
   - **Validation** with commands and results
   - **Review** with resolved blockers and disclosed residual P2/P3 items
   - **Risks / follow-up**
6. Reference issue-closing keywords only when the plan or user explicitly identifies the issue.
7. If a PR already exists, push new commits but do not overwrite a human-authored title or body without explicit approval. Converting an existing draft to ready is the only default metadata change.

If the push succeeds but PR creation fails, do not retry blindly or alter history. Report the pushed branch, exact failure, and a safe retry command.

## Completion

Return:

- plan path;
- branch, remote, and base;
- created or existing commit hashes and subjects;
- validation results;
- pushed ref;
- pull-request URL and ready/draft state;
- any unrelated uncommitted files left untouched;
- residual risks or follow-up actions.

Stop after opening or locating the ready-for-review PR. Never merge it as part of this skill.
