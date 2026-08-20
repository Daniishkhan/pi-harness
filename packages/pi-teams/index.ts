/**
 * pi-teams — agent teams for pi.
 *
 * Phase 0: mailbox core + team lifecycle + human commands.
 * Lead/broker spawn + wake routing arrive in Phase 1 (see plan.md).
 *
 * This extension auto-loads in EVERY pi session (global scope), so it must
 * stay safe and side-effect-free outside an active team binding. Its tools
 * register at load but are deferred by the lean startup profile
 * (lean-startup.ts) and become active only after load_tool_group with
 * group "teams" — ordinary sessions pay nothing for them.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_BODY_CHARS,
  appendMessage,
  createMessage,
  cursorPath,
  getCursor,
  inboxPath,
  isValidKind,
  readInbox,
  saveCursor,
} from "./mailbox.ts";
import {
  createTeam,
  isValidName,
  loadConfig,
  teamDir,
  teamsRoot,
  updateConfig,
} from "./team.ts";
import { findBindingForSession, parseChildRunId, type Binding } from "./session-binding.ts";
import { readMemberState, type MemberState } from "./member-state.ts";
import { startBroker, stopBroker } from "./broker.ts";
import { getSubagentRpc } from "./rpc.ts";
import {
  buildJoinTask,
  ensureTeammateAgentFile,
  teammateAgentRuntimeName,
} from "./agent-files.ts";
import {
  assignTask,
  claimTask,
  completeTask,
  createTask,
  listTasks,
  unclaimTask,
  type TeamTask,
} from "./board.ts";
import { registerPlanTools } from "./plan-tools.ts";
import { registerResearchTools } from "./research-tools.ts";
import { loadProtocol } from "./protocol.ts";
import { loadResearch } from "./research.ts";
import type { Member, MessageKind, TeamConfig } from "./types.ts";

// ---------------------------------------------------------------------------
// State (per extension instance = per session)

let bound: Binding | null = null;
/** Most recent session context — used by deferred roster refresh. */
let lastUiCtx: ExtensionContext | null = null;

function requireBound(): Binding {
  if (!bound) {
    throw new Error(
      "Not in a team. Call team_start (as lead) or team_join (as teammate) first.",
    );
  }
  return bound;
}

function thisSessionIdentity(ctx: ExtensionContext): {
  sessionId?: string;
  sessionFile?: string;
} {
  return {
    sessionId: ctx.sessionManager.getSessionId(),
    sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
  };
}

/** Broker runs only in the lead's session. */
function syncBroker(pi: ExtensionAPI): void {
  if (bound?.role === "lead") {
    void startBroker(pi, bound.dir, bound.name);
  } else {
    stopBroker();
  }
}

// ---------------------------------------------------------------------------
// Shared helpers used by tools and the plan protocol

/** Append a message to a member's inbox (durable; the broker wakes them). */
async function sendTeamMail(
  dir: string,
  from: string,
  to: string,
  kind: MessageKind,
  body: string,
  refs?: string[],
): Promise<void> {
  const msg = createMessage(from, to, kind, body, refs);
  await appendMessage(inboxPath(dir, to), msg);
  await updateConfig(dir, (c) => {
    const m = c.members.find((x) => x.name === from);
    if (m) m.lastActivityAt = Date.now();
  });
}

/**
 * Spawn one member as a background child (generates its agent file).
 * Returns ok/error; does NOT mark the member failed — callers decide.
 */
