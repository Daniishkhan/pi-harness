import { realpathSync } from "node:fs";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { extensionPath, skillPath } from "./resources.mjs";
import { loadCatalog, loadWorkload } from "./manifests.mjs";
import { assertProfileId, invocationName, resolveContained, resolveHarnessPaths } from "./paths.mjs";
import { prepareProfileHome } from "./profile-home.mjs";

const CONTROLLED_FLAGS = new Set([
  "--extension",
  "-e",
  "--no-extensions",
  "-ne",
  "--skill",
  "--no-skills",
  "-ns",
  "--prompt-template",
  "--no-prompt-templates",
  "-np",
  "--theme",
  "--no-themes",
  "--system-prompt",
  "--append-system-prompt",
  "--tools",
  "-t",
  "--exclude-tools",
  "-xt",
  "--no-tools",
  "-nt",
  "--no-builtin-tools",
  "-nbt",
  "--no-context-files",
  "-nc",
  "--session-dir",
  "--approve",
  "-a",
  "--no-approve",
  "-na",
]);

const CONTROLLED_LONG_PREFIXES = [
  "--extension=",
  "--skill=",
  "--prompt-template=",
  "--theme=",
  "--system-prompt=",
  "--append-system-prompt=",
  "--tools=",
  "--exclude-tools=",
  "--session-dir=",
];

const SESSION_TARGET_FLAGS = new Set(["--session", "--fork"]);
const SESSION_ID_OR_PREFIX = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

function isContained(root, target) {
  const relation = relative(root, target);
  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation));
}

