import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const PROFILE_IDS = Object.freeze(["eng", "design", "research", "learn"]);

const LIB_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPO_ROOT = resolve(LIB_DIR, "..");

function directoryFromEnv(value, fallback) {
  return resolve(value?.trim() || fallback);
}

export function resolveHarnessPaths(env = process.env, overrides = {}) {
  const homeDir = directoryFromEnv(overrides.homeDir ?? env.PI_HARNESS_HOME_DIR, homedir());
  const repoRoot = directoryFromEnv(overrides.repoRoot, DEFAULT_REPO_ROOT);
  const baseAgentDir = directoryFromEnv(
    overrides.baseAgentDir ?? env.PI_HARNESS_BASE_AGENT_DIR,
    join(homeDir, ".pi", "agent"),
  );
  const profilesDir = directoryFromEnv(
    overrides.profilesDir ?? env.PI_HARNESS_PROFILES_DIR,
    join(homeDir, ".pi", "profiles"),
  );
  const sharedSkillsDir = directoryFromEnv(
    overrides.sharedSkillsDir ?? env.PI_HARNESS_SHARED_SKILLS_DIR,
    join(homeDir, ".agents", "skills"),
  );
  const launcherBinDir = directoryFromEnv(
    overrides.launcherBinDir ?? env.PI_HARNESS_BIN_DIR,
    join(homeDir, ".local", "bin"),
  );
  const rawPiBin = overrides.piBin ?? env.PI_HARNESS_PI_BIN ?? "pi";
  const piBin = rawPiBin.includes("/") || rawPiBin.includes("\\") ? resolve(rawPiBin) : rawPiBin;
  const rawHerdrBin = overrides.herdrBin ?? env.PI_HARNESS_HERDR_BIN ?? "herdr";
  const herdrBin = rawHerdrBin.includes("/") || rawHerdrBin.includes("\\") ? resolve(rawHerdrBin) : rawHerdrBin;

  return Object.freeze({
    homeDir,
    repoRoot,
    baseAgentDir,
    profilesDir,
    sharedSkillsDir,
    launcherBinDir,
    piBin,
    herdrBin,
    catalogPath: join(repoRoot, "workloads", "catalog.json"),
    workloadsDir: join(repoRoot, "workloads"),
    probeExtensionPath: join(repoRoot, "extensions", "profile-probe.mjs"),
  });
}

export function profileHome(paths, profileId) {
  assertProfileId(profileId);
  return join(paths.profilesDir, profileId);
}

export function profileSessionDir(paths, profileId) {
  return join(profileHome(paths, profileId), "sessions");
}

export function assertProfileId(profileId) {
  if (!PROFILE_IDS.includes(profileId)) {
    throw new Error(`Unknown Pi workload '${profileId}'. Expected one of: ${PROFILE_IDS.join(", ")}.`);
  }
}

export function resolveContained(root, relativePath, label = "path") {
  if (typeof relativePath !== "string" || !relativePath.trim() || isAbsolute(relativePath)) {
    throw new Error(`${label} must be a non-empty relative path.`);
  }
  const target = resolve(root, relativePath);
  const resolvedRoot = resolve(root);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error(`${label} escapes its configured root: ${relativePath}`);
  }
  return target;
}

export function invocationName(argvEntry) {
  return basename(argvEntry || "pi-run").replace(/\.(?:mjs|js|cjs)$/i, "");
}
