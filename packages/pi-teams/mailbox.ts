/**
 * pi-teams mailbox — append-only JSONL inboxes, schema-validated on read.
 * Mirrors Claude Code agent teams: "sent" = append succeeded; malformed
 * entries are dropped on read, never fatal.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { withFileLock } from "./lock.ts";
import { MESSAGE_KINDS, type MessageKind, type TeamMessage } from "./types.ts";

export const MAX_BODY_CHARS = 16_000;
export const MAX_UNREAD_RETURN = 50;

const KIND_SET: ReadonlySet<string> = new Set(MESSAGE_KINDS);

export function inboxPath(teamDir: string, memberName: string): string {
  return join(teamDir, "inboxes", `${memberName}.jsonl`);
}

export function cursorPath(teamDir: string, memberName: string): string {
  return join(teamDir, "inboxes", ".cursors", `${memberName}.json`);
}

export function isValidKind(kind: unknown): kind is MessageKind {
  return typeof kind === "string" && KIND_SET.has(kind);
}

/** Structural validation; malformed entries are dropped by readers. */
export function isValidMessage(x: unknown): x is TeamMessage {
  if (!x || typeof x !== "object") return false;
  const m = x as Record<string, unknown>;
  return (
    typeof m.id === "string" &&
    m.id.length > 0 &&
    typeof m.ts === "number" &&
    Number.isFinite(m.ts) &&
    typeof m.from === "string" &&
    m.from.length > 0 &&
    typeof m.to === "string" &&
    m.to.length > 0 &&
    isValidKind(m.kind) &&
    typeof m.body === "string" &&
    (m.refs === undefined ||
      (Array.isArray(m.refs) && m.refs.every((r) => typeof r === "string")))
  );
}

export function createMessage(
  from: string,
  to: string,
  kind: MessageKind,
  body: string,
  refs?: string[],
): TeamMessage {
  return { id: randomUUID(), ts: Date.now(), from, to, kind, body, ...(refs ? { refs } : {}) };
}

/**
 * Append one message. Locked + idempotent (duplicate id is a no-op) so
 * multiple senders in different processes can append to one inbox safely.
 */
export async function appendMessage(path: string, msg: TeamMessage): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await withFileLock(`${path}.lock`, async () => {
    let existingIds: Set<string> | undefined;
    try {
      const raw = await readFile(path, "utf8");
      existingIds = new Set<string>();
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const m = JSON.parse(line) as { id?: unknown };
          if (typeof m.id === "string") existingIds.add(m.id);
        } catch {
          // Malformed pre-existing line — the reader will drop it; nothing to do here.
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (existingIds?.has(msg.id)) return;
    await writeFile(path, JSON.stringify(msg) + "\n", { flag: "a" });
  });
}

export interface ReadInboxResult {
  messages: TeamMessage[];
  /** Malformed/duplicate lines dropped during this read. */
  dropped: number;
  /** Total unread count before any return cap. */
  totalUnread: number;
  /**
   * Index of the last non-empty line processed (the read cursor).
   * The inbox is append-only JSONL, so physical line indices are exact
   * and immune to clock ties. Unread = lines with index > sinceLine.
   */
  lastLine: number;
}

/**
 * Read messages with lineNo > sinceLine. Dedupes by id, drops malformed
 * lines (they still consume a line index, so later reads stay stable).
 */
export async function readInbox(
  path: string,
  { sinceLine = 0, limit = MAX_UNREAD_RETURN }: { sinceLine?: number; limit?: number } = {},
): Promise<ReadInboxResult> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { messages: [], dropped: 0, totalUnread: 0, lastLine: 0 };
    }
    throw err;
  }
  const seen = new Set<string>();
  const all: TeamMessage[] = [];
  let dropped = 0;
  let lineNo = 0; // 1-based count of non-empty lines
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    lineNo++;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      dropped++;
      continue;
    }
    if (!isValidMessage(parsed)) {
      dropped++;
      continue;
    }
    if (seen.has(parsed.id)) continue;
    seen.add(parsed.id);
    if (lineNo > sinceLine) all.push(parsed);
  }
  all.sort((a, b) => a.ts - b.ts);
  return { messages: all.slice(0, limit), dropped, totalUnread: all.length, lastLine: lineNo };
}

export async function getCursor(path: string): Promise<number> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as { lastLine?: unknown };
    return typeof parsed.lastLine === "number" && Number.isFinite(parsed.lastLine)
      ? parsed.lastLine
      : 0;
  } catch {
    return 0;
  }
}

export async function saveCursor(path: string, lastLine: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await withFileLock(`${path}.lock`, () =>
    writeFile(path, JSON.stringify({ lastLine }), "utf8"),
  );
}
