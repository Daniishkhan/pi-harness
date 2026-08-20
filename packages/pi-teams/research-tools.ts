/**
 * pi-teams — deep research protocol tools (Phase 4).
 * Round 1: scouts research distinct angles, save sourced findings to the
 * blackboard, mail findings to the lead.
 * Round 2 (cross-challenge): each scout is assigned to falsify another
 * scout's findings — the competing-hypotheses pattern that fights anchoring.
 * Finish: the lead writes the synthesis (verdict.md) with per-claim
 * confidence and contradictions surfaced, never averaged away.
 */

import { readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createTask } from "./board.ts";
import {
  challengerAssignment,
  scoutAssignment,
  scoutNamesFor,
} from "./assignments.ts";
import type { PlanToolDeps } from "./plan-tools.ts";
import {
  loadResearch,
  newResearch,
  saveResearch,
  updateResearch,
  verdictPath,
} from "./research.ts";

export function registerResearchTools(pi: ExtensionAPI, deps: PlanToolDeps): void {
  pi.registerTool({
    name: "team_research_start",
    label: "Start Research",
    description:
      "Start a deep-research protocol run: scouts research distinct angles in parallel and " +
      "save sourced findings to the blackboard. The lead then runs the cross-challenge round " +
      "(team_research_challenge) where every scout tries to falsify another scout's findings, " +
      "and finishes with a synthesis (team_research_finish).",
    promptSnippet: "Start a structured multi-scout research run",
    promptGuidelines: [
      "Use team_research_start for deep research questions where parallel angles beat a single pass. Provide 2-4 distinct, non-overlapping angles; give each scout a different one so their findings genuinely compete.",
    ],
    parameters: Type.Object({
      question: Type.String({ description: "The research question" }),
      scouts: Type.Optional(Type.Array(Type.String(), { description: "Scout member names; defaults to members with scout/researcher titles" })),
      angles: Type.Optional(Type.Array(Type.String(), { description: "One angle per scout, same order; omit to let each scout pick their own" })),
    }),
    async execute(_id, params, _signal, _onUpdate) {
      const { question, scouts, angles } = params as {
        question: string;
        scouts?: string[];
        angles?: string[];
      };
      const me = deps.getBound();
      if (me.role !== "lead") throw new Error("Only the lead can start research");
      const config = await deps.loadConfig(me.dir);
      if (!config) throw new Error(`Team "${me.team}" no longer exists`);

      const existing = await loadResearch(me.dir);
      if (existing && existing.phase !== "done") {
        throw new Error(`Research is already active ("${existing.question}", phase ${existing.phase})`);
      }

      const scoutList = scoutNamesFor(config, scouts);
      if (scoutList.length === 0) {
        throw new Error("No scouts: pass scout member names or add members with scout/researcher titles");
      }
      for (const s of scoutList) {
        if (!config.members.some((m) => m.name === s)) {
          throw new Error(`No member "${s}" on team "${me.team}"`);
        }
      }
      if (angles && angles.length !== scoutList.length) {
        throw new Error(`angles (${angles.length}) must match scouts (${scoutList.length}) one-to-one, or be omitted`);
      }

      const scoutEntries = scoutList.map((name, i) => ({
        name,
        angle: angles?.[i] ?? "Pick the most load-bearing angle yourself and state it in your findings",
      }));
      const protocol = newResearch({ question, scouts: scoutEntries });
      await saveResearch(me.dir, protocol);

      const results: string[] = [];
      for (const scout of scoutEntries) {
        await createTask(me.dir, {
          title: `Research "${question.slice(0, 60)}" — ${scout.angle.slice(0, 40)} (${scout.name})`,
          createdBy: "lead",
          assignTo: scout.name,
        });
        const member = config.members.find((m) => m.name === scout.name);
        if (!member) continue;
        const assignment = scoutAssignment(me.team, question, scout.angle, 1, scout.name);
        const outcome = await deps.dispatchMember(member, assignment);
        results.push(`${scout.name}: ${outcome.ok ? "dispatched" : `failed — ${outcome.error}`}`);
      }

      await deps.refreshRoster();
      return {
        content: [
          {
            type: "text",
            text:
              `Research started: "${question}"\n` +
              scoutEntries.map((s) => `  ${s.name} → ${s.angle}`).join("\n") +
              `\n${results.join("\n")}` +
              "\n\nWait for finding mail → team_research_challenge (cross-falsification round) → team_research_finish with the synthesis. Check progress with team_research_status.",
          },
        ],
        details: { protocol, dispatch: results },
      };
    },
  });

  pi.registerTool({
    name: "team_research_status",
    label: "Research Status",
    description: "Show the active research protocol: phase, round, scout angles, findings/challenge files, and history.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate) {
      const me = deps.getBound();
      const protocol = await loadResearch(me.dir);
      if (!protocol) {
        return {
          content: [{ type: "text", text: "No active research. Start one with team_research_start." }],
          details: {},
        };
      }
      let files: string[] = [];
      try {
        files = [
          ...(await readdir(join(me.dir, "blackboard", "findings")).catch(() => [])).map(
            (f) => `blackboard/findings/${f}`,
          ),
          ...(await readdir(join(me.dir, "blackboard", "challenges")).catch(() => [])).map(
            (f) => `blackboard/challenges/${f}`,
          ),
        ].sort();
      } catch {
        // no files yet
      }
      const lines = [
        `Research "${protocol.question}" — phase: ${protocol.phase}, round ${protocol.round}`,
        ...protocol.scouts.map((s) => `  scout ${s.name}: ${s.angle}`),
        protocol.phase === "challenge" || protocol.round >= 2
          ? `challenge map: ${Object.entries(protocol.challengeMap).map(([a, b]) => `${a}→${b}`).join(", ") || "(none)"}`
          : "",
        files.length ? `files:\n  ${files.join("\n  ")}` : "files: none yet",
        `history:\n  ${protocol.history.slice(-5).join("\n  ")}`,
      ].filter(Boolean);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { protocol, files },
      };
    },
  });

  pi.registerTool({
    name: "team_research_challenge",
    label: "Cross-Challenge Round",
    description:
      "Open the cross-challenge round: every scout is assigned to falsify another scout's " +
      "findings (rotation pairing; requires 2+ scouts). Challengers verify load-bearing sources, " +
      "hunt contradictions, and save per-claim verdicts (stands/weakened/refuted) to " +
      "blackboard/challenges/. Fights anchoring — sequential investigation biases toward the " +
      "first theory, so make the scouts attack each other instead.",
    promptSnippet: "Dispatch scouts to falsify each other's findings",
    promptGuidelines: [
      "Run team_research_challenge only after every scout's findings file exists. Pair scouts by rotation so each challenges a different target than their own work.",
    ],
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate) {
      const me = deps.getBound();
      if (me.role !== "lead") throw new Error("Only the lead can open the challenge round");
      const protocol = await loadResearch(me.dir);
      if (!protocol) throw new Error("No active research");
      if (protocol.phase !== "scouting" && protocol.phase !== "challenge") {
        throw new Error(`Cannot challenge in phase ${protocol.phase}`);
      }
      if (protocol.scouts.length < 2) {
        throw new Error("Cross-challenge needs at least 2 scouts");
      }
      const config = await deps.loadConfig(me.dir);
      if (!config) throw new Error(`Team "${me.team}" no longer exists`);

      const challengeMap: Record<string, string> = {};
      const scouts = protocol.scouts.map((s) => s.name);
      for (let i = 0; i < scouts.length; i++) {
        challengeMap[scouts[i]] = scouts[(i + 1) % scouts.length];
      }
      await updateResearch(me.dir, (r) => {
        r.challengeMap = challengeMap;
        r.round = 2;
        r.phase = "challenge";
        r.history.push(`challenge round opened: ${Object.entries(challengeMap).map(([a, b]) => `${a}→${b}`).join(", ")}`);
      });

      const results: string[] = [];
      for (const [challenger, target] of Object.entries(challengeMap)) {
        await createTask(me.dir, {
          title: `Challenge ${target}'s findings (${challenger})`,
          createdBy: "lead",
          assignTo: challenger,
        });
        const member = config.members.find((m) => m.name === challenger);
        if (!member) {
          results.push(`${challenger}: no such member (skipped)`);
          continue;
        }
        const assignment = challengerAssignment(me.team, protocol.question, target, challenger);
        const outcome = await deps.dispatchMember(member, assignment);
        results.push(`${challenger}→${target}: ${outcome.ok ? "dispatched" : `failed — ${outcome.error}`}`);
      }

      await deps.refreshRoster();
      return {
        content: [
          {
            type: "text",
            text:
              `Challenge round opened:\n${results.join("\n")}` +
              "\n\nWait for challenge files + objection mail, then synthesize with team_research_finish.",
          },
        ],
        details: { challengeMap, dispatch: results },
      };
    },
  });

  pi.registerTool({
    name: "team_research_finish",
    label: "Finish Research",
    description:
      "Write the final synthesis to blackboard/verdict.md and close the research protocol. " +
      "The verdict must follow the research contract: TL;DR; findings by theme with sources; " +
      "contested points (contradictions are findings — never average them away); a " +
      "recommendation; open questions. Per-claim confidence (high/medium/low).",
    promptSnippet: "Write the research synthesis and close the run",
    promptGuidelines: [
      "Synthesize only after the challenge round. Every claim in the verdict carries a source. Surface contradictions explicitly — do not smooth them over.",
    ],
    parameters: Type.Object({
      verdict: Type.String({ description: "The full synthesis (markdown)" }),
    }),
    async execute(_id, params, _signal, _onUpdate) {
      const { verdict } = params as { verdict: string };
      const me = deps.getBound();
      if (me.role !== "lead") throw new Error("Only the lead can finish research");
      const protocol = await loadResearch(me.dir);
      if (!protocol) throw new Error("No active research");
      await mkdirp(dirname(verdictPath(me.dir)));
      await writeFile(verdictPath(me.dir), verdict.trim(), "utf8");
      await updateResearch(me.dir, (r) => {
        r.phase = "done";
        r.history.push(`synthesis written to blackboard/verdict.md (${verdict.trim().split("\n").length} lines)`);
      });
      return {
        content: [
          {
            type: "text",
            text: `Research closed. Synthesis at blackboard/verdict.md.`,
          },
        ],
        details: { protocol: await loadResearch(me.dir) },
      };
    },
  });
}

async function mkdirp(dir: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
}
