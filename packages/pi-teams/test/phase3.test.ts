/**
 * Phase 3 unit tests — plan review protocol (plain node):
 *   node test/phase3.test.ts
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  critiquePath,
  loadProtocol,
  newProtocol,
  planPath,
  planRevPath,
  readPlan,
  saveProtocol,
  updateProtocol,
  writePlanRevision,
} from "../protocol.ts";
import { criticAssignment, plannerDraftAssignment } from "../assignments.ts";
import { createMessage } from "../mailbox.ts";

let failures = 0;
function check(name: string, cond: boolean, extra?: string): void {
  if (cond) console.log(`PASS  ${name}`);
  else {
    failures++;
    console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-teams-plan-"));
  try {
    // --- protocol lifecycle ---------------------------------------------------
    const protocol = newProtocol({ title: "Ship auth v2", planner: "lead", critics: ["c1", "c2"], rounds: 2 });
    await saveProtocol(root, protocol);
    const loaded = await loadProtocol(root);
    check("protocol persists", loaded?.title === "Ship auth v2" && loaded?.phase === "drafting");

    // --- plan revisions ---------------------------------------------------------
    const rev1 = await writePlanRevision(root, "# Plan v1\nDo auth with passwords.");
    check("first revision is 1", rev1 === 1);
    check("plan.md holds current", ((await readPlan(root)) ?? "").includes("passwords"));

    await updateProtocol(root, (p) => {
      p.planRev = rev1;
      p.phase = "critique";
      p.history.push("round 1: critics dispatched");
    });

    const rev2 = await writePlanRevision(root, "# Plan v2\nPasskeys + MFA.");
    check("second revision is 2", rev2 === 2);
    const archived = await readFile(planRevPath(root, 1), "utf8");
    check("rev 1 archived", archived.includes("passwords"));
    check("plan.md updated to v2", ((await readPlan(root)) ?? "").includes("Passkeys"));

    // --- protocol mutations under lock --------------------------------------------
    const updated = await updateProtocol(root, (p) => {
      p.phase = "awaiting-approval";
      p.history.push("awaiting approval");
    });
    check("protocol update persists", updated.phase === "awaiting-approval" && updated.history.length === 3);
    check("missing protocol errors", await updateProtocol(join(root, "nope"), async () => {}).then(() => false).catch(() => true));

    // --- assignment builders --------------------------------------------------------
    const ca = criticAssignment("t", "Plan X", 2, root, "c1");
    check("critic assignment names files", ca.includes("blackboard/plan.md") && ca.includes("critiques/c1.r2.md"));
    check("critic assignment demands severity", ca.includes("blocker/major/minor"));
    check("critic assignment forbids editing plan", ca.includes("do not edit the plan"));
    check("critic assignment wants objection mail", ca.includes("kind=objection"));
    check("critic assignment has clean-pass rule", ca.includes("clean pass is a finding"));

    const pa = plannerDraftAssignment("t", "Plan X");
    check("planner assignment demands approval request", pa.includes("plan-approval-request"));

    // --- protocol message kinds ride the mailbox schema -------------------------------
    const approvalReq = createMessage("planner", "lead", "plan-approval-request", "Ready for review", ["blackboard/plan.md"]);
    const objection = createMessage("c1", "lead", "objection", "No rollback story");
    check("approval-request kind valid", (await import("../mailbox.ts")).isValidMessage(approvalReq));
    check("objection kind valid", (await import("../mailbox.ts")).isValidMessage(objection));

    // --- critique path convention -----------------------------------------------------
    check("critique path round-suffixed", critiquePath(root, "c1", 2).endsWith("critiques/c1.r2.md"));
    check("plan path stable", planPath(root).endsWith("blackboard/plan.md"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  console.log("");
  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
