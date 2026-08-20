/**
 * pi-teams — plan review protocol tools (Phase 3).
 * The lead starts a protocol run; critics produce round-based critiques on
 * the blackboard and send objections by mail; the planner (a member or the
 * lead) revises plan.md; the lead approves or rejects with a disposition.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createTask } from "./board.ts";
import { criticAssignment, criticNamesFor, plannerDraftAssignment } from "./assignments.ts";
import type { Binding } from "./session-binding.ts";
import type { Member, MessageKind, TeamConfig } from "./types.ts";
import {
  loadProtocol,
  newProtocol,
  readPlan,
  saveProtocol,
  updateProtocol,
  writePlanRevision,
} from "./protocol.ts";

// ---------------------------------------------------------------------------
// Dependencies injected from index.ts

export interface PlanToolDeps {
  getBound(): Binding;
  loadConfig(dir: string): Promise<TeamConfig | undefined>;
  /** Spawn the member (or mail the assignment if it already has a live run). */
  dispatchMember(member: Member, assignment: string): Promise<{ ok: boolean; error?: string }>;
  /** Append a message to a member's mailbox (does not wake; broker handles it). */
  mail(from: string, to: string, kind: MessageKind, body: string, refs?: string[]): Promise<void>;
  refreshRoster(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Assignment builders live in assignments.ts (pi-free, unit-tested).

async function dispatchCritics(
  deps: PlanToolDeps,
  config: TeamConfig,
  team: string,
  title: string,
  round: number,
  critics: string[],
): Promise<string[]> {
  const results: string[] = [];
  for (const name of critics) {
    const member = config.members.find((m) => m.name === name);
    if (!member) {
      results.push(`${name}: no such member (skipped)`);
      continue;
    }
    const assignment = criticAssignment(
      team,
      title,
      round,
      deps.getBound().dir,
      name,
    );
    const outcome = await deps.dispatchMember(member, assignment);
    results.push(`${name}: ${outcome.ok ? "dispatched" : `failed — ${outcome.error}`}`);
  }
  return results;
}

// ---------------------------------------------------------------------------

export function registerPlanTools(pi: ExtensionAPI, deps: PlanToolDeps): void {
  pi.registerTool({
    name: "team_plan_start",
    label: "Start Plan Review",
    description:
      "Start a plan-review protocol run for this team: the plan lives on the blackboard " +
      "(blackboard/plan.md), critics are assigned critique tasks and dispatched, and the " +
      "protocol state (drafting/critique/revision/awaiting-approval/approved/rejected) is " +
      "recorded in protocol.json. The lead drives the loop with team_plan_revise / " +
      "team_plan_approve / team_plan_reject; critics send kind=objection mail.",
    promptSnippet: "Start a structured plan review with critics",
    promptGuidelines: [
      "Use team_plan_start when the user asks to review or draft a plan with a team. Pass the draft text (plan) when you have one; otherwise declare a planner member to draft it. After starting, wait for objection mail, merge the critiques, then revise and approve.",
    ],
    parameters: Type.Object({
      title: Type.String({ description: "Plan title" }),
      plan: Type.Optional(Type.String({ description: "Draft plan text (markdown). Omit to have the planner member draft it." })),
      planner: Type.Optional(Type.String({ description: "Planner member name; defaults to lead" })),
      critics: Type.Optional(Type.Array(Type.String(), { description: "Critic member names; defaults to members with critic/reviewer titles" })),
      rounds: Type.Optional(Type.Integer({ minimum: 1, maximum: 5, description: "Max critique rounds (default 2)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const { title, plan, planner, critics, rounds } = params as {
        title: string;
        plan?: string;
        planner?: string;
        critics?: string[];
        rounds?: number;
      };
      const me = deps.getBound();
      if (me.role !== "lead") throw new Error("Only the lead can start a plan review");
      const config = await deps.loadConfig(me.dir);
      if (!config) throw new Error(`Team "${me.team}" no longer exists`);

      const existing = await loadProtocol(me.dir);
      if (existing && existing.phase !== "approved" && existing.phase !== "rejected") {
        throw new Error(
          `A plan review is already active ("${existing.title}", phase ${existing.phase}, round ${existing.round}). Finish it first.`,
        );
      }

      const plannerName = planner ?? "lead";
      if (plannerName !== "lead" && !config.members.some((m) => m.name === plannerName)) {
        throw new Error(`No member "${plannerName}" on team "${me.team}"`);
      }
      const criticList = criticNamesFor(config, critics);
      if (criticList.length === 0) {
        throw new Error("No critics: pass critic member names or add members with critic/reviewer titles");
      }
      for (const c of criticList) {
        if (!config.members.some((m) => m.name === c)) {
          throw new Error(`No member "${c}" on team "${me.team}"`);
        }
      }
      const maxRounds = rounds ?? 2;

      const protocol = newProtocol({ title, planner: plannerName, critics: criticList, rounds: maxRounds });
      await saveProtocol(me.dir, protocol);

      // One board task per critic, assigned up front (they complete it with
      // their critique path as evidence — enforced by the evidence gate).
      for (const critic of criticList) {
        await createTask(me.dir, {
          title: `Critique "${title}" round 1 (${critic})`,
          createdBy: "lead",
          assignTo: critic,
        });
      }

      const results: string[] = [];
      if (plan !== undefined && plan.trim()) {
        const rev = await writePlanRevision(me.dir, plan.trim());
        await updateProtocol(me.dir, (p) => {
          p.planRev = rev;
          p.phase = "critique";
          p.history.push(`round ${p.round}: lead supplied draft (rev ${rev}); critics dispatched`);
        });
        results.push(...(await dispatchCritics(deps, config, me.team, title, 1, criticList)));
      } else {
        // Planner drafts first.
        if (plannerName === "lead") {
          await updateProtocol(me.dir, (p) => {
            p.phase = "drafting";
            p.history.push("drafting: lead will write the draft via team_plan_revise");
          });
          results.push("planner=lead: write the draft yourself, then call team_plan_revise with the full plan text");
        } else {
          const plannerMember = config.members.find((m) => m.name === plannerName);
          if (plannerMember) {
            const outcome = await deps.dispatchMember(
              plannerMember,
              plannerDraftAssignment(me.team, title),
            );
            results.push(`planner ${plannerName}: ${outcome.ok ? "dispatched" : `failed — ${outcome.error}`}`);
          }
        }
      }

      await deps.refreshRoster();
      return {
        content: [
          {
            type: "text",
            text:
              `Plan review started: "${title}" (planner=${plannerName}, critics=${criticList.join(", ")}, rounds=${maxRounds}).\n` +
              results.join("\n") +
              `\n\nDrive the loop: wait for objection mail → merge critiques → team_plan_revise (full revised plan text) → team_plan_approve with a disposition of how each objection was addressed or dismissed. Check progress with team_plan_status.`,
          },
        ],
        details: { protocol, dispatch: results },
      };
    },
  });

  pi.registerTool({
    name: "team_plan_status",
    label: "Plan Review Status",
    description: "Show the active plan review protocol: phase, round, plan revision, critique files, and history.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate) {
      const me = deps.getBound();
      const protocol = await loadProtocol(me.dir);
      if (!protocol) {
        return {
          content: [{ type: "text", text: "No active plan review. Start one with team_plan_start." }],
          details: {},
        };
      }
      let critiqueFiles: string[] = [];
      try {
        critiqueFiles = (await readdir(join(me.dir, "blackboard", "critiques")))
          .filter((f) => f.endsWith(".md"))
          .sort();
      } catch {
        // no critiques yet
      }
      const plan = await readPlan(me.dir);
      const lines = [
        `Plan review "${protocol.title}" — phase: ${protocol.phase}, round ${protocol.round}/${protocol.rounds}, plan rev ${protocol.planRev}`,
        `planner: ${protocol.planner} · critics: ${protocol.critics.join(", ")}`,
        critiqueFiles.length
          ? `critique files: ${critiqueFiles.map((f) => `blackboard/critiques/${f}`).join(", ")}`
          : "critique files: none yet",
        `plan at blackboard/plan.md (${plan ? `${plan.split("\n").length} lines` : "missing"})`,
        `history:\n  ${protocol.history.slice(-6).join("\n  ")}`,
      ];
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { protocol, critiqueFiles, planLines: plan?.split("\n").length ?? 0 },
      };
    },
  });

  pi.registerTool({
    name: "team_plan_revise",
    label: "Revise Plan",
    description:
      "Save the next plan revision to the blackboard (archives the previous one). " +
      "After the last critique round this moves the protocol to awaiting-approval; " +
      "otherwise it opens the next critique round and re-dispatches critics. " +
      "A planner member can call it too (their revisions auto-request approval from the lead).",
    promptSnippet: "Save a revised plan revision",
    promptGuidelines: [
      "Use team_plan_revise with the FULL revised plan text — the blackboard holds one current plan.md and archived revisions. Merge every objection first; mention in the note how the revision addresses them.",
    ],
    parameters: Type.Object({
      plan: Type.String({ description: "Full revised plan text (markdown)" }),
      note: Type.Optional(Type.String({ description: "Short note: what changed and why (logged to protocol history)" })),
    }),
    async execute(_id, params, _signal, _onUpdate) {
      const { plan, note } = params as { plan: string; note?: string };
      const me = deps.getBound();
      const protocol = await loadProtocol(me.dir);
      if (!protocol) throw new Error("No active plan review — start one with team_plan_start");
      const isPlanner = protocol.planner === me.name;
      if (!isPlanner && me.role !== "lead") {
        throw new Error(`Only ${protocol.planner} or the lead can revise this plan`);
      }
      const config = await deps.loadConfig(me.dir);
      if (!config) throw new Error(`Team "${me.team}" no longer exists`);

      const rev = await writePlanRevision(me.dir, plan.trim());
      const log = `round ${protocol.round}: rev ${rev} by ${me.name}${note ? ` — ${note}` : ""}`;
      await updateProtocol(me.dir, (p) => {
        p.planRev = rev;
        p.history.push(log);
      });

      const lines: string[] = [`Saved plan rev ${rev}.`];
      if (protocol.round >= protocol.rounds) {
        await updateProtocol(me.dir, (p) => {
          p.phase = "awaiting-approval";
        });
        lines.push("Final round reached — protocol is awaiting-approval.");
        if (protocol.planner !== "lead") {
          // Planner submitted the final revision: ask the lead for approval.
          await deps.mail(
            me.name,
            "lead",
            "plan-approval-request",
            `Plan "${protocol.title}" rev ${rev} is ready for approval. ${note ?? ""}`,
            [`blackboard/plan.md`],
          );
          lines.push("Approval requested from lead.");
        }
      } else {
        await updateProtocol(me.dir, (p) => {
          p.round = p.round + 1;
          p.phase = "critique";
          p.history.push(`round ${p.round}: critics re-dispatched on rev ${rev}`);
        });
        for (const critic of protocol.critics) {
          await createTask(me.dir, {
            title: `Critique "${protocol.title}" round ${protocol.round + 1} (${critic})`,
            createdBy: "lead",
            assignTo: critic,
          });
        }
        const dispatch = await dispatchCritics(
          deps,
          config,
          me.team,
          protocol.title,
          protocol.round + 1,
          protocol.critics,
        );
        lines.push(`Critique round ${protocol.round + 1} opened.`);
        lines.push(...dispatch.map((d) => `  ${d}`));
      }
      await deps.refreshRoster();
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { rev, phase: (await loadProtocol(me.dir))?.phase },
      };
    },
  });

  pi.registerTool({
    name: "team_plan_approve",
    label: "Approve Plan",
    description:
      "Approve the current plan revision and close the protocol as approved. Record a " +
      "disposition of how objections were handled — every objection must be addressed or " +
      "explicitly dismissed. Mails plan-approval-response to the planner member when there is one.",
    promptSnippet: "Approve the plan and close the review",
    promptGuidelines: [
      "Approve only when every objection from every critique file is addressed or explicitly dismissed. Put that disposition in the disposition parameter — it is the approval record.",
    ],
    parameters: Type.Object({
      disposition: Type.Optional(Type.String({ description: "How objections were handled (the approval record)" })),
    }),
    async execute(_id, params, _signal, _onUpdate) {
      const { disposition } = params as { disposition?: string };
      const me = deps.getBound();
      if (me.role !== "lead") throw new Error("Only the lead can approve the plan");
      const protocol = await loadProtocol(me.dir);
      if (!protocol) throw new Error("No active plan review");
      await updateProtocol(me.dir, (p) => {
        p.phase = "approved";
        p.history.push(
          `APPROVED rev ${p.planRev} by lead${disposition ? ` — disposition: ${disposition}` : ""}`,
        );
      });
      if (protocol.planner !== "lead") {
        await deps.mail(
          "lead",
          protocol.planner,
          "plan-approval-response",
          `Plan "${protocol.title}" rev ${protocol.planRev} APPROVED.${disposition ? ` Disposition: ${disposition}` : ""}`,
          ["blackboard/plan.md"],
        );
      }
      return {
        content: [
          {
            type: "text",
            text: `Plan "${protocol.title}" rev ${protocol.planRev} approved. Review closed.`,
          },
        ],
        details: { protocol: await loadProtocol(me.dir) },
      };
    },
  });

  pi.registerTool({
    name: "team_plan_reject",
    label: "Reject Plan",
    description:
      "Reject the current plan revision with feedback and close the protocol as rejected. " +
      "Mails plan-approval-response (rejected + feedback) to the planner member when there is one.",
    parameters: Type.Object({
      feedback: Type.String({ description: "Why the plan was rejected and what must change" }),
    }),
    async execute(_id, params, _signal, _onUpdate) {
      const { feedback } = params as { feedback: string };
      const me = deps.getBound();
      if (me.role !== "lead") throw new Error("Only the lead can reject the plan");
      const protocol = await loadProtocol(me.dir);
      if (!protocol) throw new Error("No active plan review");
      await updateProtocol(me.dir, (p) => {
        p.phase = "rejected";
        p.history.push(`REJECTED rev ${p.planRev} by lead — ${feedback}`);
      });
      if (protocol.planner !== "lead") {
        await deps.mail(
          "lead",
          protocol.planner,
          "plan-approval-response",
          `Plan "${protocol.title}" rev ${protocol.planRev} REJECTED. Feedback: ${feedback}`,
          ["blackboard/plan.md"],
        );
      }
      return {
        content: [
          {
            type: "text",
            text: `Plan "${protocol.title}" rev ${protocol.planRev} rejected. Review closed.`,
          },
        ],
        details: { protocol: await loadProtocol(me.dir) },
      };
    },
  });
}
