#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLaunchPlan } from "../lib/launch.mjs";
import { loadCatalog, loadWorkload } from "../lib/manifests.mjs";
import { PROFILE_IDS, resolveHarnessPaths } from "../lib/paths.mjs";
import { verifyCatalogResources } from "../lib/resources.mjs";

function line(stream, status, message) {
  stream.write(`${status.padEnd(5)} ${message}\n`);
}

function exactSet(actual, expected, label) {
  const left = [...actual].sort();
  const right = [...expected].sort();
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    const missing = right.filter((item) => !left.includes(item));
    const extra = left.filter((item) => !right.includes(item));
    throw new Error(
      `${label} mismatch` +
        `${missing.length ? `; missing: ${missing.join(", ")}` : ""}` +
        `${extra.length ? `; extra: ${extra.join(", ")}` : ""}`,
    );
  }
}

function checkPiVersion(paths, expected, env) {
  const result = spawnSync(paths.piBin, ["--version"], {
    encoding: "utf8",
    env,
    timeout: 10_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Pi version check failed: ${result.stderr?.trim() || `exit ${result.status}`}`);
  const actual = result.stdout.trim();
  if (actual !== expected) throw new Error(`Pi version mismatch: expected ${expected}, found ${actual || "<empty>"}.`);
  return actual;
}

function checkHerdrVersion(paths, env) {
  const result = spawnSync(paths.herdrBin, ["--version"], {
    encoding: "utf8",
    env,
    timeout: 10_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Herdr version check failed: ${result.stderr?.trim() || `exit ${result.status}`}`);
  const actual = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  if (!/\bherdr\s+\d+\.\d+\.\d+\b/i.test(actual)) {
    throw new Error(`Unable to parse Herdr version from: ${actual || "<empty>"}.`);
  }
  return actual;
}

async function smokeProfile(plan) {
  const temporary = await mkdtemp(join(tmpdir(), `pi-harness-${plan.profileId}-`));
  const output = join(temporary, "probe.json");
  try {
    const env = { ...plan.env, PI_HARNESS_PROBE_OUTPUT: output };
    delete env.HERDR_ENV;
    delete env.HERDR_SOCKET_PATH;
    delete env.HERDR_PANE_ID;
    const result = spawnSync(
      plan.command,
      [...plan.args, "-e", plan.paths.probeExtensionPath, "--mode", "rpc", "--no-session"],
      {
        cwd: temporary,
        env,
        encoding: "utf8",
        input: "",
        timeout: 30_000,
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`probe exited ${result.status}: ${(result.stderr || result.stdout).trim()}`);
    }
    const probe = JSON.parse(await readFile(output, "utf8"));
    exactSet(probe.tools, plan.workload.tools, `${plan.profileId} active tools`);
    const missingCommands = plan.workload.requiredCommands.filter((name) => !probe.commands.includes(name));
    if (missingCommands.length) throw new Error(`missing commands: ${missingCommands.join(", ")}`);
    const forbiddenCommands = plan.workload.forbiddenCommands.filter((name) => probe.commands.includes(name));
    if (forbiddenCommands.length) throw new Error(`forbidden commands loaded: ${forbiddenCommands.join(", ")}`);
    if (probe.agentDir !== plan.prepared.home) {
      throw new Error(`probe used agent dir ${probe.agentDir}, expected ${plan.prepared.home}`);
    }
    return probe;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

const CHILD_PROBE_TOOLS = Object.freeze({
  eng: ["subagent", "inspect_repo"],
  research: ["subagent", "inspect_repo", "web_search", "fetch_content", "get_search_content"],
});

async function smokeChildSettings(plan) {
  const expectedTools = CHILD_PROBE_TOOLS[plan.profileId];
  if (!expectedTools) return undefined;
  const temporary = await mkdtemp(join(tmpdir(), `pi-harness-${plan.profileId}-child-`));
  const output = join(temporary, "probe.json");
  const untrustedMarker = join(temporary, "project-extension-loaded");
  try {
    const projectExtensions = join(temporary, ".pi", "extensions");
    await mkdir(projectExtensions, { recursive: true });
    await writeFile(
      join(projectExtensions, "untrusted.mjs"),
      `import { writeFileSync } from "node:fs";\nexport default function () { writeFileSync(process.env.PI_HARNESS_UNTRUSTED_MARKER, "loaded"); }\n`,
      "utf8",
    );
    const env = {
      ...plan.env,
      PI_SUBAGENT_CHILD: "1",
      PI_HARNESS_PROBE_OUTPUT: output,
      PI_HARNESS_UNTRUSTED_MARKER: untrustedMarker,
    };
    delete env.HERDR_ENV;
    delete env.HERDR_SOCKET_PATH;
    delete env.HERDR_PANE_ID;
    const result = spawnSync(
      plan.command,
      [
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--no-approve",
        "--tools",
        expectedTools.join(","),
        "-e",
        plan.paths.probeExtensionPath,
        "--mode",
        "rpc",
        "--no-session",
      ],
      { cwd: temporary, env, encoding: "utf8", input: "", timeout: 30_000 },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`child probe exited ${result.status}: ${(result.stderr || result.stdout).trim()}`);
    }
    const probe = JSON.parse(await readFile(output, "utf8"));
    exactSet(probe.tools, expectedTools, `${plan.profileId} child active tools`);
    if (probe.agentDir !== plan.prepared.home) {
      throw new Error(`child probe used agent dir ${probe.agentDir}, expected ${plan.prepared.home}`);
    }
    try {
      await access(untrustedMarker);
      throw new Error(`${plan.profileId} child loaded a project-local extension despite the trust boundary`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return probe;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function runDoctor(options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const env = options.env ?? process.env;
  const paths = options.paths ?? resolveHarnessPaths(env, options.pathOverrides);
  const profileIds = options.profileIds ?? PROFILE_IDS;
  const smoke = options.smoke ?? true;
  const failures = [];

  if (Number.parseInt(process.versions.node.split(".")[0], 10) < 24) {
    failures.push(`Node >=24 is required; found ${process.versions.node}.`);
  } else {
    line(stdout, "OK", `Node ${process.versions.node}`);
  }

  let catalog;
  try {
    catalog = await loadCatalog(paths);
    line(stdout, "OK", `strict catalog schema v${catalog.schemaVersion}`);
  } catch (error) {
    failures.push(error.message);
  }

  if (catalog) {
    try {
      const version = checkPiVersion(paths, catalog.pi.version, env);
      line(stdout, "OK", `Pi ${version}`);
    } catch (error) {
      failures.push(error.message);
    }
    try {
      line(stdout, "OK", checkHerdrVersion(paths, env));
    } catch (error) {
      failures.push(error.message);
    }
    try {
      const checked = await verifyCatalogResources(catalog, paths);
      line(stdout, "OK", `${checked.length} pinned/shared resources and ${Object.keys(catalog.skills).length} skills`);
    } catch (error) {
      failures.push(error.message);
    }
  }

  try {
    const integrationPath = join(paths.baseAgentDir, "extensions", "herdr-agent-state.ts");
    await access(integrationPath);
    line(
      stderr,
      "WARN",
      `official Herdr Pi integration is installed at ${integrationPath}; profiled launches suppress it with --no-extensions`,
    );
  } catch {
    // Expected safe default: Herdr supervises the wrapper through screen detection.
  }

  if (catalog) {
    for (const profileId of profileIds) {
      try {
        const workload = await loadWorkload(paths, profileId, catalog);
        const plan = await createLaunchPlan(profileId, [], { paths, env, catalog, workload });
        line(stdout, "OK", `${profileId}: ${plan.prepared.home} (${workload.tools.length} tools)`);
        if (smoke) {
          const probe = await smokeProfile(plan);
          line(stdout, "OK", `${profileId}: runtime probe (${probe.commands.length} commands)`);
          const childProbe = await smokeChildSettings(plan);
          if (childProbe) line(stdout, "OK", `${profileId}: child settings probe (${childProbe.tools.length} tools)`);
        }
      } catch (error) {
        failures.push(`${profileId}: ${error.message}`);
      }
    }
  }

  for (const failure of failures) line(stderr, "FAIL", failure);
  if (failures.length === 0) line(stdout, "OK", `Pi Harness doctor passed for ${profileIds.join(", ")}.`);
  return failures.length === 0 ? 0 : 1;
}

function parseDoctorArgs(args) {
  const profileIds = [];
  let smoke = true;
  for (const arg of args) {
    if (arg === "--no-smoke") smoke = false;
    else if (PROFILE_IDS.includes(arg)) profileIds.push(arg);
    else throw new Error(`Usage: pi-doctor [eng|design|research|learn] [--no-smoke]`);
  }
  return { profileIds: profileIds.length ? profileIds : PROFILE_IDS, smoke };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
if (isMain) {
  try {
    process.exitCode = await runDoctor(parseDoctorArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`pi-doctor: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
