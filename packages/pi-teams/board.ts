/**
 * pi-teams — shared task board (Phase 2).
 * One JSON file per team: <teamDir>/board/tasks.json. All mutations happen
 * under a file lock so claim races across processes resolve to exactly one
 * winner. Dependencies auto-unblock: a pending task is claimable only when
 * every dependency is completed.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { withFileLock } from "./lock.ts";

export type TaskStatus = "pending" | "in-progress" | "completed";

export interface TeamTask {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  /** Task ids that must be completed before this one can be claimed. */
  dependencies: string[];
  claimedBy?: string;
  claimTs?: number;
  completedBy?: string;
  completedTs?: number;
  /** Free-form evidence of completion (what was done, artifact paths). */
  evidence?: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export function boardPath(teamDir: string): string {
  return join(teamDir, "board", "tasks.json");
}

function isValidTask(x: unknown): x is TeamTask {
  if (!x || typeof x !== "object") return false;
  const t = x as Record<string, unknown>;
  return (
    typeof t.id === "string" &&
    typeof t.title === "string" &&
    (t.status === "pending" || t.status === "in-progress" || t.status === "completed") &&
    Array.isArray(t.dependencies) &&
    t.dependencies.every((d) => typeof d === "string") &&
    typeof t.createdBy === "string"
  );
}

export async function loadBoard(dir: string): Promise<TeamTask[]> {
  try {
    const raw = await readFile(boardPath(dir), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidTask);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function writeBoardUnlocked(dir: string, tasks: TeamTask[]): Promise<void> {
  await mkdir(dirname(boardPath(dir)), { recursive: true });
  await writeFile(boardPath(dir), JSON.stringify(tasks, null, 2), "utf8");
}

/** Read-modify-write under one lock; returns the updated board. */
export async function updateBoard(
  dir: string,
  mutator: (tasks: TeamTask[]) => void | Promise<void>,
): Promise<TeamTask[]> {
  await mkdir(dirname(boardPath(dir)), { recursive: true });
  return withFileLock(`${boardPath(dir)}.lock`, async () => {
    const tasks = await loadBoard(dir);
    await mutator(tasks);
    await writeBoardUnlocked(dir, tasks);
    return tasks;
  });
}

export function isClaimable(task: TeamTask, all: TeamTask[]): boolean {
  if (task.status !== "pending") return false;
  return task.dependencies.every(
    (depId) => all.find((t) => t.id === depId)?.status === "completed",
  );
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  dependencies?: string[];
  createdBy: string;
  /** Lead assignment: claim immediately for this member. */
  assignTo?: string;
}

export async function createTask(dir: string, input: CreateTaskInput): Promise<TeamTask> {
  const now = Date.now();
  const id = `t${randomUUID().slice(0, 8)}`;
  const deps = [...new Set(input.dependencies ?? [])];
  const task: TeamTask = {
    id,
    title: input.title,
    ...(input.description ? { description: input.description } : {}),
    status: input.assignTo ? "in-progress" : "pending",
    dependencies: deps,
    ...(input.assignTo ? { claimedBy: input.assignTo, claimTs: now } : {}),
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  };
  await updateBoard(dir, (tasks) => {
    // Validate dependencies exist (or are already completed elsewhere) —
    // unknown ids make a task permanently unclaimable.
    for (const dep of deps) {
      if (!tasks.some((t) => t.id === dep)) {
        throw new Error(`Unknown dependency "${dep}" — create it first`);
      }
    }
    if (tasks.some((t) => t.id === task.id)) throw new Error(`Task id collision: ${id}`);
    tasks.push(task);
  });
  return task;
}

export async function getTask(dir: string, taskId: string): Promise<TeamTask | undefined> {
  return (await loadBoard(dir)).find((t) => t.id === taskId);
}

export async function listTasks(dir: string): Promise<TeamTask[]> {
  return (await loadBoard(dir)).sort((a, b) => a.createdAt - b.createdAt);
}

export async function claimTask(dir: string, taskId: string, memberName: string): Promise<TeamTask> {
  let claimed: TeamTask | undefined;
  await updateBoard(dir, (tasks) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`No task with id "${taskId}"`);
    if (task.status === "completed") throw new Error(`Task "${taskId}" is already completed`);
    if (task.status === "in-progress") {
      if (task.claimedBy === memberName) throw new Error(`You already hold task "${taskId}"`);
      throw new Error(`Task "${taskId}" is claimed by ${task.claimedBy ?? "someone"}`);
    }
    if (!isClaimable(task, tasks)) {
      const blocked = task.dependencies.filter(
        (depId) => tasks.find((t) => t.id === depId)?.status !== "completed",
      );
      throw new Error(
        `Task "${taskId}" has unresolved dependencies: ${blocked.join(", ")}`,
      );
    }
    task.status = "in-progress";
    task.claimedBy = memberName;
    task.claimTs = Date.now();
    task.updatedAt = Date.now();
    claimed = task;
  });
  return claimed as unknown as TeamTask;
}

export async function completeTask(
  dir: string,
  taskId: string,
  memberName: string,
  evidence?: string,
): Promise<TeamTask> {
  let completed: TeamTask | undefined;
  await updateBoard(dir, (tasks) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`No task with id "${taskId}"`);
    if (task.status !== "in-progress") {
      throw new Error(`Task "${taskId}" is not in progress (status: ${task.status})`);
    }
    const mayComplete = memberName === "lead" || task.claimedBy === memberName;
    if (!mayComplete) {
      throw new Error(`Task "${taskId}" is held by ${task.claimedBy}; only the holder or lead can complete it`);
    }
    task.status = "completed";
    task.completedBy = memberName;
    task.completedTs = Date.now();
    if (evidence !== undefined) task.evidence = evidence;
    task.updatedAt = Date.now();
    completed = task;
  });
  return completed as unknown as TeamTask;
}

export async function unclaimTask(dir: string, taskId: string, memberName: string): Promise<TeamTask> {
  let unclaimed: TeamTask | undefined;
  await updateBoard(dir, (tasks) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`No task with id "${taskId}"`);
    if (task.status !== "in-progress") {
      throw new Error(`Task "${taskId}" is not in progress (status: ${task.status})`);
    }
    if (memberName !== "lead" && task.claimedBy !== memberName) {
      throw new Error(`Task "${taskId}" is held by ${task.claimedBy}; only the holder or lead can unclaim it`);
    }
    task.status = "pending";
    task.claimedBy = undefined;
    task.claimTs = undefined;
    task.updatedAt = Date.now();
    unclaimed = task;
  });
  return unclaimed as unknown as TeamTask;
}

/**
 * Lead-only: assign a pending task to a member directly, bypassing the
 * dependency check (assignment is the lead's authority, not a claim race).
 */
export async function assignTask(dir: string, taskId: string, assignTo: string): Promise<TeamTask> {
  let assigned: TeamTask | undefined;
  await updateBoard(dir, (tasks) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`No task with id "${taskId}"`);
    if (task.status === "completed") throw new Error(`Task "${taskId}" is already completed`);
    if (task.status === "in-progress") {
      throw new Error(`Task "${taskId}" is already held by ${task.claimedBy ?? "someone"}`);
    }
    task.status = "in-progress";
    task.claimedBy = assignTo;
    task.claimTs = Date.now();
    task.updatedAt = Date.now();
    assigned = task;
  });
  return assigned as unknown as TeamTask;
}
