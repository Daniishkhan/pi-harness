# pi-teams — plan

Agent teams for pi: spawned teammates (pi-subagents children) that message each
other through a durable file mailbox, coordinate through a shared task board,
and run structured protocols for plan review and deep research. Built as a pi
extension that composes pi-subagents through its documented extension RPC.

## Decisions (locked in brainstorm)

1. **Teammate runtime = pi-subagents children.** Async headless pi sessions,
   spawned via the `subagents:rpc:v1:request` RPC (`spawn`, `workflowScript`).
   Reuse steer/resume/status/missions/fleet — no new process manager.
2. **pi-teams depends on pi-subagents**; it calls the RPC, never forks it.
3. **Shared task board is in scope from day one** (Phase 2), not an add-on.
4. **Spawned teams only.** No cross-session messaging between independent pi
   sessions. Revisit later as v2.

## Architecture

```
lead session (pi)                         teammate sessions (pi, headless)
┌───────────────────────────────┐        ┌──────────────────────────────┐
│ pi-teams/index.ts (broker)    │        │ pi-teams/teammate.ts         │
│  - /team, team_send,          │  spawn │  (loaded via subagentOnly-   │
│    team_task tools            │ ─────► │   Extensions on generated    │
│  - fs.watch on inboxes/       │        │   team agent files)          │
│  - steer live / resume asleep │        │  - team_send, team_inbox,    │
│    via pi-subagents RPC       │        │    team_task, team_join      │
└──────────────┬────────────────┘        └──────────────┬───────────────┘
               │                                        │
               └────────── file mailbox (truth) ─────────┘
   .pi/teams/<team>/config.json, inboxes/<name>.jsonl,
   board/tasks.json, blackboard/
```

- **Mailbox is the only cross-process channel.** `pi.events` is process-local;
  children are separate processes. Append-only JSONL, schema-validated on read
  (malformed entries dropped, not fatal) — mirrors Claude Code agent teams.
- **Broker runs in the lead process** (where pi-subagents lives). One broker
  per team; lead may host several teams (scope by team id).
- **Identity:** teammate names are assigned by the lead at spawn; the child
  binds itself with `team_join({team, name})`, correlating via its own session
  file. Broker records `name → runId` from spawn/status for wake routing.
- **Writes:** single-writer rule preserved. In plan review, planner is the only
  writer of `blackboard/plan.md`; critics are read-only. No agent may edit
  another agent's files.

## Storage layout (project-scoped)

```
.pi/teams/<team>/
  config.json           # { members: [{name, agent, runId?, sessionFile?, status}] }
  inboxes/<name>.jsonl  # append-only; {id, ts, from, to, kind, body, refs?}
  board/tasks.json      # [{id, title, status: pending|in-progress|completed,
                        #   dependencies: [], claimedBy?, evidence?}]
  blackboard/           # plan.md, critiques/<name>.md, findings/
```

Message `kind ∈ chat | finding | objection | plan-approval-request |
plan-approval-response | shutdown`.

## Phases

### Phase 0 — Scaffold + mailbox core ✅ DONE
- `mailbox.ts` (append-only JSONL, schema-validated reads, line-index cursors),
  `team.ts`, `lock.ts`, tools `team_start/join/send/inbox/roster/leave`,
  commands `/team`, `/team-inbox`.
- Evidence: unit tests `test/phase0.test.ts` (17 checks, concurrent locked
  appends, malformed-line drops, cursor semantics) + 3-process print-mode
  e2e (create → join+send → rebind+read). Cursor switched from timestamps
  to physical line indices after tests exposed a re-read bug.

### Phase 1 — Spawn + broker delivery ✅ DONE
- RPC client over `pi.events` (`subagents:rpc:v1:*`), `team_spawn` (generated
  agent files under `.pi/agents/teams/` with `subagentOnlyExtensions` →
  `teammate.ts`), `team_stop`, lead broker (`fs.watch` → steer live / resume
  asleep / leave queued), lead self-delivery via `pi.sendMessage`,
  teammate mail-reminder glue.
- Key discovery: RPC spawn always runs a workflow; **revive must target the
  child's own runId** (workflow ids fail with "missing run fan-out recovery
  identity"). Child runId is parsed from the child's sessionFile path at
  `team_join` and stored as `member.childRunId`; revival ids are re-tracked
  after each resume.
- Evidence: e2e `rev5` — spawned critic joined, went idle, lead mailed it,
  broker steered (failed on asleep child) → resumed by child id → revived
  critic replied `pong-critic` → delivered into lead. Chat-loop guard added
  ("never reply to pure acknowledgments"). Diagnostic stderr logs retained
  for now; trimmed in Phase 5.
- Known limitation (accepted v1): revive works within the live lead process;
  after a lead restart, pi-subagents' in-memory state is gone and stale
  runIds are unresolvable → mail stays queued, member respawn via
  `team_spawn` with explicit names. `/team recover` deferred to Phase 5.

