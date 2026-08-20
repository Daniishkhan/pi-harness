/**
 * Phase 4 unit tests — deep research protocol (plain node):
 *   node test/phase4.test.ts
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  challengePath,
  findingsPath,
  loadResearch,
  newResearch,
  saveResearch,
  updateResearch,
  verdictPath,
} from "../research.ts";
import {
  challengerAssignment,
  scoutAssignment,
  scoutNamesFor,
} from "../assignments.ts";
import type { TeamConfig } from "../types.ts";

let failures = 0;
function check(name: string, cond: boolean, extra?: string): void {
  if (cond) console.log(`PASS  ${name}`);
  else {
    failures++;
    console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-teams-research-"));
  try {
    // --- protocol lifecycle ----------------------------------------------------
    const protocol = newResearch({
      question: "Which runtime for a CLI tool?",
      scouts: [
        { name: "s1", angle: "performance" },
        { name: "s2", angle: "ecosystem" },
      ],
    });
    await saveResearch(root, protocol);
    const loaded = await loadResearch(root);
    check("research persists", loaded?.phase === "scouting" && loaded?.scouts.length === 2);

    const updated = await updateResearch(root, (r) => {
      r.phase = "challenge";
      r.round = 2;
      r.challengeMap = { s1: "s2", s2: "s1" };
    });
    check("research update persists", updated.phase === "challenge" && updated.challengeMap.s1 === "s2");
    check("missing research errors", await updateResearch(join(root, "nope"), async () => {}).then(() => false).catch(() => true));

    // --- path conventions ---------------------------------------------------------
    check("findings path round-suffixed", findingsPath(root, "s1", 1).endsWith("findings/s1.r1.md"));
    check("challenge path pair-named", challengePath(root, "s1", "s2").endsWith("challenges/s1-on-s2.md"));
    check("verdict path", verdictPath(root).endsWith("blackboard/verdict.md"));

    // --- assignment builders --------------------------------------------------------
    const sa = scoutAssignment("t", "Q", "performance angle", 1, "s1");
    check("scout assignment demands sources", sa.includes("source URL"));
    check("scout assignment demands confidence", sa.includes("high/medium/low"));
    check("scout assignment forbids invented sources", sa.includes("Do not invent sources"));
    check("scout assignment uses team_artifact", sa.includes("team_artifact"));
    check("scout assignment wants finding mail", sa.includes("kind=finding"));

    const ca = challengerAssignment("t", "Q", "s2", "s1");
    check("challenger assignment targets findings file", ca.includes("findings/s2.r1.md"));
    check("challenger demands per-claim verdicts", ca.includes("stands / weakened / refuted"));
    check("challenger forbids averaging", ca.includes("do not average them away"));
    check("challenger uses team_artifact", ca.includes("team_artifact"));

    // --- scout name discovery -------------------------------------------------------
    const config: TeamConfig = {
      team: "t",
      createdAt: 0,
      updatedAt: 0,
      members: [
        { name: "lead", role: "lead", status: "active" },
        { name: "r1", role: "teammate", title: "research scout", status: "pending" },
        { name: "r2", role: "teammate", title: "analyst", status: "pending" },
        { name: "c1", role: "teammate", title: "critic", status: "pending" },
      ],
    };
    check("scout discovery by title", scoutNamesFor(config).join(",") === "r1,r2");
    check("explicit scouts win", scoutNamesFor(config, ["c1"]).join(",") === "c1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  console.log("");
  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
