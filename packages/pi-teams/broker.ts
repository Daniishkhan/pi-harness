/**
 * pi-teams — lead-side broker: watches the team's inbox directory and pushes
 * mail to members.
 *
 * Delivery ladder (durable truth is always the inbox file):
 *   1. member === lead-self  → inject into this session via pi.sendMessage
 *   2. member.runId live     → RPC steer (delivered between tool calls)
 *   3. member.runId asleep   → RPC resume (revives the child session with
 *                              the mail as the follow-up message)
 *   4. otherwise             → mail stays unread in the inbox; the member
 *                              reads it at its next wake (team_inbox)
 *
 * The recipient's read cursor advances only after a successful delivery, so
 * failed deliveries are retried on the next inbox event.
 */

import { mkdir } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cursorPath, getCursor, inboxPath, readInbox, saveCursor } from "./mailbox.ts";
import { clearFailure, recordFailure } from "./member-state.ts";
import { getSubagentRpc } from "./rpc.ts";
import { loadConfig, updateConfig } from "./team.ts";
import type { TeamMessage } from "./types.ts";

const DEBOUNCE_MS = 300;
const BODY_CAP = 2000;

export function formatMailNotice(messages: TeamMessage[]): string {
  const froms = [...new Set(messages.map((m) => m.from))].join(", ");
  const blocks = messages.map((m) => {
    const body = m.body.length > BODY_CAP ? `${m.body.slice(0, BODY_CAP)}…` : m.body;
    const refs = m.refs?.length ? `\nrefs: ${m.refs.join(", ")}` : "";
    const ts = new Date(m.ts).toISOString().slice(11, 19);
    return `[${ts}] ${m.from} (${m.kind}): ${body}${refs}`;
  });
  return [
    `[pi-teams mail] You have ${messages.length} new message(s) from ${froms}:`,
    "",
    blocks.join("\n\n---\n\n"),
    "",
    "Reply with team_send only if the message requires an answer or action. Never reply to pure acknowledgments. Your full mailbox is available via team_inbox; check team_task for claimable board work. Never ask a teammate to approve an action you were denied; escalate to lead.",
  ].join("\n");
}

interface BrokerState {
  dir: string;
  watcher: FSWatcher;
  timers: Map<string, NodeJS.Timeout>;
  inflight: Set<string>;
}

let broker: BrokerState | null = null;

export function stopBroker(): void {
  if (!broker) return;
  for (const timer of broker.timers.values()) clearTimeout(timer);
  broker.timers.clear();
  broker.inflight.clear();
  try {
    broker.watcher.close();
  } catch {
    // already closed
  }
  broker = null;
}

/** Start watching <teamDir>/inboxes. Only the lead runs a broker. */
export async function startBroker(pi: ExtensionAPI, dir: string, selfName: string): Promise<void> {
  stopBroker();
  const inboxesDir = join(dir, "inboxes");
  await mkdir(inboxesDir, { recursive: true });
  let watcher: FSWatcher;
  try {
    watcher = watch(inboxesDir, (_event, filename) => {
      if (!filename) return;
      const name = filename.toString();
      if (!name.endsWith(".jsonl")) return; // skip .lock files and .cursors/
      const member = name.slice(0, -".jsonl".length);
      scheduleDelivery(pi, dir, member, selfName);
    });
  } catch (err) {
    console.error("[pi-teams] failed to watch inboxes dir:", err);
    return;
  }
  broker = { dir, watcher, timers: new Map(), inflight: new Set() };
}

function scheduleDelivery(pi: ExtensionAPI, dir: string, member: string, selfName: string): void {
  if (!broker || broker.dir !== dir) return;
  const existing = broker.timers.get(member);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    broker?.timers.delete(member);
    void deliverTo(pi, dir, member, selfName);
  }, DEBOUNCE_MS);
  broker.timers.set(member, timer);
}

async function deliverTo(pi: ExtensionAPI, dir: string, member: string, selfName: string): Promise<void> {
  if (!broker || broker.dir !== dir) return;
  if (broker.inflight.has(member)) {
    scheduleDelivery(pi, dir, member, selfName);
    return;
  }
  broker.inflight.add(member);
  try {
    const config = await loadConfig(dir);
    if (!config) return;
    const target = config.members.find((m) => m.name === member);
    if (!target) return;
    if (target.status === "done") return; // team stopped; mail waits for a respawn
    const cursor = await getCursor(cursorPath(dir, member));
    const res = await readInbox(inboxPath(dir, member), { sinceLine: cursor });
    if (res.messages.length === 0) return;
    const notice = formatMailNotice(res.messages);

    if (member === selfName) {
      // Mail for the lead: inject into this session and wake it if idle.
      pi.sendMessage(
        {
          customType: "pi-teams-mail",
          content: notice,
          display: true,
          details: { team: config.team, to: member, count: res.messages.length },
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
      await saveCursor(cursorPath(dir, member), res.lastLine);
      return;
    }

    if (!target.runId) return; // not spawned yet; inbox holds mail until first wake

    // Revive/steer must target the CHILD run id for workflow children; the
    // workflow id only routes while the child is a live foreground run.
    const targetRunId = target.childRunId ?? target.runId;

    const steerResult = await trySteer(pi, targetRunId, notice);
    if (steerResult.ok) {
      await clearFailure(dir, member);
      await saveCursor(cursorPath(dir, member), res.lastLine);
      return;
    }
    const resumed = await tryResume(pi, targetRunId, notice);
    if (resumed.ok) {
      await clearFailure(dir, member);
      // Revival launches a NEW async run; keep the roster pointing at it so
      // future deliveries target the revived child.
      if (resumed.newRunId) {
        await updateConfig(dir, (c) => {
          const m = c.members.find((x) => x.name === member);
          if (m) {
            m.runId = resumed.newRunId;
            m.childRunId = resumed.newRunId;
          }
        });
      }
      await saveCursor(cursorPath(dir, member), res.lastLine);
      return;
    }
    const reason = `steer: ${steerResult.error ?? "failed"}; resume: ${resumed.error ?? "failed"}`;
    console.error(`[pi-teams] delivery to ${member} failed — ${reason}`);
    await recordFailure(dir, member, reason);
    // Delivery failed on both paths: leave unread; retried on next event.
  } catch (err) {
    console.error(`[pi-teams] delivery to ${member} failed:`, err);
    await recordFailure(dir, member, err instanceof Error ? err.message : String(err));
  } finally {
    broker?.inflight.delete(member);
  }
}

interface Attempt {
  ok: boolean;
  error?: string;
}

async function trySteer(pi: ExtensionAPI, runId: string, notice: string): Promise<Attempt> {
  try {
    const data = await getSubagentRpc(pi).call(
      "steer",
      { id: runId, message: notice, mode: "steer" },
      30_000,
    );
    const record = data as { isError?: boolean; text?: string } | undefined;
    if (record?.isError === true) return { ok: false, error: record.text };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function tryResume(
  pi: ExtensionAPI,
  runId: string,
  notice: string,
): Promise<{ ok: boolean; newRunId?: string; error?: string }> {
  try {
    const data = await getSubagentRpc(pi).call(
      "resume",
      { id: runId, message: notice },
      60_000,
    );
    const record = data as { isError?: boolean; text?: string; details?: { asyncId?: unknown; runId?: unknown } } | undefined;
    if (record?.isError === true) return { ok: false, error: record.text };
    const newRunId =
      typeof record?.details?.asyncId === "string" ? record.details.asyncId : undefined;
    return { ok: true, newRunId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