### Phase 2 — Shared task board ✅ DONE
- `board.ts` (locked read-modify-write, atomic claims, dependency
  auto-unblock, holder-only completion, lead assignment bypass), `team_task`
  tool (create/list/claim/complete/unclaim/assign), board counts in the
  roster widget, `/team-board` command, board etiquette in teammate prompts.
- Evidence: `test/phase2.test.ts` (13 checks incl. concurrent claim race →
  exactly one winner, dependency blocking/unblocking) + e2e `rev6`: spawned
  worker claimed and completed a 2-task dependency chain with evidence,
  verified on disk.

### Phase 3 — Plan review protocol ✅ DONE
- `protocol.ts` (durable phase/round/rev state + history), `assignments.ts`,
  `plan-tools.ts`: `team_plan_start/status/revise/approve/reject`. Blackboard:
  plan.md + archived revs + per-critic critique files. Board tasks per
  critique round, assigned to critics.
- Sandboxed `team_artifact` write tool (teammates may only write their own
  `critiques/<name>.r<n>.md`; lead writes anywhere on the blackboard) —
  critics stay read-only on the repo.
- Quality gate: `tool_call` blocks `team_task complete` without an evidence
  note (hook analog of TaskCompleted exit-2 veto).
- Evidence: `test/phase3.test.ts` (13 checks) + e2e `rev7`: 2 spawned critics
  produced severity-graded adversarial critiques, completed board tasks with
  evidence, lead merged → rev 2 → approved with a disposition mapping every
  objection (c1#1-6, c2#1-5) to its resolution.

### Phase 4 — Deep research protocol ✅ DONE
- `research.ts` (durable state + challenge map), `research-tools.ts`:
  `team_research_start/status/challenge/finish`. Blackboard: findings per
  scout per round, adversarial challenge files, verdict.md. Synthesis
  contract: sourced claims, per-claim confidence, contested points,
  recommendation, open questions.
- Evidence: `test/phase4.test.ts` (15 checks) + e2e `rev8`: 2 spawned scouts
  researched runtime-performance vs ecosystem angles with sourced findings,
  cross-challenge round produced stands/weakened/refuted verdicts (s2's
  late objection still landed and was folded in), lead wrote a sourced
  verdict with contested points and a decision gate (11 source URLs).

### Phase 5 — Hardening + packaging ✅ DONE
- Teammate idle heartbeats + undelivered-mail flags on disk
  (`member-state.ts`); roster shows `idle Xm` and `⚠ undelivered:N`.
  Broker diagnostics trimmed to failures only; failure flags clear on
  successful delivery.
- `team_close` (stop runs + archive team dir) and `team_recover` (restore +
  rebind lead); verified in a print-mode e2e round trip.
- `team_roster` surfaces live token usage from the pi-subagents fleet
  projection (best-effort).
- Lead-facing `skills/pi-teams/SKILL.md` registered via `resources_discover`;
  `README.md` (layout, quick start, profiles, limitations).
- Packaging: stays a local global extension (`package.json` with
  `pi.extensions` entry ready for git/npm pi-package installs).
- Final regression: 5 suites green (phase0-4), tsc clean, extension loads in
  a fresh pi process.

## Testing strategy

- Dev in a scratch git repo (never the pi-teams extension dir itself — sibling
  worktrees under `~/.pi/agent/extensions` are forbidden by pi-subagents
  constraints; auto-load would register duplicate tools).
- Per phase: manual script first (fake peers via `/team` commands), then a real
  spawned teammate; keep a smoke-test checklist in `test/`.
- During dev, every unshipped tool is registered but `no-op`s without a team,
  so a broken WIP extension can't break ordinary sessions.

## Risks / open items (post-build status)

- ~~RPC shape~~ ✅ RESOLVED: spawn replies carry `details.runId`; fleet
  projection works via `status` (used in `team_roster`).
- ~~Steer semantics~~ ✅ RESOLVED: steer targets the child id while live;
  revive must use the CHILD runId (parsed from the child sessionFile at
  join). Re-tracked after every revival.
- **Lead death/restart** ⚠ ACCEPTED v1: files persist and `team_recover`
  rebinds the lead, but stale runIds are unresolvable in a new process
  (pi-subagents state is in-memory). Respawn members explicitly. Revive
  across lead restarts is the first v2 candidate.
- ~~Env/inheritance~~ ✅ RESOLVED: generated agent files carry everything
  (tools, subagentOnlyExtensions, model, system prompt).
- **Scale** ⚠ MONITORED: inbox reads cap at 50 unread and bodies at 16KB;
  no compaction of large inboxes yet — fine for team-scale traffic.

## Deferred (explicitly out of v1)

- Cross-session messaging (independent pi sessions)
- Full A2A protocol / external agent interop
- Split-pane/interactive teammate terminals (FleetView covers inspection)
- Scheduled teams, multi-team choreography