async function spawnOneMember(
  pi: ExtensionAPI,
  cwd: string,
  team: string,
  target: Member,
  assignment?: string,
  timeoutMs: number = 4 * 3600 * 1000,
): Promise<{ ok: boolean; runId?: string; error?: string }> {
  const runtimeName = teammateAgentRuntimeName(team, target.name);
  try {
    await ensureTeammateAgentFile(cwd, team, target);
    const script =
      `return runs.run(${JSON.stringify(`teams-${target.name}`)}, ` +
      `{ agent: ${JSON.stringify(runtimeName)}, ` +
      `task: ${JSON.stringify(buildJoinTask(team, target, assignment))} })`;
    const data = await getSubagentRpc(pi).call(
      "spawn",
      {
        workflowScript: script,
        async: true,
        context: "fresh",
        timeoutMs,
        ...(target.model ? { model: target.model } : {}),
      },
      120_000,
    );
    const details = (data as { details?: { runId?: unknown } } | undefined)?.details;
    const runId = typeof details?.runId === "string" ? details.runId : undefined;
    return { ok: true, runId };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Roster rendering (widget in TUI, notify otherwise)

function formatTs(ts?: number): string {
  if (!ts) return "-";
  return new Date(ts).toISOString().slice(11, 19);
}

function rosterLines(
  config: TeamConfig,
  unreadByMember: Map<string, number>,
  states: Map<string, MemberState>,
): string[] {
  const lines: string[] = [];
  for (const m of config.members) {
    const marker = m.status === "active" ? "●" : m.status === "pending" ? "○" : m.status === "spawning" ? "◌" : m.status === "done" ? "✓" : "✗";
    const unread = unreadByMember.get(m.name) ?? 0;
    const title = m.title ? ` · ${m.title}` : "";
    const state = states.get(m.name);
    let extra = "";
    if (m.status === "active" && state?.idleAt) {
      const mins = Math.max(0, Math.round((Date.now() - state.idleAt) / 60_000));
      extra += ` · idle ${mins}m`;
    }
    if (state?.failures) extra += ` · ⚠ undelivered:${state.failures}`;
    lines.push(
      `${marker} ${m.name}${title} — ${m.status}${m.agent ? ` · agent=${m.agent}` : ""}` +
        (m.runId ? ` · run=${m.runId.slice(0, 8)}` : "") +
        (unread > 0 ? ` · unread:${unread}` : "") +
        extra,
    );
  }
  return lines;
}

async function buildRoster(
  dir: string,
): Promise<{ config: TeamConfig; lines: string[]; tasks: TeamTask[] } | { error: string }> {
  const config = await loadConfig(dir).catch(() => undefined);
  if (!config) return { error: `Team not found: ${dir}` };
  const unread = new Map<string, number>();
  const states = new Map<string, MemberState>();
  for (const m of config.members) {
    const cursor = await getCursor(cursorPath(dir, m.name));
    const res = await readInbox(inboxPath(dir, m.name), { sinceLine: cursor });
    unread.set(m.name, res.totalUnread);
    states.set(m.name, await readMemberState(dir, m.name));
  }
  const tasks = await listTasks(dir).catch(() => []);
  const board = {
    pending: tasks.filter((t) => t.status === "pending").length,
    inProgress: tasks.filter((t) => t.status === "in-progress").length,
    completed: tasks.filter((t) => t.status === "completed").length,
  };
  const protocol = await loadProtocol(dir).catch(() => undefined);
  const planTag =
    protocol && protocol.phase !== "approved" && protocol.phase !== "rejected"
      ? ` · plan: ${protocol.phase} (r${protocol.round}/${protocol.rounds}, v${protocol.planRev})`
      : "";
  const research = await loadResearch(dir).catch(() => undefined);
  const researchTag =
    research && research.phase !== "done"
      ? ` · research: ${research.phase} (r${research.round})`
      : "";
  const lines = [
    `pi-teams: ${config.team}  (${config.members.length} members)  ·  board: ${board.pending} pending / ${board.inProgress} in-progress / ${board.completed} done${planTag}${researchTag}`,
    ...rosterLines(config, unread, states),
  ];
  return { config, lines, tasks };
}

async function showRoster(ctx: ExtensionCommandContext | ExtensionContext, dir: string) {
  const result = await buildRoster(dir);
  if ("error" in result) {
    ctx.ui.notify(result.error, "error");
    return;
  }
  if (ctx.mode === "tui") {
    ctx.ui.setWidget("pi-teams-roster", result.lines);
  } else {
    ctx.ui.notify(result.lines.join("\n"), "info");
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Registration helper. pi.registerTool() with the same name replaces the
// previous definition, so index.ts and teammate.ts can both register the
// same tools safely when they co-load in child sessions (Phase 1).

function registerOnce(pi: ExtensionAPI, def: Parameters<ExtensionAPI["registerTool"]>[0]): void {
  pi.registerTool(def);
}

// ---------------------------------------------------------------------------
// Extension entry

export default function (pi: ExtensionAPI) {
  // Re-bind to our team when a session (re)starts — config.json is the truth.
  pi.on("session_start", async (_event, ctx) => {
    lastUiCtx = ctx;
    bound = null;
    try {
      bound = await findBindingForSession(ctx.cwd, ctx);
    } catch {
      bound = null;
    }
    syncBroker(pi);
  });

  pi.on("turn_start", async (_event, ctx) => {
    lastUiCtx = ctx;
  });

  // Ship the lead-facing skill (skills/pi-teams/SKILL.md) into every session.
  pi.on("resources_discover", async () => {
    return {
      skillPaths: [join(dirname(fileURLToPath(import.meta.url)), "skills")],
    };
  });

  pi.on("session_shutdown", async () => {
    stopBroker();
    bound = null;
  });

  // ---------------------------------------------------------------- tools

  registerOnce(pi, {
    name: "team_start",
    label: "Start Team",
    description:
      "Create a new agent team in this project and bind the current session as its lead. " +
      "Declares the roster (names + roles); members join via team_join. " +
      "Files live under .pi/teams/<name>/.",
    promptSnippet: "Create a new agent team with a named roster",
    promptGuidelines: [
      "Use team_start when the user asks to form an agent team, e.g. for plan review or deep research. Declare every member with a short title (planner, critic, scout).",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Team name (a-z, 0-9, dot, dash, underscore)" }),
      members: Type.Array(
        Type.Object({
          name: Type.String({ description: "Unique member name" }),
          title: Type.Optional(Type.String({ description: "Role label, e.g. planner, critic, scout" })),
          agent: Type.Optional(Type.String({ description: "pi-subagents agent name for spawning (Phase 1+)" })),
          model: Type.Optional(Type.String({ description: "Optional model for this member" })),
        }),
        { description: "Roster of teammates (lead is added automatically)" },
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const { name, members } = params as { name: string; members: Member[] };
      if (!isValidName(name)) {
        throw new Error(`Invalid team name "${name}": use a-z, 0-9, dot, dash, underscore (max 64 chars)`);
      }
      for (const m of members) {
        if (!isValidName(m.name)) {
          throw new Error(`Invalid member name "${m.name}": use a-z, 0-9, dot, dash, underscore`);
        }
      }
      if (new Set(members.map((m) => m.name)).size !== members.length) {
        throw new Error("Member names must be unique");
      }
      const dir = teamDir(ctx.cwd, name);
      const existing = await loadConfig(dir).catch(() => undefined);
      if (existing && bound?.dir !== dir) {
        throw new Error(`Team "${name}" already exists in this project`);
      }
      const me = thisSessionIdentity(ctx);
      const now = Date.now();
      const config: TeamConfig = {
        team: name,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        members: [
          {
            name: "lead",
            role: "lead",
            title: "team lead",
            status: "active",
            joinedAt: now,
            ...me,
          },
          ...members.map((m) => ({
            name: m.name,
            role: "teammate" as const,
            title: m.title,
            agent: m.agent,
            model: m.model,
            status: "pending" as const,
          })),
        ],
      };
      if (existing) {
        await updateConfig(dir, (c) => {
          c.members = config.members;
        });
      } else {
        await createTeam(dir, config);
      }
      await mkdir(join(dir, "blackboard"), { recursive: true });
      bound = { team: name, dir, name: "lead", role: "lead" };
      syncBroker(pi);
      await showRoster(ctx, dir);
      return {
        content: [
          {
            type: "text",
            text: `Team "${name}" ready. Lead bound to this session. Roster: ${config.members
              .map((m) => `${m.name} (${m.role}${m.title ? `, ${m.title}` : ""})`)
              .join(", ")}. Teammates must call team_join once spawned.`,
          },
        ],
        details: { team: name, members: config.members.map((m) => ({ name: m.name, role: m.role, status: m.status })) },
      };
    },
  });

  registerOnce(pi, {
    name: "team_join",
    label: "Join Team",
    description:
      "Bind the current session to a member seat on a team that already exists in this project. " +
      "After joining, this session can use team_send, team_inbox, and the shared board. " +
      "A seat that is already bound to a different session is rebound (recovery).",
    promptSnippet: "Join an existing team as a named member",
    promptGuidelines: [
      "Call team_join with your assigned team and member name as your very first action after being spawned into a team — the lead names every member at team_start.",
    ],
    parameters: Type.Object({
      team: Type.String({ description: "Team name to join" }),
      name: Type.String({ description: "Your member name, as declared by the lead" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const { team, name } = params as { team: string; name: string };
      if (!isValidName(team) || !isValidName(name)) throw new Error("Invalid team or member name");
      const dir = teamDir(ctx.cwd, team);
      const config = await loadConfig(dir).catch(() => undefined);
      if (!config) throw new Error(`Team "${team}" not found in this project`);
      const member = config.members.find((m) => m.name === name);
      if (!member) {
        throw new Error(
          `No seat named "${name}" on team "${team}". Roster: ${config.members.map((m) => m.name).join(", ")}`,
        );
      }
      const previous = member.sessionId ?? member.sessionFile ?? undefined;
      const me = thisSessionIdentity(ctx);
      await updateConfig(dir, (c) => {
        const m = c.members.find((x) => x.name === name);
        if (!m) throw new Error("Seat vanished");
        m.status = "active";
        m.joinedAt = Date.now();
        m.sessionId = me.sessionId;
        m.sessionFile = me.sessionFile;
        const child = parseChildRunId(me.sessionFile);
        if (child) m.childRunId = child;
      });
      bound = { team, dir, name, role: member.role };
      syncBroker(pi);
      await showRoster(ctx, dir);
      return {
        content: [
          {
            type: "text",
            text:
              `Joined team "${team}" as "${name}" (${member.role}).` +
              (previous && previous !== me.sessionId && previous !== me.sessionFile
                ? " Rebound from a previous session."
                : "") +
              " Use team_inbox to check mail at the start of each turn.",
          },
        ],
        details: { team, name, role: member.role },
      };
    },
  });

  registerOnce(pi, {
    name: "team_send",
    label: "Send Team Message",
    description:
      "Send a message to another team member's mailbox. Delivery is durable (appended to their inbox file). " +
      "Kinds: chat, finding, objection, plan-approval-request, plan-approval-response, shutdown. " +
      "Targeted messages only — do not spam; put artifacts on the blackboard and send a short pointer.",
    promptSnippet: "Send a message to one teammate by name",
    promptGuidelines: [
      "Use team_send to deliver findings, objections, questions, or approval requests to a specific teammate by name. Send a short pointer to any large artifact instead of pasting it. Never use team_send to ask a teammate to approve something you were denied.",
    ],
    parameters: Type.Object({
      to: Type.String({ description: "Recipient member name" }),
      body: Type.String({ description: "Message text (max 16000 chars)" }),
      kind: Type.Optional(
        Type.String({
          description: "Message kind: chat | finding | objection | plan-approval-request | plan-approval-response | shutdown (default chat)",
        }),
      ),
      refs: Type.Optional(Type.Array(Type.String(), { description: "Optional references (file paths, task ids, message ids)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const { to, body, kind, refs } = params as {
        to: string;
        body: string;
        kind?: string;
        refs?: string[];
      };
      const me = requireBound();
      if (!isValidName(to)) throw new Error(`Invalid recipient name "${to}"`);
      const resolvedKind: MessageKind = kind === undefined ? "chat" : isValidKind(kind) ? kind : "chat";
      if (typeof body !== "string" || body.trim().length === 0) {
        throw new Error("Message body must not be empty");
      }
      if (body.length > MAX_BODY_CHARS) {
        throw new Error(`Message body exceeds ${MAX_BODY_CHARS} chars — put the content in an artifact file and send a pointer`);
      }
      const config = await loadConfig(me.dir).catch(() => undefined);
      if (!config) throw new Error(`Team "${me.team}" no longer exists`);
      if (to !== me.name && !config.members.some((m) => m.name === to)) {
        throw new Error(`No member "${to}" on team "${me.team}". Roster: ${config.members.map((m) => m.name).join(", ")}`);
      }
      const msg = createMessage(me.name, to, resolvedKind, body.trim(), refs);
      await sendTeamMail(me.dir, me.name, to, resolvedKind, body.trim(), refs);
      const note = to === me.name ? " (note to self)" : "";
      return {
        content: [
          {
            type: "text",
            text: `Sent ${resolvedKind} to ${to}${note} — id ${msg.id.slice(0, 8)} at ${formatTs(msg.ts)}.`,
          },
        ],
        details: { id: msg.id, to, kind: resolvedKind, ts: msg.ts },
      };
    },
  });

  registerOnce(pi, {
    name: "team_inbox",
    label: "Check Team Inbox",
    description:
      "Read this session's team mailbox: messages sent to you since your last read. " +
      "Returns at most 50 messages; markRead advances your read cursor (default true).",
    promptSnippet: "Read new mail addressed to this session's member seat",
    promptGuidelines: [
      "Check team_inbox when you start a turn or are told a teammate messaged you. Answer objection/finding/approval-request mail before doing anything else.",
    ],
    parameters: Type.Object({
      markRead: Type.Optional(Type.Boolean({ description: "Advance the read cursor (default true)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const { markRead } = params as { markRead?: boolean };
      const me = requireBound();
      const cursor = await getCursor(cursorPath(me.dir, me.name));
      const res = await readInbox(inboxPath(me.dir, me.name), { sinceLine: cursor });
      const doMark = markRead !== false;
      const lines: string[] = [];
      for (const m of res.messages) {
        lines.push(`[${formatTs(m.ts)}] ${m.from} → ${m.kind}${m.refs?.length ? ` (refs: ${m.refs.join(", ")})` : ""}\n${m.body}`);
      }
      if (doMark) {
        await saveCursor(cursorPath(me.dir, me.name), res.lastLine);
      }
      let text: string;
      if (res.messages.length === 0) {
        text = "No unread mail.";
      } else {
        text =
          `${res.messages.length} message(s)` +
          (res.totalUnread > res.messages.length ? ` (${res.totalUnread} total unread)` : "") +
          (doMark ? ", marked read" : "") +
          ":\n\n" +
          lines.join("\n\n---\n\n");
      }
      if (res.dropped > 0) text += `\n\n(${res.dropped} malformed line(s) dropped from your inbox.)`;
      return {
        content: [{ type: "text", text }],
        details: {
          count: res.messages.length,
          totalUnread: res.totalUnread,
          dropped: res.dropped,
          markRead: doMark,
        },
      };
    },
  });

  registerOnce(pi, {
    name: "team_task",
    label: "Team Task Board",
    description:
      "Shared team task board. Tasks have status pending/in-progress/completed and may depend on other tasks. " +
      "Claiming is atomic (file-locked): only one member can hold a task, and a pending task with unresolved " +
      "dependencies cannot be claimed. Completing a task unblocks its dependents automatically.",
    promptSnippet: "Create, list, claim, complete, or unclaim tasks on the shared team board",
    promptGuidelines: [
      "Use team_task to coordinate work with teammates: the lead creates tasks (optionally assigning them); members self-claim the next unblocked task they can do. Complete a task as soon as its deliverable exists, with a short evidence note (artifact path or what was verified). Claim one task at a time.",
    ],
    parameters: Type.Object({
      action: Type.String({ description: "create | list | claim | complete | unclaim | assign" }),
      title: Type.Optional(Type.String({ description: "Task title (create)" })),
      description: Type.Optional(Type.String({ description: "Task description (create)" })),
      taskId: Type.Optional(Type.String({ description: "Target task id (claim/complete/unclaim/assign)" })),
      dependencies: Type.Optional(Type.Array(Type.String(), { description: "Task ids that must complete first (create)" })),
      assignTo: Type.Optional(Type.String({ description: "Member to assign the task to (create/assign; lead only)" })),
      evidence: Type.Optional(Type.String({ description: "Short completion evidence: what was done, artifact paths (complete)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const { action, title, description, taskId, dependencies, assignTo, evidence } =
        params as {
          action: string;
          title?: string;
          description?: string;
          taskId?: string;
          dependencies?: string[];
          assignTo?: string;
          evidence?: string;
        };
      const me = requireBound();
      const isLead = me.name === "lead";

      if (action === "create") {
        if (!title) throw new Error("team_task create requires a title");
        if (assignTo && !isLead) throw new Error("Only the lead can assign tasks at creation");
        const config = await loadConfig(me.dir).catch(() => undefined);
        if (assignTo && config && !config.members.some((m) => m.name === assignTo)) {
          throw new Error(`No member "${assignTo}" on team "${me.team}"`);
        }
        const task = await createTask(me.dir, {
          title,
          description,
          dependencies,
          createdBy: me.name,
          assignTo,
        });
        return {
          content: [
            {
              type: "text",
              text:
                `Created task ${task.id} "${task.title}"` +
                (assignTo ? `, assigned to ${assignTo}` : "") +
                (task.dependencies.length ? `, deps: ${task.dependencies.join(", ")}` : "") +
                ".",
            },
          ],
          details: { task },
        };
      }

      if (action === "list") {
        const tasks = await listTasks(me.dir);
        const lines = tasks.map((t) => {
          const holder = t.claimedBy ? ` · held by ${t.claimedBy}` : "";
          const deps = t.dependencies.length ? ` · deps: ${t.dependencies.join(",")}` : "";
          return `${t.status === "completed" ? "✓" : t.status === "in-progress" ? "▶" : "○"} ${t.id} ${t.title}${holder}${deps}`;
        });
        return {
          content: [
            {
              type: "text",
              text: tasks.length ? lines.join("\n") : "Board is empty.",
            },
          ],
          details: { tasks },
        };
      }

      if (action === "claim" || action === "assign") {
        if (!taskId) throw new Error(`team_task ${action} requires taskId`);
        if (action === "assign") {
          if (!isLead) throw new Error("Only the lead can assign tasks");
          if (!assignTo) throw new Error("team_task assign requires assignTo");
          const task = await assignTask(me.dir, taskId, assignTo);
          return {
            content: [{ type: "text", text: `Assigned task ${task.id} to ${assignTo}.` }],
            details: { task },
          };
        }
        const task = await claimTask(me.dir, taskId, me.name);
        return {
          content: [{ type: "text", text: `Claimed task ${task.id} "${task.title}".` }],
          details: { task },
        };
      }

      if (action === "complete") {
        if (!taskId) throw new Error("team_task complete requires taskId");
        const task = await completeTask(me.dir, taskId, me.name, evidence);
        return {
          content: [
            {
              type: "text",
              text: `Completed task ${task.id} "${task.title}". Dependents are now unblocked.`,
            },
          ],
          details: { task },
        };
      }

      if (action === "unclaim") {
        if (!taskId) throw new Error("team_task unclaim requires taskId");
        const task = await unclaimTask(me.dir, taskId, me.name);
        return {
          content: [{ type: "text", text: `Unclaimed task ${task.id}; it is pending again.` }],
          details: { task },
        };
      }

      throw new Error(
        `Unknown team_task action "${action}" — use create | list | claim | complete | unclaim | assign`,
      );
    },
  });

  registerOnce(pi, {
    name: "team_artifact",
    label: "Save Team Artifact",
    description:
      "Save a markdown artifact to the team blackboard (.pi/teams/<team>/blackboard/). " +
      "Sandboxed: teammates may only write their own critique files under critiques/<name>.<...>.md; " +
      "the lead may write anywhere on the blackboard. Plans are revised via team_plan_revise, not this tool.",
    promptSnippet: "Save a markdown artifact to the team blackboard",
    promptGuidelines: [
      "Use team_artifact to persist critiques and findings on the blackboard instead of pasting long content into team_send. Then send a short pointer by mail.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Path relative to the blackboard, e.g. critiques/c1.r1.md — must end in .md" }),
      content: Type.String({ description: "Markdown content (max 64KB)" }),
    }),
    async execute(_id, params, _signal, _onUpdate) {
      const { path: relPath, content } = params as { path: string; content: string };
      const me = requireBound();
      if (!relPath || relPath.includes("..") || relPath.startsWith("/") || relPath.startsWith("\\")) {
        throw new Error("Invalid artifact path: relative paths only, no traversal");
      }
      if (!relPath.endsWith(".md")) throw new Error("Artifacts must be markdown (.md)");
      if (content.length > 64 * 1024) throw new Error("Artifact content exceeds 64KB");
      if (me.name !== "lead") {
        const allowed = new RegExp(`^critiques\\/${escapeRegExp(me.name)}\\.[A-Za-z0-9._-]+\.md$`);
        if (!allowed.test(relPath)) {
          throw new Error(
            `Teammates may only save their own critique files (critiques/${me.name}.r<n>.md); got "${relPath}". Other blackboard paths are lead-only.`,
          );
        }
      }
      const { mkdir, writeFile } = await import("node:fs/promises");
      const { dirname, join } = await import("node:path");
      const target = join(me.dir, "blackboard", relPath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
      return {
        content: [{ type: "text", text: `Saved blackboard/${relPath} (${content.length} chars).` }],
        details: { path: `blackboard/${relPath}`, size: content.length },
      };
    },
  });

  registerOnce(pi, {
    name: "team_roster",
    label: "Team Roster",
    description: "Show the team roster: member status, agent, and unread mail counts.",
    promptSnippet: "Show team members and their status",
    parameters: Type.Object({
      team: Type.Optional(Type.String({ description: "Team name (defaults to the team this session is bound to)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const { team } = params as { team?: string };
      let dir: string;
      if (team) {
        if (!isValidName(team)) throw new Error("Invalid team name");
        dir = teamDir(ctx.cwd, team);
      } else {
        dir = requireBound().dir;
      }
      const result = await buildRoster(dir);
      if ("error" in result) throw new Error(result.error);
      await showRoster(ctx, dir);

      // Best-effort live token usage from the pi-subagents fleet projection.
      let fleetNote = "";
      let fleetTokens: Record<string, { input: number; output: number; total: number }> = {};
      if (bound?.role === "lead") {
        try {
          const statusData = await getSubagentRpc(pi).call("status", {}, 15_000);
          const fleet = (statusData as { fleet?: { entries?: Array<{ agent?: string; tokens?: { input: number; output: number; total: number } }> } })?.fleet;
          for (const entry of fleet?.entries ?? []) {
            if (!entry.agent || !entry.tokens) continue;
            const member = result.config.members.find((m) => m.agent === entry.agent);
            if (member) fleetTokens[member.name] = entry.tokens;
          }
          const rows = Object.entries(fleetTokens).map(
            ([name, t]) => `${name}: ${t.input}+${t.output}=${t.total} tok`,
          );
          if (rows.length) fleetNote = `\nLive token usage: ${rows.join(", ")}`;
        } catch {
          // fleet projection unavailable — roster stays functional
        }
      }
      return {
        content: [{ type: "text", text: result.lines.join("\n") + fleetNote }],
        details: {
          members: result.config.members.map((m) => ({
            name: m.name,
            role: m.role,
            status: m.status,
            agent: m.agent,
          })),
          fleetTokens,
        },
      };
    },
  });

  registerOnce(pi, {
    name: "team_spawn",
    label: "Spawn Teammates",
    description:
      "Spawn teammates for your team as background pi-subagents child sessions. " +
      "Generates a managed agent file per member (.pi/agents/teams/) and launches " +
      "each as an async workflow child whose first act is team_join. Spawned members " +
      "appear in the roster with run ids; mail delivery to them is automatic (steer " +
      "while live, resume when asleep).",
    promptSnippet: "Launch team members as background sessions",
    promptGuidelines: [
      "Use team_spawn after team_start to launch the roster. Pass a shared assignment, or spawn idle and send individual assignments with team_send.",
    ],
    parameters: Type.Object({
      members: Type.Optional(
        Type.Array(Type.String(), { description: "Member names to spawn (default: all pending or failed members)" }),
      ),
      task: Type.Optional(Type.String({ description: "Initial assignment text injected into each member's join task" })),
      timeoutMs: Type.Optional(Type.Integer({ description: "Per-run timeout in ms (default 4 hours)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const { members, task, timeoutMs } = params as {
        members?: string[];
        task?: string;
        timeoutMs?: number;
      };
      const me = requireBound();
      if (me.role !== "lead") throw new Error("Only the lead can spawn teammates");
      const config = await loadConfig(me.dir).catch(() => undefined);
      if (!config) throw new Error(`Team "${me.team}" no longer exists`);
      const targets = config.members.filter(
        (m) =>
          m.role === "teammate" &&
          (members?.length
            ? members.includes(m.name)
            : m.status === "pending" || m.status === "failed" || !m.runId),
      );
      if (targets.length === 0) {
        return {
          content: [
            {
              type: "text",
              text:
                "No teammates to spawn. Members are either already spawned or done; pass explicit member names to respawn.",
            },
          ],
          details: { results: [] },
        };
      }
      const results: Array<{ member: string; status: string; runId?: string; error?: string }> = [];
      for (const target of targets) {
        const runtimeName = teammateAgentRuntimeName(config.team, target.name);
        const outcome = await spawnOneMember(
          pi,
          ctx.cwd,
          config.team,
          target,
          task,
          timeoutMs ?? 4 * 3600 * 1000,
        );
        if (outcome.ok) {
          await updateConfig(me.dir, (c) => {
            const m = c.members.find((x) => x.name === target.name);
            if (m) {
              m.agent = runtimeName;
              m.runId = outcome.runId ?? m.runId;
              m.status = "spawning";
            }
          });
          results.push({
            member: target.name,
            status: outcome.runId ? "spawned" : "spawned (no runId reported)",
            runId: outcome.runId,
          });
        } else {
          await updateConfig(me.dir, (c) => {
            const m = c.members.find((x) => x.name === target.name);
            if (m) m.status = "failed";
          });
          results.push({ member: target.name, status: "failed", error: outcome.error });
        }
      }
      await showRoster(ctx, me.dir);
      const failed = results.filter((r) => r.status === "failed");
      return {
        content: [
          {
            type: "text",
            text:
              `Spawned ${results.length} teammate(s): ` +
              results
                .map(
                  (r) =>
                    `${r.member}=${r.status}${r.runId ? ` (${r.runId.slice(0, 8)})` : ""}${r.error ? ` — ${r.error}` : ""}`,
                )
                .join("; ") +
              (failed.length
                ? "\nMembers marked failed; fix the cause and call team_spawn with explicit member names to retry."
                : ""),
          },
        ],
        details: { results },
      };
    },
  });

  registerOnce(pi, {
    name: "team_stop",
    label: "Stop Team",
    description:
      "Stop all live teammate runs and mark teammate seats done. Mailboxes and team files stay on disk; the lead seat stays bound.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const me = requireBound();
      if (me.role !== "lead") throw new Error("Only the lead can stop the team");
      const config = await loadConfig(me.dir).catch(() => undefined);
      if (!config) throw new Error(`Team "${me.team}" no longer exists`);
      const rpc = getSubagentRpc(pi);
      const outcomes: Array<{ member: string; result: string }> = [];
      for (const m of config.members) {
        if (m.role !== "teammate" || !m.runId) continue;
        try {
          await rpc.call("stop", { id: m.runId }, 30_000);
          outcomes.push({ member: m.name, result: "stop requested" });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          outcomes.push({ member: m.name, result: `not running (${message})` });
        }
      }
      await updateConfig(me.dir, (c) => {
        for (const m of c.members) {
          if (m.role === "teammate") m.status = "done";
        }
      });
      stopBroker();
      await showRoster(ctx, me.dir);
      return {
        content: [
          {
            type: "text",
            text:
              `Team stopped. ` +
              (outcomes.map((o) => `${o.member}: ${o.result}`).join("; ") || "No live runs to stop."),
          },
        ],
        details: { outcomes },
      };
    },
  });

  registerOnce(pi, {
    name: "team_close",
    label: "Close Team",
    description:
      "Stop live teammate runs and archive the team directory to .pi/teams/.archive/ " +
      "(mailboxes, board, and blackboard are preserved for recovery). The current session unbinds.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const me = requireBound();
      if (me.role !== "lead") throw new Error("Only the lead can close the team");
      const config = await loadConfig(me.dir).catch(() => undefined);
      const rpc = getSubagentRpc(pi);
      const outcomes: string[] = [];
      if (config) {
        for (const m of config.members) {
          if (m.role !== "teammate" || !m.runId) continue;
          try {
            await rpc.call("stop", { id: m.runId }, 30_000);
            outcomes.push(`${m.name}: stopped`);
          } catch {
            outcomes.push(`${m.name}: not running`);
          }
        }
      }
      stopBroker();
      const { mkdir, rename } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const archiveDir = join(teamsRoot(ctx.cwd), ".archive");
      await mkdir(archiveDir, { recursive: true });
      const target = join(archiveDir, `${me.team}-${Date.now()}`);
      await rename(me.dir, target);
      const teamName = me.team;
      bound = null;
      if (ctx.mode === "tui") ctx.ui.setWidget("pi-teams-roster", undefined);
      return {
        content: [
          {
            type: "text",
            text:
              `Team "${teamName}" closed and archived. ` +
              (outcomes.length ? `Runs: ${outcomes.join(", ")}. ` : "") +
              `Recover it later with team_recover (team="${teamName}").`,
          },
        ],
        details: { archive: target, outcomes },
      };
    },
  });

  registerOnce(pi, {
    name: "team_recover",
    label: "Recover Team",
    description:
      "Recover a closed (archived) team: moves it back under .pi/teams/ and binds the current " +
      "session as lead. Teammate seats stay done — respawn them with team_spawn and explicit names.",
    parameters: Type.Object({
      team: Type.String({ description: "Team name to recover" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const { team } = params as { team: string };
      if (!isValidName(team)) throw new Error("Invalid team name");
      const active = teamDir(ctx.cwd, team);
      const hasActive = (await loadConfig(active).catch(() => undefined)) !== undefined;
      if (!hasActive) {
        // Look in the archive (latest entry wins).
        const { readdir, rename, mkdir } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const archiveDir = join(teamsRoot(ctx.cwd), ".archive");
        const candidates = (await readdir(archiveDir).catch(() => []))
          .filter((n) => n.startsWith(`${team}-`))
          .sort();
        if (candidates.length === 0) {
          throw new Error(`No team "${team}" found (active or archived)`);
        }
        const src = join(archiveDir, candidates[candidates.length - 1]);
        await mkdir(teamsRoot(ctx.cwd), { recursive: true });
        await rename(src, active);
      }
      const me = thisSessionIdentity(ctx);
      await updateConfig(active, (c) => {
        const lead = c.members.find((m) => m.name === "lead");
        if (lead) {
          lead.status = "active";
          lead.sessionId = me.sessionId;
          lead.sessionFile = me.sessionFile;
          lead.joinedAt = Date.now();
        }
      });
      bound = { team, dir: active, name: "lead", role: "lead" };
      syncBroker(pi);
      await showRoster(ctx, active);
      return {
        content: [
          {
            type: "text",
            text:
              `Team "${team}" recovered; this session is the lead. ` +
              "Teammate seats are done — respawn with team_spawn (explicit names).",
          },
        ],
        details: { team, dir: active },
      };
    },
  });

  registerOnce(pi, {
    name: "team_leave",
    label: "Leave Team",
    description: "Unbind this session from its team and mark its seat done. The lead cannot leave.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const me = requireBound();
      if (me.role === "lead") {
        throw new Error("The lead cannot leave its own team; use team_stop to end the team.");
      }
      await updateConfig(me.dir, (c) => {
        const m = c.members.find((x) => x.name === me.name);
        if (m) {
          m.status = "done";
          m.lastActivityAt = Date.now();
        }
      });
      bound = null;
      syncBroker(pi);
      if (ctx.mode === "tui") ctx.ui.setWidget("pi-teams-roster", undefined);
      return {
        content: [{ type: "text", text: `Left team "${me.team}" as "${me.name}".` }],
        details: { team: me.team, name: me.name },
      };
    },
  });

  // -------------------------------------------------- plan review protocol

  const teamDeps = {
    getBound: () => requireBound(),
    loadConfig: (dir: string) => loadConfig(dir),
    async dispatchMember(member: Member, assignment: string) {
      const me = requireBound();
      const config = await loadConfig(me.dir).catch(() => undefined);
      const target = config?.members.find((m) => m.name === member.name) ?? member;
      const canMail =
        target.runId !== undefined && target.status !== "done" && target.status !== "failed";
      if (canMail) {
        // Already has a (revivable) run — mail the assignment; the broker wakes it.
        await sendTeamMail(me.dir, "lead", target.name, "chat", assignment);
        return { ok: true };
      }
      const outcome = await spawnOneMember(
        pi,
        lastUiCtx?.cwd ?? process.cwd(),
        me.team,
        target,
        assignment,
      );
      if (outcome.ok) {
        await updateConfig(me.dir, (c) => {
          const m = c.members.find((x) => x.name === target.name);
          if (m) {
            m.agent = teammateAgentRuntimeName(me.team, target.name);
            m.runId = outcome.runId ?? m.runId;
            m.status = "spawning";
          }
        });
      }
      return outcome;
    },
    mail: (from: string, to: string, kind: MessageKind, body: string, refs?: string[]) => {
      const me = requireBound();
      return sendTeamMail(me.dir, from, to, kind, body, refs);
    },
    async refreshRoster() {
      const me = requireBound();
      if (lastUiCtx && lastUiCtx.mode === "tui") {
        const result = await buildRoster(me.dir);
        if (!("error" in result)) {
          lastUiCtx.ui.setWidget("pi-teams-roster", result.lines);
        }
      }
    },
  };

  registerPlanTools(pi, teamDeps);
  registerResearchTools(pi, teamDeps);

  // Quality gate (hook analog of TaskCompleted exit-2 veto): completing a
  // board task requires evidence of what was done.
  pi.on("tool_call", async (event) => {
    if (!bound || event.toolName !== "team_task") return;
    const input = event.input as { action?: string; evidence?: string } | undefined;
    if (input?.action === "complete" && (!input.evidence || !input.evidence.trim())) {
      return {
        block: true,
        reason:
          "team_task complete requires a non-empty evidence note: what was done and/or artifact paths.",
      };
    }
  });

  // -------------------------------------------------------------- commands

  pi.registerCommand("team", {
    description: "Show the team roster (pi-teams)",
    handler: async (args, ctx) => {
      if (args) {
        const name = args.trim();
        if (!isValidName(name)) {
          ctx.ui.notify(`Invalid team name: ${name}`, "error");
          return;
        }
        await showRoster(ctx, teamDir(ctx.cwd, name));
        return;
      }
      const me = bound;
      if (!me) {
        ctx.ui.notify("Not in a team. Start one with the team_start tool.", "warning");
        return;
      }
      await showRoster(ctx, me.dir);
    },
  });

  pi.registerCommand("team-inbox", {
    description: "Read your team mail and mark it read (pi-teams)",
    handler: async (_args, ctx) => {
      const me = bound;
      if (!me) {
        ctx.ui.notify("Not in a team. Join one with the team_join tool.", "warning");
        return;
      }
      const cursor = await getCursor(cursorPath(me.dir, me.name));
      const res = await readInbox(inboxPath(me.dir, me.name), { sinceLine: cursor });
      if (res.messages.length === 0) {
        ctx.ui.notify("No unread team mail.", "info");
        return;
      }
      const lines: string[] = [];
      for (const m of res.messages) {
        lines.push(`[${formatTs(m.ts)}] ${m.from} → ${m.kind}: ${m.body.slice(0, 400)}`);
      }
      await saveCursor(cursorPath(me.dir, me.name), res.lastLine);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("team-board", {
    description: "Show the shared team task board (pi-teams)",
    handler: async (_args, ctx) => {
      const me = bound;
      if (!me) {
        ctx.ui.notify("Not in a team. Join one with the team_join tool.", "warning");
        return;
      }
      const tasks = await listTasks(me.dir).catch(() => []);
      const lines = tasks.length
        ? tasks.map((t) => {
            const holder = t.claimedBy ? ` · ${t.claimedBy}` : "";
            const deps = t.dependencies.length ? ` · deps: ${t.dependencies.join(",")}` : "";
            const mark = t.status === "completed" ? "✓" : t.status === "in-progress" ? "▶" : "○";
            return `${mark} ${t.id} ${t.title}${holder}${deps}`;
          })
        : ["Board is empty."];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
