/**
 * Phase 2 unit tests — task board (plain node):
 *   node test/phase2.test.ts
 * Covers: create/list/persistence, claim race (one winner), dependency
 * unblocking, holder-only completion, unclaim, lead assignment.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assignTask,
  claimTask,
  completeTask,
  createTask,
  isClaimable,
  listTasks,
  loadBoard,
  unclaimTask,
} from "../board.ts";

let failures = 0;
function check(name: string, cond: boolean, extra?: string): void {
  if (cond) console.log(`PASS  ${name}`);
  else {
    failures++;
    console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-teams-board-"));
  try {
    // --- create + list + persist --------------------------------------------
    const a = await createTask(root, { title: "Draft plan", createdBy: "lead" });
    const b = await createTask(root, {
      title: "Critique plan",
      dependencies: [a.id],
      createdBy: "lead",
    });
    check("task ids generated", a.id !== b.id && a.id.startsWith("t"));

    const reloaded = await loadBoard(root);
    check("board persists to disk", reloaded.length === 2);

    const listed = await listTasks(root);
    check("list ordered by creation", listed[0].id === a.id && listed[1].id === b.id);

    // --- dependency blocking --------------------------------------------------
    let blocked = false;
    try {
      await claimTask(root, b.id, "critic");
    } catch {
      blocked = true;
    }
    check("dependent task unclaimable while dep open", blocked);

    const all1 = await loadBoard(root);
    check("isClaimable reflects deps", !isClaimable(b, all1) && isClaimable(a, all1));

    // --- claim race: exactly one winner ---------------------------------------
    const outcomes = await Promise.allSettled([
      claimTask(root, a.id, "alice"),
      claimTask(root, a.id, "bob"),
    ]);
    const winners = outcomes.filter((o) => o.status === "fulfilled").length;
    check("claim race has exactly one winner", winners === 1, `winners=${winners}`);
    const holder = outcomes[0].status === "fulfilled" ? "alice" : "bob";
    const loser = holder === "alice" ? "bob" : "alice";

    // --- holder-only completion -------------------------------------------------
    let denied = false;
    try {
      await completeTask(root, a.id, loser);
    } catch {
      denied = true;
    }
    check("non-holder cannot complete", denied);

    const completedA = await completeTask(root, a.id, holder, "plan.md written");
    check("holder completes with evidence", completedA.status === "completed" && completedA.evidence === "plan.md written");

    // --- dependency auto-unblock --------------------------------------------------
    const claimedB = await claimTask(root, b.id, "critic");
    check("dependent claimable after dep completes", claimedB.claimedBy === "critic");

    // --- unclaim -------------------------------------------------------------------
    const unclaimed = await unclaimTask(root, b.id, "critic");
    check("unclaim returns to pending", unclaimed.status === "pending" && unclaimed.claimedBy === undefined);

    // --- lead assignment bypasses deps ----------------------------------------------
    const assigned = await assignTask(root, b.id, "critic");
    check("lead assigns pending task", assigned.status === "in-progress" && assigned.claimedBy === "critic");

    // --- complete by lead allowed ---------------------------------------------------
    const done = await completeTask(root, b.id, "lead", "critique delivered");
    check("lead can complete held task", done.status === "completed");

    // --- unknown dependency rejected -------------------------------------------------
    let unknownDep = false;
    try {
      await createTask(root, { title: "Bad", dependencies: ["nope"], createdBy: "lead" });
    } catch {
      unknownDep = true;
    }
    check("unknown dependency rejected", unknownDep);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  console.log("");
  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