function canonicalizeAvailablePrefix(target) {
  let cursor = resolve(target);
  const missing = [];
  while (true) {
    try {
      return resolve(realpathSync.native(cursor), ...missing);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) return resolve(cursor, ...missing);
      missing.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

function resolvePiSessionPath(value, cwd) {
  let normalized = value;
  if (normalized === "~") normalized = homedir();
  else if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
    normalized = resolve(homedir(), normalized.slice(2));
  }
  if (/^file:\/\//.test(normalized)) normalized = fileURLToPath(normalized);
  return isAbsolute(normalized) ? resolve(normalized) : resolve(cwd, normalized);
}

function scopeSessionTarget(flag, value, sessionsDir, cwd) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${flag} requires a non-empty profile-local session path or ID.`);
  }

  const pathLike = value.includes("/") || value.includes("\\") || value.endsWith(".jsonl");
  if (!pathLike) {
    if (!SESSION_ID_OR_PREFIX.test(value)) {
      throw new Error(`Refusing ambiguous ${flag} target '${value}'; use a profile-local session ID or explicit path.`);
    }
    return value;
  }

  let target;
  try {
    target = resolvePiSessionPath(value, cwd);
  } catch {
    throw new Error(`Refusing invalid ${flag} session path '${value}'.`);
  }
  const root = canonicalizeAvailablePrefix(sessionsDir);
  const canonicalTarget = canonicalizeAvailablePrefix(target);
  if (canonicalTarget === root || !isContained(root, canonicalTarget)) {
    throw new Error(`${flag} session path escapes the selected workload session directory: ${value}`);
  }
  return target;
}

export function scopeSessionPassthroughArgs(args, sessionsDir, cwd = process.cwd()) {
  const scoped = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (SESSION_TARGET_FLAGS.has(arg)) {
      if (index + 1 >= args.length) {
        throw new Error(`${arg} requires a profile-local session path or ID.`);
      }
      scoped.push(arg, scopeSessionTarget(arg, args[index + 1], sessionsDir, cwd));
      index += 1;
      continue;
    }
    const equalFlag = [...SESSION_TARGET_FLAGS].find((flag) => arg.startsWith(`${flag}=`));
    if (equalFlag) {
      scoped.push(equalFlag, scopeSessionTarget(equalFlag, arg.slice(equalFlag.length + 1), sessionsDir, cwd));
      continue;
    }
    scoped.push(arg);
  }
  return scoped;
}

export function validatePassthroughArgs(args) {
  for (const arg of args) {
    if (CONTROLLED_FLAGS.has(arg) || CONTROLLED_LONG_PREFIXES.some((prefix) => arg.startsWith(prefix))) {
      throw new Error(`Pi Harness controls '${arg}' for workload isolation; change the workload manifest instead.`);
    }
  }
}

export function parseInvocation(argvEntry, args) {
  const command = invocationName(argvEntry);
  const aliasMatch = command.match(/^pi-(eng|design|research|learn)$/);
  if (aliasMatch) return { profileId: aliasMatch[1], args: [...args] };
  if (command !== "pi-run") {
    throw new Error(`Unsupported launcher name '${command}'. Invoke pi-run or a pi-<profile> alias.`);
  }
  const [profileId, ...rest] = args;
  if (!profileId) throw new Error("Usage: pi-run <eng|design|research|learn> [pi arguments]");
  assertProfileId(profileId);
  return { profileId, args: rest };
}

export function buildPiArgs(workload, catalog, paths, prepared, passthroughArgs = [], cwd = process.cwd()) {
  validatePassthroughArgs(passthroughArgs);
  const scopedPassthroughArgs = scopeSessionPassthroughArgs(passthroughArgs, prepared.sessions, cwd);
  const promptPath = resolveContained(paths.repoRoot, workload.systemPrompt, `${workload.id} system prompt`);
  const promptFlag = workload.promptMode === "append" ? "--append-system-prompt" : "--system-prompt";
  const args = [
    ...scopedPassthroughArgs,
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-approve",
    ...(workload.inheritContextFiles ? [] : ["--no-context-files"]),
    promptFlag,
    promptPath,
    "--session-dir",
    prepared.sessions,
    "--tools",
    workload.tools.join(","),
  ];
  for (const name of workload.extensions) args.push("-e", extensionPath(catalog, name, paths));
  for (const name of workload.skills) args.push("--skill", skillPath(catalog, name, paths));
  return args;
}

export function buildProfileEnvironment(profileId, paths, prepared, env = process.env) {
  const childEnv = {
    ...env,
    PI_CODING_AGENT_DIR: prepared.home,
    PI_CODING_AGENT_SESSION_DIR: prepared.sessions,
    PI_HARNESS_PROFILE: profileId,
    PI_HARNESS_BASE_AGENT_DIR: paths.baseAgentDir,
    PI_HARNESS_PROFILES_DIR: paths.profilesDir,
  };
  if (profileId === "research") childEnv.PI_ENGINEERING_RUNTIME_HOST_ONLY = "1";
  else delete childEnv.PI_ENGINEERING_RUNTIME_HOST_ONLY;
  if (env.HERDR_ENV === "1" && !env.HERDR_AGENT) childEnv.HERDR_AGENT = "pi";
  return childEnv;
}

export async function createLaunchPlan(profileId, passthroughArgs = [], options = {}) {
  const paths = options.paths ?? resolveHarnessPaths(options.env ?? process.env, options.pathOverrides);
  const catalog = options.catalog ?? (await loadCatalog(paths));
  const workload = options.workload ?? (await loadWorkload(paths, profileId, catalog));
  const promptPath = resolveContained(paths.repoRoot, workload.systemPrompt, `${profileId} system prompt`);
  await access(promptPath, constants.R_OK);
  const prepared = options.prepared ?? (await prepareProfileHome(profileId, workload, catalog, paths));
  const cwd = options.cwd ?? process.cwd();
  return {
    profileId,
    paths,
    catalog,
    workload,
    prepared,
    cwd,
    command: paths.piBin,
    args: buildPiArgs(workload, catalog, paths, prepared, passthroughArgs, cwd),
    env: buildProfileEnvironment(profileId, paths, prepared, options.env ?? process.env),
  };
}

export function runLaunchPlan(plan, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(plan.command, plan.args, {
      cwd: options.cwd ?? plan.cwd ?? process.cwd(),
      env: plan.env,
      stdio: options.stdio ?? "inherit",
      shell: false,
    });
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
    const forwarders = new Map(
      signals.map((signal) => [signal, () => {
        if (!child.killed) child.kill(signal);
      }]),
    );
    for (const [signal, forward] of forwarders) process.on(signal, forward);
    const cleanup = () => {
      for (const [signal, forward] of forwarders) process.off(signal, forward);
    };
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      if (signal) {
        resolvePromise(128 + (signal === "SIGINT" ? 2 : signal === "SIGTERM" ? 15 : 1));
      } else {
        resolvePromise(code ?? 1);
      }
    });
  });
}
