/**
 * Phase 0 acceptance test — run with plain node (type stripping):
 *   node test/phase0.test.ts
 * Covers: name validation, team create/join, concurrent locked appends,
 * schema-validated reads (malformed lines dropped), dedupe, cursors.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendMessage,
  createMessage,
  cursorPath,
  getCursor,
  inboxPath,
  readInbox,
  saveCursor,
} from "../mailbox.ts";
import { createTeam, isValidName, loadConfig, teamDir, updateConfig } from "../team.ts";
import type { TeamConfig } from "../types.ts";

let failures = 0;

function check(name: string, cond: boolean, extra?: string): void {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-teams-test-"));
  try {
    // --- name validation -------------------------------------------------
    check("valid name accepted", isValidName("review-team"));
    check("dotted name accepted", isValidName("team.v2"));
    check("traversal rejected", !isValidName("../evil"));
    check("slash rejected", !isValidName("a/b"));
    check("empty rejected", !isValidName(""));

    // --- team create -----------------------------------------------------
    const dir = teamDir(root, "t1");
    const now = Date.now();
    const config: TeamConfig = {
      team: "t1",
      createdAt: now,
      updatedAt: now,
      members: [
        { name: "lead", role: "lead", status: "active", sessionId: "sid-lead" },
        { name: "critic", role: "teammate", title: "critic", status: "pending" },
        { name: "scout", role: "teammate", title: "scout", status: "pending" },
      ],
    };
    await createTeam(dir, config);
    const loaded = await loadConfig(dir);
    check("team created on disk", loaded?.team === "t1" && loaded?.members.length === 3);

    // duplicate create must fail
    let dupFailed = false;
    try {
      await createTeam(dir, config);
    } catch {
      dupFailed = true;
    }
    check("duplicate create rejected", dupFailed);

    // --- join (updateConfig under lock) ----------------------------------
    await updateConfig(dir, (c) => {
      const m = c.members.find((x) => x.name === "critic");
      if (m) {
        m.status = "active";
        m.sessionId = "sid-critic";
        m.joinedAt = Date.now();
      }
    });
    const afterJoin = await loadConfig(dir);
    check(
      "join persisted",
      afterJoin?.members.find((m) => m.name === "critic")?.status === "active",
    );

    // --- concurrent appends from multiple senders -------------------------
    const inbox = inboxPath(dir, "critic");
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        appendMessage(
          inbox,
          createMessage(
            i < 15 ? "lead" : "scout",
            "critic",
            "chat",
            `message-${i}`,
          ),
        ),
      ),
    );
    const res = await readInbox(inbox, { sinceLine: 0 });
    check("30 concurrent appends all delivered", res.messages.length === 30, `got ${res.messages.length}`);
    check("no drops on clean file", res.dropped === 0);
    check("sorted by ts", res.messages.every((m, i, a) => i === 0 || a[i - 1].ts <= m.ts));

    // --- malformed lines dropped on read ----------------------------------
    await writeFile(inbox, "this is not json\n", { flag: "a" });
    await writeFile(inbox, `${JSON.stringify({ id: "x" })}\n`, { flag: "a" }); // missing fields
    const res2 = await readInbox(inbox, { sinceLine: 0 });
    check("malformed lines dropped", res2.dropped === 2, `dropped=${res2.dropped}`);
    check("valid messages survive malformed neighbors", res2.messages.length === 30);

    // --- duplicate id is idempotent ---------------------------------------
    const dup = createMessage("lead", "critic", "objection", "dup-me");
    await appendMessage(inbox, dup);
    await appendMessage(inbox, dup);
    const res3 = await readInbox(inbox, { sinceLine: 0 });
    check(
      "duplicate id appended once",
      res3.messages.filter((m) => m.id === dup.id).length === 1,
    );

    // --- cursors -----------------------------------------------------------
    const cPath = cursorPath(dir, "critic");
    await saveCursor(cPath, res3.lastLine);
    check("cursor saved", (await getCursor(cPath)) === res3.lastLine);

    await appendMessage(inbox, createMessage("lead", "critic", "finding", "late-arrival"));
    const res4 = await readInbox(inbox, { sinceLine: await getCursor(cPath) });
    check(
      "unread-since-cursor returns only new mail",
      res4.messages.length === 1 && res4.messages[0].body === "late-arrival",
    );

    // --- unknown kind rejected by validator --------------------------------
    const bad = createMessage("lead", "critic", "chat", "x");
    (bad as { kind: string }).kind = "not-a-kind";
    check("unknown kind is invalid", !(await isValidMessageCheck(bad)));

    console.log("");
    console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  process.exit(failures === 0 ? 0 : 1);
}

// small helper so the test can exercise the validator directly
async function isValidMessageCheck(x: unknown): Promise<boolean> {
  const { isValidMessage } = await import("../mailbox.ts");
  return isValidMessage(x);
}

await main();
