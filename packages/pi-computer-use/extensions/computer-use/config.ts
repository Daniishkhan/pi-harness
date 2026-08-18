import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface ComputerUseConfig {
  allowedOrigins: string[];
}

export const DEFAULT_CONFIG: ComputerUseConfig = Object.freeze({ allowedOrigins: [] });

export function getComputerUseConfigPath(agentDir = getAgentDir()): string {
  return join(agentDir, "computer-use.json");
}

export function getDevProfilePath(agentDir = getAgentDir(), sessionId = process.env.PI_SESSION_ID ?? randomUUID()): string {
  const safeSessionId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId)
    ? sessionId
    : `session-${createHash("sha256").update(sessionId).digest("hex").slice(0, 24)}`;
  return join(agentDir, "state", "pi-computer-use", "dev-profiles", safeSessionId);
}

export function normalizeExactHttpOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Allowed origin is not a valid URL: ${value}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Allowed origin must use http or https: ${value}`);
  }
  if (parsed.origin !== value) {
    throw new Error(`Allowed origin must be exact (no path, query, fragment, or trailing slash): ${value}`);
  }
  return parsed.origin;
}

export function validateConfig(value: unknown): ComputerUseConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Computer-use configuration must be an object.");
  }
  const raw = value as Record<string, unknown>;
  const keys = Object.keys(raw);
  if (keys.some((key) => key !== "allowedOrigins")) {
    throw new Error("Computer-use configuration contains unsupported fields.");
  }
  if (raw.allowedOrigins === undefined) return { allowedOrigins: [] };
  if (!Array.isArray(raw.allowedOrigins) || raw.allowedOrigins.some((origin) => typeof origin !== "string")) {
    throw new Error("Computer-use configuration allowedOrigins must be an array of strings.");
  }
  const allowedOrigins = [...new Set(raw.allowedOrigins.map(normalizeExactHttpOrigin))].sort();
  return { allowedOrigins };
}

export async function readConfig(path = getComputerUseConfigPath()): Promise<ComputerUseConfig> {
  try {
    return validateConfig(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { allowedOrigins: [] };
    throw new Error(`Invalid computer-use configuration at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function writeConfig(config: ComputerUseConfig, path = getComputerUseConfigPath()): Promise<void> {
  const normalized = validateConfig(config);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function addAllowedOrigin(origin: string, path = getComputerUseConfigPath()): Promise<ComputerUseConfig> {
  const config = await readConfig(path);
  const normalizedOrigin = normalizeExactHttpOrigin(origin);
  const next = { allowedOrigins: [...new Set([...config.allowedOrigins, normalizedOrigin])].sort() };
  await writeConfig(next, path);
  return next;
}

export async function removeAllowedOrigin(origin: string, path = getComputerUseConfigPath()): Promise<ComputerUseConfig> {
  const config = await readConfig(path);
  const normalizedOrigin = normalizeExactHttpOrigin(origin);
  const next = { allowedOrigins: config.allowedOrigins.filter((allowed) => allowed !== normalizedOrigin) };
  await writeConfig(next, path);
  return next;
}
