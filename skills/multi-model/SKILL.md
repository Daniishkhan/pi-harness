---
name: multi-model
description: Run one prompt against two or three AI models side by side in a dedicated Herdr tab, collect every response, and produce a comparison with a verdict. Requires HERDR_ENV=1.
---

# Multi-Model

Run the same prompt against 2-3 AI models at once in a dedicated new Herdr tab, with each model in its own pane, and compare the results. The mechanical work (tab creation, layout, agent startup, broadcast, wait, transcript collection) is done by the helper script `fanout.sh` in this directory; this agent's job is to set up the run, interpret the manifest, and write the comparison.

## Invariants

- Only operate inside Herdr. If `test "${HERDR_ENV:-}" = 1` fails, stop and say so: this workflow requires Herdr panes. Do not fall back silently.
- The prompt must be identical, verbatim, in every lane. No per-lane tailoring unless the user explicitly asks for it.
- Never close the created tab or panes, and never send `ctrl+c`/kill agents, unless the user asks.
- Always create one dedicated tab in the caller's current workspace for the run. Use its root pane for lane 1 and split only the remaining lanes inside that tab.
- Preserve the caller tab and pane focus; the tab and all new panes are created with `--no-focus`.
- A per-lane failure (agent failed to start, stalled, timed out) is reported — it does not cancel the other lanes or the comparison.
- Panes/agents from a failed lane are left open for the user to inspect.

## Defaults

- Lanes: `claude,codex,gemini` when the user names no kinds. First check which kinds actually have binaries on this machine (`command -v claude codex gemini`). If the defaults are missing, ask one question: which lanes to use. Supported kinds are listed by `herdr agent start --help` (pi, claude, codex, gemini, cursor, copilot, kimi, grok, …).
- Pi lanes: the same kind may repeat with per-lane native args — this is the standard way to race different models when only `pi` is installed. Pass `--lane 'pi -- --provider google --model <model>'` per lane; see `pi --help` and `pi --list-models` for provider/model options.
- Timeout: 10 minutes per lane; raise it via `--timeout MS` for heavy tasks.
- Tab: create a background tab labeled `multi-model` in the caller's current workspace; never place lanes in the caller's tab.
- Direction: auto (wide new-tab root pane → `right`, tall one → `down`); override with `--direction`.
- Lane names are made unique automatically; lanes never collide with each other or previous runs.

## Workflow

1. **Resolve the task.** The prompt is whatever the user wants run (e.g. "fix the failing test in X", "review this PR", "design an API for Y"). For repo work, note the repo root.

2. **Launch the run.** Resolve `fanout.sh` against this SKILL.md's directory and run it:
   ```bash
   # different agents
   bash <skill-dir>/fanout.sh --kinds claude,codex,gemini --prompt "<the exact prompt>"
   # different models through pi lanes
   bash <skill-dir>/fanout.sh \
     --lane 'pi -- --provider google --model <model-a>' \
     --lane 'pi -- --provider anthropic --model <model-b>' \
     --prompt "<the exact prompt>"
   ```
   - `--lane SPEC` is `KIND` or `KIND -- NATIVE_ARGS...`; native args go after `--` exactly as `herdr agent start` expects them. Use `--kinds` when lanes need no args, `--lane` otherwise (never both).
   - Long or multi-paragraph prompts: write them to a temp file and pass `--prompt-file`.
   - Repo-specific tasks: pass `--cwd <repo root>` so every lane starts in the right directory.
   - Read the script's summary: run dir, dedicated tab ID, and lane table (agent name, kind, state, pane ID).

3. **Interpret `manifest.json`** in the run dir. For each lane:
   - `state: idle|done` — finished; read its transcript.
   - `state: blocked` — the model is waiting on input (approval, question, consent). Read the lane transcript (`<run>/<name>.md`) to identify the question, then relay it to the user with the lane identity. Do not answer approval/consent questions on the model's behalf. If the user answers, send the answer to that lane with `herdr agent prompt <name> "<answer>"` and re-wait.
   - `state: error|failed` — report which kind failed and the manifest `error` field; judge the remaining lanes.

4. **Write the comparison.** Read each lane's `<run>/<name>.md` transcript and write `<run>/comparison.md` with:
   - Task: the prompt (or a summary if long).
   - Lane table: model, dedicated tab, pane, final state.
   - Per-model answer: a faithful summary of each response — do not merge or smooth over differences.
   - Agreements: what all models agree on.
   - Disagreements: where they diverge, and how.
   - Strengths and weaknesses per model, grounded in the transcripts.
   - Verdict: which answer is best for this task, and why. If no clear winner, say so and state what each answer is better for.

5. **Report in chat.** Give the user: the run dir, `comparison.md` path, dedicated tab ID (`lane_tab_id` in the manifest), the lane table with pane IDs, and a concise version of the verdict. The dedicated tab and its panes remain open so they can watch each model interactively without cluttering the caller's tab.

6. **Follow-ups.** Offer: re-running with a refined prompt, asking one model to revise its answer, adding/removing lanes, or closing the lane panes (only on request).

## Failure handling

- Not in Herdr: stop immediately and explain.
- Agent start failure: relay the manifest `error` and suggest the user check that kind's binary/config; other lanes continue.
- Stalled/timeout lanes: mark as failed in the comparison; note that the pane was left open with whatever output it had.
- If the script itself errors mid-run (tab creation, pane split, etc.), report the error; the dedicated tab and panes created so far are left open.

## Notes for the orchestrator

- Use `herdr agent read <name> --source recent-unwrapped --lines 400` for transcripts; `visible` misses wrapped history.
- If a completed response is missing from scrollback (alternate-screen), ask that model's agent to write its answer to a file in the run dir and reply with the path, then read the file.
- The caller's current working directory is the default for all lanes; the script passes it explicitly.
