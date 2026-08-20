# pi-teams

Agent teams for [pi](https://github.com/earendil-works/pi-mono): spawned
teammates (pi-subagents child sessions) with a durable **file mailbox**, a
shared **task board**, and structured **protocols for plan review and deep
research** — modeled on Claude Code's agent teams.

Teammates are full independent sessions that message each other directly;
mail delivery is automatic (steer into live children, revive asleep ones).
The lead stays the orchestrator and decision-maker.

## Layout

```
~/.pi/agent/extensions/pi-teams/
  index.ts          extension entry: team tools, commands, broker, gates
  teammate.ts       child-session glue (loaded via subagentOnlyExtensions)
  broker.ts         lead-side mail delivery (watch → steer/resume)
  mailbox.ts        append-only JSONL inboxes, validated reads, cursors
  board.ts          locked shared task board with dependencies
  protocol.ts       plan-review state (blackboard + revision archive)
  research.ts       deep-research state (angles + challenge map)
  plan-tools.ts     team_plan_* tools
  research-tools.ts team_research_* tools
  assignments.ts    pure assignment-text builders
  agent-files.ts    generated teammate agent files (.pi/agents/teams/)
  member-state.ts   idle heartbeats + undelivered-mail flags
  session-binding.ts session → member seat binding
  rpc.ts            pi-subagents RPC client (subagents:rpc:v1:*)
  lock.ts           cross-process file locking
```

Per-team data lives in the project: `.pi/teams/<team>/` (config.json,
inboxes/, board/, blackboard/, protocol/research state).

## Quick start

```bash
# In a project, tell pi to form a team:
# "Use team_start to create a team 'review' with critics c1, c2 (title: critic)
#  and team_spawn to launch them. Then team_plan_start with my plan text."

# Watch the roster: /team   · read mail: /team-inbox   · board: /team-board
```

The lead session drives everything with tools: `team_start`, `team_spawn`,
`team_send`, `team_inbox`, `team_task`, `team_artifact`, `team_plan_*`,
`team_research_*`, `team_stop`, `team_close`, `team_recover`. Full guidance
for the lead lives in `SKILL.md` (loads as a pi skill when installed).

## Tool profiles per member title

| Title matches | Extra tools |
|---|---|
| `critic`, `reviewer`, `checker` | read-only + team tools |
| `planner`, `writer`, `coder`, `editor` | + bash, write, edit |
| `research`, `scout`, `analyst` | + bash, web tools |

Override per member with `tools: "read, grep, ..."` in `team_start`.

## Testing

```bash
npm install            # dev deps (typescript, @types/node)
npx tsc --noEmit       # typecheck (tsconfig maps pi's packages)
for t in test/phase*.test.ts; do node $t; done
```

`plan.md` contains the phased build plan with per-phase acceptance evidence.

## Install

Global extension (auto-discovered by pi): clone/symlink this directory into
`~/.pi/agent/extensions/pi-teams/` (it must contain `index.ts`). Requires the
pi-subagents package (already bundled with pi) — pi-teams calls its extension
RPC, it does not fork it.

## Known limitations (v1)

- Revive targets work within a live lead process. After the lead restarts,
  pi-subagents' in-memory run state is gone, so stale runIds are unresolvable;
  use `team_recover` + `team_spawn` (explicit names) to bring members back.
- Message delivery is push-with-fallback: if both steer and revive fail, mail
  stays in the inbox and the roster shows `undelivered:N` for that member.
