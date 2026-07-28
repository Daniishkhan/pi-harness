import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rmdir,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, parse, relative, resolve, sep } from "node:path";
import { loadCatalog, loadWorkload } from "./manifests.mjs";
import { computeHarnessPayloadHash } from "./payload.mjs";
import { assertProfileId, resolveContained, resolveHarnessPaths } from "./paths.mjs";
import { resourceRoot, skillPath } from "./resources.mjs";
import { validatePassthroughArgs } from "./launch.mjs";

export const CELL_SCHEMA_VERSION = 1;
export const CELL_IMAGE_SCHEMA_VERSION = "1";
export const CELL_DETACH_KEYS = "ctrl-]";

const CELL_NAME = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
const MANAGED_LABEL = "io.pi-harness.managed";
const CELL_LABEL = "io.pi-harness.cell";
const PROFILE_LABEL = "io.pi-harness.profile";
const WORKSPACE_LABEL = "io.pi-harness.workspace-sha256";
const IMAGE_SCHEMA_LABEL = "io.pi-harness.image-schema";
const PI_VERSION_LABEL = "io.pi-harness.pi-version";
const PAYLOAD_HASH_LABEL = "io.pi-harness.payload-sha256";
const DEFAULT_PIDS_LIMIT = "768";
const DEFAULT_CPUS = "1.75";
const DEFAULT_MEMORY = "6g";
const COMMAND_TIMEOUT_MS = 30_000;
const CREATE_TIMEOUT_MS = 5 * 60_000;
const START_TIMEOUT_MS = 60_000;
const START_READY_TIMEOUT_MS = 30_000;
const START_READY_POLL_MS = 250;
const STOP_TIMEOUT_MS = 60_000;
const COMMAND_MAX_BUFFER = 4 * 1024 * 1024;
const PLANNOTATOR_PORT_MIN = 20_000;
const PLANNOTATOR_PORT_SPAN = 10_000;
const RESERVED_CELL_MOUNT_TARGETS = [
  "/bin",
  "/dev",
  "/etc",
  "/home/pi",
  "/lib",
  "/lib64",
  "/opt/pi-harness",
  "/proc",
  "/run",
  "/sbin",
  "/state",
  "/sys",
  "/usr",
];
const IMAGE_PROVIDED_PEERS = new Set([
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "typebox",
]);

function usage() {
  return [
    "Usage:",
    "  pi-cell run <eng|design|research|learn> [--name NAME] [--workspace PATH] [--detach] [-- PI_ARGS...]",
    "  pi-cell attach <NAME>",
    "  pi-cell status <NAME>",
    "  pi-cell list",
    "  pi-cell logs <NAME> [--follow]",
    "  pi-cell stop <NAME>",
    "  pi-cell remove <NAME>",
    "  pi-cell doctor",
  ].join("\n");
}

export function assertCellName(name) {
  if (typeof name !== "string" || !CELL_NAME.test(name)) {
    throw new Error(
      "Cell names must be 1-48 lowercase letters, digits, or hyphens, and must start and end with a letter or digit.",
    );
  }
  return name;
}

export function parseCellInvocation(args) {
  const [action, ...rest] = args;
  if (!action) throw new Error(usage());
  if (action === "list" || action === "doctor") {
    if (rest.length) throw new Error(usage());
    return { action };
  }
  if (["attach", "status", "stop", "remove"].includes(action)) {
    if (rest.length !== 1) throw new Error(usage());
    return { action, name: assertCellName(rest[0]) };
  }
  if (action === "logs") {
    const follow = rest.includes("--follow");
    const names = rest.filter((arg) => arg !== "--follow");
    if (names.length !== 1) throw new Error(usage());
    return { action, name: assertCellName(names[0]), follow };
  }
  if (action !== "run") throw new Error(usage());

  const [profileId, ...runArgs] = rest;
  if (!profileId) throw new Error(usage());
  assertProfileId(profileId);
  let name;
  let workspace;
  let detach = false;
  const piArgs = [];
  let passthrough = false;
  for (let index = 0; index < runArgs.length; index += 1) {
    const arg = runArgs[index];
    if (passthrough) {
      piArgs.push(arg);
      continue;
    }
    if (arg === "--") {
      passthrough = true;
      continue;
    }
    if (arg === "--detach") {
      detach = true;
      continue;
    }
    if (arg === "--name" || arg === "--workspace") {
      const value = runArgs[index + 1];
      if (!value) throw new Error(`${arg} requires a value.\n${usage()}`);
      if (arg === "--name") name = assertCellName(value);
      else workspace = value;
      index += 1;
      continue;
    }
    passthrough = true;
    piArgs.push(arg);
  }
  return { action, profileId, name, workspace, detach, piArgs };
}

function isContained(root, target) {
  const relation = relative(root, target);
  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== "..");
}

function rejectMountDelimiter(path, label) {
  if (/[\r\n:]/.test(path)) throw new Error(`${label} contains a character Podman bind mounts cannot represent: ${path}`);
}

function cleanGitEnvironment(env = process.env) {
  const clean = { ...env, LC_ALL: "C" };
  for (const key of Object.keys(clean)) {
    if (key.startsWith("GIT_")) delete clean[key];
  }
  return clean;
}

export function assertSafeCellMountTarget(target, label = "Cell mount target") {
  const absolute = resolve(target);
  for (const reserved of RESERVED_CELL_MOUNT_TARGETS) {
    if (isContained(absolute, reserved) || isContained(reserved, absolute)) {
      throw new Error(`${label} overlaps reserved cell runtime path ${reserved}: ${absolute}`);
    }
  }
  return absolute;
}

export async function resolveCellWorkspace(input, options = {}) {
  const requested = resolve(options.cwd ?? process.cwd(), input ?? ".");
  let workspace;
  try {
    workspace = await realpath(requested);
  } catch (error) {
    throw new Error(`Cell workspace does not exist or cannot be resolved: ${requested} (${error.message})`);
  }
  const info = await stat(workspace);
  if (!info.isDirectory()) throw new Error(`Cell workspace is not a directory: ${workspace}`);
  const requestedWorkspace = workspace;
  try {
    const gitRoot = await execCapture(
      options.gitBin ?? "git",
      ["-C", workspace, "rev-parse", "--path-format=absolute", "--show-toplevel"],
      { ...options, env: cleanGitEnvironment(options.env) },
    );
    const canonicalGitRoot = await realpath(gitRoot.stdout.trim());
    if (!isContained(canonicalGitRoot, requestedWorkspace)) {
      throw new Error(`Git reported a worktree root that does not contain the requested workspace: ${canonicalGitRoot}`);
    }
    workspace = canonicalGitRoot;
  } catch (error) {
    if (!isNotGitRepositoryError(error)) {
      throw new Error(`Unable to determine the canonical Git worktree for ${workspace}: ${error.message}`, { cause: error });
    }
    // A confirmed non-Git lab or research directory remains its own workspace root.
  }
  const root = parse(workspace).root;
  if (workspace === root) throw new Error("Refusing to mount a filesystem root as a Pi cell workspace.");
  const home = await realpath(options.homeDir ?? resolveHarnessPaths(options.env ?? process.env).homeDir);
  if (isContained(workspace, home)) {
    throw new Error("Refusing to mount the home directory or one of its ancestors as a Pi cell workspace.");
  }
  if (options.cellsDir) {
    const cellsDir = await canonicalizeAvailablePrefix(options.cellsDir);
    if (isContained(workspace, cellsDir) || isContained(cellsDir, workspace)) {
      throw new Error("Refusing a Pi cell workspace that overlaps retained Pi cell state.");
    }
  }
  assertSafeCellMountTarget(workspace, "Cell workspace");
  rejectMountDelimiter(workspace, "Cell workspace");
  return workspace;
}

async function canonicalizeAvailablePrefix(target) {
  let cursor = resolve(target);
  const missing = [];
  while (true) {
    try {
      return resolve(await realpath(cursor), ...missing);
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) return resolve(cursor, ...missing);
      missing.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

export function workspaceDigest(workspace) {
  return createHash("sha256").update(workspace).digest("hex");
}

export function plannotatorPortForWorkspace(workspaceHash) {
  if (!/^[a-f0-9]{64}$/.test(workspaceHash)) throw new Error("Invalid workspace hash for Plannotator port allocation.");
  return PLANNOTATOR_PORT_MIN + (Number.parseInt(workspaceHash.slice(0, 8), 16) % PLANNOTATOR_PORT_SPAN);
}

export function cellIdentity(profileId, workspace) {
  assertProfileId(profileId);
  const slug = basename(workspace)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24) || "workspace";
  return assertCellName(`pi-${profileId}-${slug}-${workspaceDigest(workspace).slice(0, 10)}`);
}

function execCapture(command, args, options = {}) {
  const execFileImpl = options.execFileImpl ?? execFile;
  const allowedExitCodes = new Set(options.allowedExitCodes ?? [0]);
  return new Promise((resolvePromise, reject) => {
    execFileImpl(
      command,
      args,
      {
        encoding: "utf8",
        env: options.env ?? process.env,
        cwd: options.cwd,
        timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
        maxBuffer: options.maxBuffer ?? COMMAND_MAX_BUFFER,
        shell: false,
      },
      (error, stdout = "", stderr = "") => {
        const numericExit = typeof error?.code === "number";
        const exitCode = numericExit ? error.code : error ? undefined : 0;
        if (error && (!numericExit || !allowedExitCodes.has(exitCode))) {
          const detail = stderr.trim() || stdout.trim() || error.message;
          const failure = new Error(`${command} ${args.join(" ")} failed: ${detail}`, { cause: error });
          failure.exitCode = exitCode;
          failure.processCode = error.code;
          failure.stdout = stdout;
          failure.stderr = stderr;
          reject(failure);
          return;
        }
        resolvePromise({ exitCode: exitCode ?? 0, stdout, stderr });
      },
    );
  });
}

function isNotGitRepositoryError(error) {
  return (
    error?.exitCode === 128 &&
    /not a git repository(?: \(or any of the parent directories\))?/i.test(error.stderr || error.message)
  );
}

async function pathKind(path, expected, label) {
  const resolved = await realpath(path);
  const info = await stat(resolved);
  if (expected === "file" && !info.isFile()) throw new Error(`${label} is not a file: ${path}`);
  if (expected === "directory" && !info.isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
  rejectMountDelimiter(resolved, label);
  return resolved;
}

function addMount(mounts, mount) {
  rejectMountDelimiter(mount.source, mount.label);
  rejectMountDelimiter(mount.target, `${mount.label} target`);
  const existing = mounts.find((candidate) => candidate.target === mount.target);
  if (existing) {
    if (existing.source !== mount.source || existing.mode !== mount.mode) {
      throw new Error(`Conflicting cell mounts target ${mount.target}.`);
    }
    return;
  }
  const covering = mounts.find((candidate) => {
    if (candidate.mode !== mount.mode || !isContained(candidate.source, mount.source) || !isContained(candidate.target, mount.target)) {
      return false;
    }
    return relative(candidate.source, mount.source) === relative(candidate.target, mount.target);
  });
  if (covering) return;
  mounts.push(mount);
}

async function packageManifest(packageRoot) {
  const path = join(packageRoot, "package.json");
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read runtime package manifest ${path}: ${error.message}`);
  }
  return parsed;
}

async function resolveInstalledDependency(packageRoot, dependencyName, optional) {
  if (!/^(?:@[^/\\]+\/)?[^/\\]+$/.test(dependencyName) || dependencyName.includes("..")) {
    throw new Error(`Invalid npm dependency name '${dependencyName}' in ${packageRoot}.`);
  }
  const candidates = new Set();
  let cursor = packageRoot;
  while (true) {
    const nodeModules = basename(cursor) === "node_modules" ? cursor : join(cursor, "node_modules");
    candidates.add(join(nodeModules, ...dependencyName.split("/")));
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  for (const candidate of candidates) {
    let resolved;
    try {
      resolved = await realpath(candidate);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") continue;
      throw error;
    }
    const manifest = await packageManifest(resolved);
    if (manifest.name !== dependencyName) {
      throw new Error(`Resolved dependency '${dependencyName}' has mismatched package name '${manifest.name ?? "<missing>"}'.`);
    }
    return resolved;
  }
  if (optional) return undefined;
  throw new Error(`Unable to resolve dependency '${dependencyName}' required by ${packageRoot}.`);
}

export async function resolveNpmDependencyClosure(packageRoot, npmNodeModulesRoot, options = {}) {
  const root = await realpath(npmNodeModulesRoot);
  const first = await realpath(packageRoot);
  const imageProvidedPeers = options.imageProvidedPeers ?? IMAGE_PROVIDED_PEERS;
  const queue = [first];
  const seen = new Set();
  const packages = [];
  while (queue.length) {
    const current = queue.shift();
    if (seen.has(current)) continue;
    seen.add(current);
    if (!isContained(root, current)) {
      throw new Error(`Resolved npm runtime package escapes the managed npm root: ${current}`);
    }
    packages.push(current);
    const manifest = await packageManifest(current);
    const required = Object.keys(manifest.dependencies ?? {});
    const optional = Object.keys(manifest.optionalDependencies ?? {});
    const peers = Object.keys(manifest.peerDependencies ?? {});
    const optionalPeers = new Set(
      peers.filter((name) => manifest.peerDependenciesMeta?.[name]?.optional === true),
    );
    for (const name of [...new Set([...required, ...optional, ...peers])].sort()) {
      if (peers.includes(name) && imageProvidedPeers.has(name)) continue;
      const dependency = await resolveInstalledDependency(
        current,
        name,
        optional.includes(name) || optionalPeers.has(name),
      );
      if (dependency) queue.push(await dependency);
    }
  }
  return packages.sort();
}

async function selectedResourceMounts(workload, catalog, paths, workspace) {
  const selected = new Set([...workload.extensions, ...workload.child.extensions, ...workload.child.packages]);
  for (const skillName of workload.skills) {
    const skill = catalog.skills[skillName];
    if (skill.base === "resource") selected.add(skill.resource);
  }
  const mounts = [];
  const npmRoot = join(paths.baseAgentDir, "npm", "node_modules");
  const npmRootReal = await realpath(npmRoot).catch(() => undefined);
  for (const name of selected) {
    const resource = catalog.resources[name];
    const configuredRoot = resourceRoot(resource, paths);
    const source = await pathKind(
      resource.kind === "extension" ? dirname(configuredRoot) : configuredRoot,
      "directory",
      `${name} resource`,
    );
    if (isContained(workspace, source) || isContained(source, workspace)) {
      throw new Error(
        `Selected runtime resource '${name}' overlaps the writable workspace. Use an immutable installed copy before starting this cell.`,
      );
    }
    const targetRoot = resolveContained("/state/base-agent", resource.path, `${name} container resource`);
    const target = resource.kind === "extension" ? dirname(targetRoot) : targetRoot;
    if (resource.kind === "package" && npmRootReal && isContained(npmRootReal, source)) {
      for (const dependencySource of await resolveNpmDependencyClosure(source, npmRootReal)) {
        const dependencyRelative = relative(npmRootReal, dependencySource);
        addMount(mounts, {
          source: dependencySource,
          target: resolveContained("/state/base-agent/npm/node_modules", dependencyRelative, `${name} dependency target`),
          mode: "ro",
          label: `${name} dependency`,
        });
      }
    } else {
      addMount(mounts, { source, target, mode: "ro", label: `${name} resource` });
    }
  }
  for (const skillName of workload.skills) {
    const skill = catalog.skills[skillName];
    if (skill.base !== "sharedSkills") continue;
    const source = await pathKind(skillPath(catalog, skillName, paths), "directory", `${skillName} shared skill`);
    if (isContained(workspace, source) || isContained(source, workspace)) {
      throw new Error(`Selected shared skill '${skillName}' overlaps the writable workspace.`);
    }
    const target = resolveContained("/state/shared-skills", skill.path, `${skillName} container skill`);
    addMount(mounts, { source, target, mode: "ro", label: `${skillName} shared skill` });
  }
  return mounts;
}

async function gitRevParsePath(workspace, argument, options = {}) {
  const gitBin = options.gitBin ?? "git";
  const result = await execCapture(
    gitBin,
    ["-C", workspace, "rev-parse", "--path-format=absolute", argument],
    { ...options, env: cleanGitEnvironment(options.env) },
  );
  return realpath(result.stdout.trim());
}

async function readGitPointer(path, label, prefix = "") {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} is not a regular file: ${path}`);
  const content = await readFile(path, "utf8");
  if (content.includes("\0") || content.trim() === "" || content.trim().includes("\n") || content.trim().includes("\r")) {
    throw new Error(`${label} must contain exactly one path: ${path}`);
  }
  const line = content.trim();
  if (prefix && !line.startsWith(prefix)) throw new Error(`${label} has an invalid prefix: ${path}`);
  const value = prefix ? line.slice(prefix.length) : line;
  if (!value) throw new Error(`${label} has an empty path: ${path}`);
  return value;
}

async function resolveGitPointer(pointerFile, value) {
  return realpath(resolve(dirname(pointerFile), value));
}

async function validatedGitCommonDir(workspace, options = {}) {
  const dotGit = join(workspace, ".git");
  const dotGitInfo = await lstat(dotGit).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!dotGitInfo) return undefined;
  if (dotGitInfo.isSymbolicLink() || (!dotGitInfo.isDirectory() && !dotGitInfo.isFile())) {
    throw new Error(`Unsupported Git metadata path; .git must be a directory or regular linked-worktree file: ${dotGit}`);
  }

  let gitDir;
  let commonDir;
  try {
    [gitDir, commonDir] = await Promise.all([
      gitRevParsePath(workspace, "--absolute-git-dir", options),
      gitRevParsePath(workspace, "--git-common-dir", options),
    ]);
  } catch (error) {
    throw new Error(`Unable to validate Git topology for ${workspace}: ${error.message}`, { cause: error });
  }

  if (dotGitInfo.isDirectory()) {
    const canonicalDotGit = await realpath(dotGit);
    if (gitDir !== canonicalDotGit || commonDir !== canonicalDotGit) {
      throw new Error(
        `Standard Git worktree has an external or rewritten git directory; refusing extra mount: ${workspace}`,
      );
    }
    return commonDir;
  }

  const pointerValue = await readGitPointer(dotGit, "Linked-worktree .git pointer", "gitdir: ");
  if ((await resolveGitPointer(dotGit, pointerValue)) !== gitDir) {
    throw new Error(`Linked-worktree .git pointer does not match Git's absolute git directory: ${dotGit}`);
  }
  const worktreesRoot = await realpath(join(commonDir, "worktrees"));
  const topologyRelation = relative(worktreesRoot, gitDir);
  if (
    topologyRelation === "" ||
    topologyRelation === ".." ||
    topologyRelation.startsWith(`..${sep}`) ||
    topologyRelation.includes(sep) ||
    dirname(gitDir) !== worktreesRoot
  ) {
    throw new Error(`External Git directory is not a standard linked-worktree entry under ${worktreesRoot}: ${gitDir}`);
  }
  const commonPointer = join(gitDir, "commondir");
  const commonValue = await readGitPointer(commonPointer, "Linked-worktree commondir pointer");
  if ((await resolveGitPointer(commonPointer, commonValue)) !== commonDir) {
    throw new Error(`Linked-worktree commondir pointer does not resolve to Git's common directory: ${commonPointer}`);
  }
  const backlink = join(gitDir, "gitdir");
  const backlinkValue = await readGitPointer(backlink, "Linked-worktree backlink");
  if ((await resolveGitPointer(backlink, backlinkValue)) !== (await realpath(dotGit))) {
    throw new Error(`Linked-worktree backlink does not resolve to the selected workspace: ${backlink}`);
  }
  return commonDir;
}

async function assertSafeGitCommonDirSource(commonDir, paths) {
  const home = await realpath(paths.homeDir);
  if (isContained(commonDir, home)) {
    throw new Error(`Refusing a Git common directory that contains the host home: ${commonDir}`);
  }
  const protectedRoots = [
    paths.baseAgentDir,
    paths.profilesDir,
    paths.sharedSkillsDir,
    paths.cellsDir,
    join(home, ".ssh"),
    join(home, ".gnupg"),
    join(home, ".aws"),
    join(home, ".kube"),
    join(home, ".docker"),
    join(home, ".config", "gcloud"),
    join(home, ".config", "containers"),
    join(home, ".local", "share", "containers"),
  ];
  for (const configured of protectedRoots) {
    const protectedRoot = await canonicalizeAvailablePrefix(configured);
    if (isContained(commonDir, protectedRoot) || isContained(protectedRoot, commonDir)) {
      throw new Error(`Refusing a Git common directory that overlaps protected host state: ${commonDir}`);
    }
  }
}

export async function buildCellMounts(context, options = {}) {
  const { cellDir, workload, catalog, paths, workspace } = context;
  assertSafeCellMountTarget(workspace, "Cell workspace");
  const mounts = [];
  const home = join(cellDir, "home");
  const launch = join(cellDir, "launch");
  const temporary = join(cellDir, "tmp");
  const writerLeases = join(cellDir, "writer-leases");
  const credentials = join(cellDir, "credentials");
  for (const path of [home, launch, temporary, writerLeases, credentials]) await ensureManagedDirectory(path);
  const privateAuth = join(credentials, "auth.json");
  const privateModels = join(credentials, "models-store.json");
  await seedPrivateFile(join(paths.baseAgentDir, "auth.json"), privateAuth, "Pi authentication");
  await seedPrivateFile(join(paths.baseAgentDir, "models-store.json"), privateModels, "Pi model store");

  addMount(mounts, {
    source: await pathKind(home, "directory", "cell home"),
    target: "/home/pi",
    mode: "rw",
    label: "cell home",
  });
  addMount(mounts, {
    source: await pathKind(launch, "directory", "cell launch directory"),
    target: "/run/pi-cell-launch",
    mode: "rw",
    label: "cell launch directory",
  });
  addMount(mounts, {
    source: await pathKind(temporary, "directory", "cell temporary directory"),
    target: "/tmp",
    mode: "rw",
    label: "cell temporary directory",
  });
  addMount(mounts, {
    source: await pathKind(writerLeases, "directory", "cell writer leases"),
    target: "/state/base-agent/workbench/writer-leases",
    mode: "rw",
    label: "cell writer leases",
  });
  addMount(mounts, {
    source: await pathKind(join(paths.baseAgentDir, "settings.json"), "file", "base Pi settings"),
    target: "/state/base-agent/settings.json",
    mode: "ro",
    label: "base Pi settings",
  });
  addMount(mounts, {
    source: await pathKind(privateAuth, "file", "cell Pi authentication"),
    target: "/state/base-agent/auth.json",
    mode: "rw",
    label: "cell Pi authentication",
  });
  addMount(mounts, {
    source: await pathKind(privateModels, "file", "cell Pi model store"),
    target: "/state/base-agent/models-store.json",
    mode: "rw",
    label: "cell Pi model store",
  });
  addMount(mounts, {
    source: await pathKind(join(paths.baseAgentDir, "themes"), "directory", "base Pi themes"),
    target: "/state/base-agent/themes",
    mode: "ro",
    label: "base Pi themes",
  });
  for (const mount of await selectedResourceMounts(workload, catalog, paths, workspace)) addMount(mounts, mount);

  const workspaceMode = workload.readOnly ? "ro" : "rw";
  addMount(mounts, {
    source: workspace,
    target: workspace,
    mode: workspaceMode,
    label: "cell workspace",
  });
  const commonDir = await validatedGitCommonDir(workspace, options);
  if (commonDir && !isContained(workspace, commonDir)) {
    await assertSafeGitCommonDirSource(commonDir, paths);
    assertSafeCellMountTarget(commonDir, "Git common directory");
    addMount(mounts, {
      source: await pathKind(commonDir, "directory", "Git common directory"),
      target: commonDir,
      mode: workspaceMode,
      label: "Git common directory",
    });
  }
  return mounts;
}

function cleanTerm(value) {
  return typeof value === "string" && /^[A-Za-z0-9+._-]{1,40}$/.test(value) ? value : "xterm-256color";
}

export function buildPodmanCreateArgs(context) {
  const {
    name,
    containerName,
    profileId,
    workspace,
    workspaceHash,
    image,
    mounts,
    uid,
    gid,
    plannotatorPort,
    env = process.env,
  } = context;
  const args = [
    "create",
    `--name=${containerName}`,
    `--hostname=${name}`,
    "--pull=never",
    "--restart=no",
    "--entrypoint=/opt/pi-harness/container/bootstrap.sh",
    "--no-healthcheck",
    "--image-volume=ignore",
    "--stop-signal=SIGTERM",
    "--network=pasta:--map-guest-addr,none",
    "--interactive",
    "--tty",
    "--userns=keep-id",
    // The immutable bootstrap uses these capabilities only to install
    // metadata-server deny routes and irreversibly become the caller's
    // keep-id UID before the unprivileged init or any workload code starts.
    "--user=0:0",
    "--cap-drop=all",
    "--cap-add=net_admin",
    "--cap-add=setgid",
    "--cap-add=setpcap",
    "--cap-add=setuid",
    "--security-opt=no-new-privileges",
    "--http-proxy=false",
    "--unsetenv-all",
    "--read-only",
    `--pids-limit=${env.PI_HARNESS_CELL_PIDS_LIMIT ?? DEFAULT_PIDS_LIMIT}`,
    `--cpus=${env.PI_HARNESS_CELL_CPUS ?? DEFAULT_CPUS}`,
    `--memory=${env.PI_HARNESS_CELL_MEMORY ?? DEFAULT_MEMORY}`,
    `--workdir=${workspace}`,
    `--label=${MANAGED_LABEL}=true`,
    `--label=${CELL_LABEL}=${name}`,
    `--label=${PROFILE_LABEL}=${profileId}`,
    `--label=${WORKSPACE_LABEL}=${workspaceHash}`,
    "--env=HOME=/home/pi",
    "--env=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "--env=LANG=C.UTF-8",
    "--env=COLORTERM=truecolor",
    `--env=TERM=${cleanTerm(env.TERM)}`,
    "--env=PI_HARNESS_IN_CELL=1",
    "--env=PI_HARNESS_EXECUTION=direct",
    "--env=PI_HARNESS_HOME_DIR=/home/pi",
    "--env=PI_HARNESS_BASE_AGENT_DIR=/state/base-agent",
    "--env=PI_HARNESS_PROFILES_DIR=/home/pi/.pi/profiles",
    "--env=PI_HARNESS_SHARED_SKILLS_DIR=/state/shared-skills",
    "--env=PI_HARNESS_PI_BIN=/usr/local/bin/pi",
    `--env=PI_HARNESS_CELL_NAME=${name}`,
    `--env=PI_HARNESS_CELL_UID=${uid}`,
    `--env=PI_HARNESS_CELL_GID=${gid}`,
  ];
  if (profileId === "eng" && plannotatorPort) {
    args.push(
      `--publish=127.0.0.1:${plannotatorPort}:${plannotatorPort}/tcp`,
      "--env=PLANNOTATOR_REMOTE=1",
      `--env=PLANNOTATOR_PORT=${plannotatorPort}`,
      "--env=PLANNOTATOR_BROWSER=none",
    );
  }
  for (const mount of mounts) args.push(`--volume=${mount.source}:${mount.target}:${mount.mode}`);
  args.push(image);
  return args;
}

async function ensureManagedDirectory(path) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (info?.isSymbolicLink()) throw new Error(`Refusing symlink as managed Pi cell directory: ${path}`);
  if (info && !info.isDirectory()) throw new Error(`Managed Pi cell path is not a directory: ${path}`);
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function seedPrivateFile(source, destination, label) {
  const existing = await lstat(destination).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error(`Refusing non-regular private ${label} state: ${destination}`);
    }
    await chmod(destination, 0o600);
    return;
  }
  const content = await readFile(source);
  await writeFile(destination, content, { flag: "wx", mode: 0o600 });
}

async function writeJsonAtomic(path, value) {
  const existing = await lstat(path).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    throw new Error(`Refusing to overwrite non-regular Pi cell state: ${path}`);
  }
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function readJsonFile(path, label) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} is not a regular file: ${path}`);
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read ${label} at ${path}: ${error.message}`);
  }
}

function cellPaths(paths, name) {
  const cellDir = join(paths.cellsDir, name);
  return {
    cellDir,
    manifestPath: join(cellDir, "manifest.json"),
    requestPath: join(cellDir, "launch", "request.json"),
    readyPath: join(cellDir, "launch", "ready.json"),
  };
}

async function loadManifest(paths, name) {
  const locations = cellPaths(paths, name);
  const manifest = await readJsonFile(locations.manifestPath, "Pi cell manifest");
  if (!manifest) return { ...locations, manifest: undefined };
  if (
    manifest.schemaVersion !== CELL_SCHEMA_VERSION ||
    manifest.name !== name ||
    !["eng", "design", "research", "learn"].includes(manifest.profileId) ||
    typeof manifest.workspace !== "string" ||
    manifest.workspaceHash !== workspaceDigest(manifest.workspace) ||
    typeof manifest.mutable !== "boolean" ||
    manifest.containerName !== `pi-cell-${name}` ||
    (manifest.plannotatorPort !== undefined &&
      (!Number.isInteger(manifest.plannotatorPort) ||
        manifest.plannotatorPort < PLANNOTATOR_PORT_MIN ||
        manifest.plannotatorPort >= PLANNOTATOR_PORT_MIN + PLANNOTATOR_PORT_SPAN))
  ) {
    throw new Error(`Invalid Pi cell manifest: ${locations.manifestPath}`);
  }
  return { ...locations, manifest };
}

async function inspectContainer(paths, containerName, options = {}) {
  const exists = await execCapture(paths.podmanBin, ["container", "exists", containerName], {
    ...options,
    allowedExitCodes: [0, 1],
  });
  if (exists.exitCode === 1) return undefined;
  const result = await execCapture(paths.podmanBin, ["container", "inspect", containerName], options);
  const parsed = JSON.parse(result.stdout);
  if (!Array.isArray(parsed) || !parsed[0]) throw new Error(`Podman returned invalid inspect data for ${containerName}.`);
  return parsed[0];
}

function containerRunning(inspect) {
  return inspect?.State?.Running === true;
}

function verifyManagedContainer(inspect, manifest) {
  const labels = inspect?.Config?.Labels ?? {};
  const expected = {
    [MANAGED_LABEL]: "true",
    [CELL_LABEL]: manifest.name,
    [PROFILE_LABEL]: manifest.profileId,
    [WORKSPACE_LABEL]: manifest.workspaceHash,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (labels[key] !== value) throw new Error(`Refusing Podman container with mismatched ${key} label.`);
  }
}

async function inspectImage(paths, catalog, options = {}) {
  const result = await execCapture(paths.podmanBin, ["image", "inspect", paths.cellImage], options);
  const parsed = JSON.parse(result.stdout);
  const image = parsed?.[0];
  if (!image?.Id) throw new Error(`Podman returned invalid image inspect data for ${paths.cellImage}.`);
  const labels = image.Config?.Labels ?? {};
  if (labels[IMAGE_SCHEMA_LABEL] !== CELL_IMAGE_SCHEMA_VERSION) {
    throw new Error(`Cell image ${paths.cellImage} has no compatible Pi Harness image schema label; rebuild it.`);
  }
  if (labels[PI_VERSION_LABEL] !== catalog.pi.version) {
    throw new Error(
      `Cell image ${paths.cellImage} contains Pi ${labels[PI_VERSION_LABEL] ?? "<unknown>"}; expected ${catalog.pi.version}.`,
    );
  }
  const payloadHash = options.payloadHash ?? (await computeHarnessPayloadHash(paths.repoRoot));
  if (labels[PAYLOAD_HASH_LABEL] !== payloadHash) {
    throw new Error(
      `Cell image ${paths.cellImage} contains harness payload ${labels[PAYLOAD_HASH_LABEL] ?? "<unknown>"}; ` +
        `expected ${payloadHash}. Rebuild it before launching a cell.`,
    );
  }
  return image;
}

export async function inspectCellHost(paths, catalog, options = {}) {
  if ((options.platform ?? process.platform) !== "linux") {
    throw new Error("Pi cells require a Linux host with rootless Podman and user systemd.");
  }
  const version = await execCapture(paths.podmanBin, ["--version"], options);
  const info = await execCapture(
    paths.podmanBin,
    ["info", "--format", "{{.Host.Security.Rootless}}|{{.Host.CgroupManager}}|{{.Host.CgroupsVersion}}"],
    options,
  );
  const [rootless, cgroupManager, cgroupsVersion] = info.stdout.trim().split("|");
  if (rootless !== "true") throw new Error("Pi cells require rootless Podman; current Podman is not rootless.");
  if (cgroupManager !== "systemd" || cgroupsVersion !== "v2") {
    throw new Error(`Pi cells require Podman with systemd cgroups v2; found ${cgroupManager || "?"}/${cgroupsVersion || "?"}.`);
  }
  const linger = await execCapture(
    "loginctl",
    ["show-user", String(options.uid ?? process.getuid()), "--property=Linger", "--value"],
    options,
  );
  if (linger.stdout.trim() !== "yes") {
    throw new Error(`User lingering is disabled. Run: sudo loginctl enable-linger ${options.user ?? process.env.USER ?? process.getuid()}`);
  }
  const image = await inspectImage(paths, catalog, options);
  return { podmanVersion: version.stdout.trim(), rootless: true, cgroupManager, cgroupsVersion, linger: true, image };
}

async function acquireOperationLock(paths, name) {
  const root = join(paths.cellsDir, ".locks", "operations");
  await ensureManagedDirectory(root);
  const lock = join(root, `${name}.lock`);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(lock, { mode: 0o700 });
      await writeJsonAtomic(join(lock, "owner.json"), { pid: process.pid, createdAt: new Date().toISOString() });
      return async () => {
        await unlink(join(lock, "owner.json")).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
        await rmdir(lock).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = await readJsonFile(join(lock, "owner.json"), "Pi cell operation lock");
      if (!owner) {
        const lockInfo = await lstat(lock);
        if (Date.now() - lockInfo.mtimeMs < 30_000) {
          throw new Error(`Another pi-cell operation is initializing '${name}'.`);
        }
      }
      let alive = false;
      if (Number.isInteger(owner?.pid)) {
        try {
          process.kill(owner.pid, 0);
          alive = true;
        } catch (probeError) {
          if (probeError.code === "EPERM") alive = true;
        }
      }
      if (alive) throw new Error(`Another pi-cell operation is already managing '${name}'.`);
      const stale = `${lock}.stale-${process.pid}-${Date.now()}`;
      try {
        await rename(lock, stale);
        await rm(stale, { recursive: true, force: true });
      } catch (renameError) {
        if (renameError.code !== "ENOENT") throw renameError;
      }
    }
  }
  throw new Error(`Unable to acquire Pi cell operation lock for '${name}'.`);
}

async function acquireWorkspaceOperationLock(paths, workspaceHash) {
  const root = join(paths.cellsDir, ".locks", "workspace-operations");
  await ensureManagedDirectory(root);
  const lock = join(root, `${workspaceHash}.lock`);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(lock, { mode: 0o700 });
      await writeJsonAtomic(join(lock, "owner.json"), { pid: process.pid, createdAt: new Date().toISOString() });
      return async () => {
        await unlink(join(lock, "owner.json")).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
        await rmdir(lock).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = await readJsonFile(join(lock, "owner.json"), "Pi cell workspace operation lock");
      if (!owner) {
        const lockInfo = await lstat(lock);
        if (Date.now() - lockInfo.mtimeMs < 30_000) {
          throw new Error("Another Pi cell workspace operation is still initializing.");
        }
      }
      let alive = false;
      if (Number.isInteger(owner?.pid)) {
        try {
          process.kill(owner.pid, 0);
          alive = true;
        } catch (probeError) {
          if (probeError.code === "EPERM") alive = true;
        }
      }
      if (alive) throw new Error("Another Pi cell workspace operation is already in progress.");
      const stale = `${lock}.stale-${process.pid}-${Date.now()}`;
      try {
        await rename(lock, stale);
        await rm(stale, { recursive: true, force: true });
      } catch (renameError) {
        if (renameError.code !== "ENOENT") throw renameError;
      }
    }
  }
  throw new Error("Unable to serialize the Pi cell workspace operation.");
}

async function removeOwnedWorkspaceLease(paths, manifest) {
  const lock = join(paths.cellsDir, ".locks", "workspaces", `${manifest.workspaceHash}.lock`);
  const owner = await readJsonFile(join(lock, "owner.json"), "Pi cell workspace lease");
  if (owner?.name !== manifest.name) return;
  await unlink(join(lock, "owner.json")).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  await rmdir(lock).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
}

async function acquireWorkspaceLease(paths, manifest, options = {}) {
  if (!manifest.mutable) return async () => {};
  const root = join(paths.cellsDir, ".locks", "workspaces");
  await ensureManagedDirectory(root);
  const lock = join(root, `${manifest.workspaceHash}.lock`);
  const releaseWorkspaceOperation = await acquireWorkspaceOperationLock(paths, manifest.workspaceHash);
  try {
    const owner = await readJsonFile(join(lock, "owner.json"), "Pi cell workspace lease");
    if (owner) {
      const inspect = owner.containerName ? await inspectContainer(paths, owner.containerName, options) : undefined;
      if (inspect) {
        throw new Error(
          `Workspace is retained by ${inspect.State?.Status ?? "existing"} mutable cell '${owner.name}'. ` +
            "Stop and remove that cell before starting another writer.",
        );
      }
      let creatorAlive = false;
      if (Number.isInteger(owner.pid)) {
        try {
          process.kill(owner.pid, 0);
          creatorAlive = true;
        } catch (probeError) {
          if (probeError.code === "EPERM") creatorAlive = true;
        }
      }
      if (creatorAlive) throw new Error(`Workspace cell '${owner.name}' is still being created.`);
      const stale = `${lock}.stale-${process.pid}-${Date.now()}`;
      try {
        await rename(lock, stale);
        await rm(stale, { recursive: true, force: true });
      } catch (renameError) {
        if (renameError.code !== "ENOENT") throw renameError;
      }
    } else {
      const abandoned = await lstat(lock).catch((error) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (abandoned) {
        const stale = `${lock}.stale-${process.pid}-${Date.now()}`;
        await rename(lock, stale);
        await rm(stale, { recursive: true, force: true });
      }
    }
    await mkdir(lock, { mode: 0o700 });
    await writeJsonAtomic(join(lock, "owner.json"), {
      name: manifest.name,
      containerName: manifest.containerName,
      pid: process.pid,
      createdAt: new Date().toISOString(),
    });
    return () => releaseWorkspaceLease(paths, manifest);
  } finally {
    await releaseWorkspaceOperation();
  }
}

function startThroughUserSystemd(paths, containerName, options = {}) {
  const unit = `pi-cell-start-${containerName.slice(0, 32)}-${process.pid}-${Date.now()}`;
  return execCapture(
    paths.systemdRunBin,
    [
      "--user",
      "--collect",
      "--quiet",
      `--unit=${unit}`,
      "--property=Type=exec",
      "--",
      paths.podmanBin,
      "start",
      "--attach",
      "--sig-proxy=false",
      containerName,
    ],
    { ...options, timeoutMs: options.startTimeoutMs ?? START_TIMEOUT_MS },
  );
}

function processIsAlive(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (options.processIsAlive) return options.processIsAlive(pid);
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export async function waitForContainerReady(paths, containerName, readyPath, launchId, options = {}) {
  const deadline = Date.now() + (options.startReadyTimeoutMs ?? START_READY_TIMEOUT_MS);
  let last;
  while (Date.now() <= deadline) {
    last = await inspectContainer(paths, containerName, options);
    if (containerRunning(last) && processIsAlive(last.State?.Pid, options)) {
      const ready = await readJsonFile(readyPath, "Pi cell readiness marker");
      if (ready?.schemaVersion === 1 && ready.launchId === launchId) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, options.startReadyPollMs ?? START_READY_POLL_MS));
        const confirmed = await inspectContainer(paths, containerName, options);
        if (containerRunning(confirmed) && processIsAlive(confirmed.State?.Pid, options)) return confirmed;
        return confirmed;
      }
    }
    if (last && ["exited", "dead", "stopped"].includes(last.State?.Status)) return last;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, options.startReadyPollMs ?? START_READY_POLL_MS));
  }
  throw new Error(
    `Cell readiness handshake timed out while ${containerName} was ${last?.State?.Status ?? "missing"}. ` +
      "The sandbox and Pi spawn must complete before a launch is reported as running.",
  );
}

function attachProcess(paths, containerName, options = {}) {
  const spawnImpl = options.spawnImpl ?? spawn;
  return new Promise((resolvePromise, reject) => {
    const child = spawnImpl(
      paths.podmanBin,
      ["attach", "--sig-proxy=false", `--detach-keys=${CELL_DETACH_KEYS}`, containerName],
      { stdio: "inherit", shell: false, env: options.env ?? process.env },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => resolvePromise(signal ? 128 + (signal === "SIGINT" ? 2 : 1) : (code ?? 1)));
  });
}

async function prepareRun(profileId, piArgs, options = {}) {
  validatePassthroughArgs(piArgs);
  const env = options.env ?? process.env;
  const paths = options.paths ?? resolveHarnessPaths(env, options.pathOverrides);
  const workspace = await resolveCellWorkspace(options.workspace, {
    ...options,
    cwd: options.cwd,
    homeDir: paths.homeDir,
    cellsDir: paths.cellsDir,
    env,
  });
  const name = assertCellName(options.name ?? cellIdentity(profileId, workspace));
  const containerName = `pi-cell-${name}`;
  const workspaceHash = workspaceDigest(workspace);
  await ensureManagedDirectory(paths.cellsDir);
  const releaseOperation = await acquireOperationLock(paths, name);
  let shouldAttach = false;
  try {
    const catalog = options.catalog ?? (await loadCatalog(paths));
    const workload = options.workload ?? (await loadWorkload(paths, profileId, catalog));
    const state = await loadManifest(paths, name);
    if (state.manifest) {
      if (state.manifest.profileId !== profileId || state.manifest.workspace !== workspace) {
        throw new Error(`Cell '${name}' already belongs to ${state.manifest.profileId} at ${state.manifest.workspace}.`);
      }
      const existing = await inspectContainer(paths, state.manifest.containerName, options);
      if (existing) {
        verifyManagedContainer(existing, state.manifest);
        if (containerRunning(existing)) {
          if (!processIsAlive(existing.State?.Pid, options)) {
            throw new Error(
              `Cell '${name}' has stale running metadata but no live container process. ` +
                `Run 'pi-cell remove ${name}' before launching it again.`,
            );
          }
          if (piArgs.length) {
            throw new Error(`Cell '${name}' is already running; refusing to discard or inject new Pi arguments.`);
          }
          return { paths, name, containerName: state.manifest.containerName, shouldAttach: !options.detach, existing: true };
        }
        throw new Error(
          `Cell '${name}' is stopped (${existing.State?.Status ?? "unknown"}, exit ${existing.State?.ExitCode ?? "?"}). ` +
            `It will not be restarted automatically. Inspect logs, run 'pi-cell remove ${name}', then launch explicitly with -r or --session.`,
        );
      }
    } else {
      const foreign = await inspectContainer(paths, containerName, options);
      if (foreign) throw new Error(`Podman container name '${containerName}' is occupied without a matching Pi cell manifest.`);
    }

    const host = await inspectCellHost(paths, catalog, options);
    const manifest = {
      schemaVersion: CELL_SCHEMA_VERSION,
      name,
      profileId,
      workspace,
      workspaceHash,
      mutable: !workload.readOnly,
      containerName,
      image: paths.cellImage,
      imageId: host.image.Id,
      createdAt: state.manifest?.createdAt ?? new Date().toISOString(),
      lastStartedAt: new Date().toISOString(),
      ...(profileId === "eng" ? { plannotatorPort: plannotatorPortForWorkspace(workspaceHash) } : {}),
    };
    await ensureManagedDirectory(state.cellDir);
    const mounts = await buildCellMounts({ ...manifest, cellDir: state.cellDir, workload, catalog, paths }, options);
    const requestInfo = await lstat(state.requestPath).catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (requestInfo) throw new Error(`Unconsumed cell launch request exists: ${state.requestPath}`);
    const readyInfo = await lstat(state.readyPath).catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (readyInfo) {
      if (readyInfo.isSymbolicLink() || !readyInfo.isFile()) {
        throw new Error(`Refusing non-regular Pi cell readiness state: ${state.readyPath}`);
      }
      await unlink(state.readyPath);
    }
    const releaseWorkspace = await acquireWorkspaceLease(paths, manifest, options);
    const launchId = randomUUID();
    let createAttempted = false;
    let ownsRuntime = false;
    let absenceConfirmed = false;
    try {
      // Publish recoverable identity before the one-shot request. If the
      // launcher disappears in this narrow window, the next invocation can
      // reconcile the dead creator's lease from the manifest. The inverse
      // ordering left an orphan prompt with no CLI-addressable cell.
      await writeJsonAtomic(state.manifestPath, manifest);
      await writeJsonAtomic(state.requestPath, { schemaVersion: 2, launchId, profileId, args: piArgs });
      const createArgs = buildPodmanCreateArgs({
        ...manifest,
        image: manifest.imageId,
        mounts,
        uid: options.uid ?? process.getuid(),
        gid: options.gid ?? process.getgid(),
        env,
      });
      createAttempted = true;
      try {
        await execCapture(paths.podmanBin, createArgs, {
          ...options,
          timeoutMs: options.createTimeoutMs ?? CREATE_TIMEOUT_MS,
        });
        ownsRuntime = true;
      } catch (createError) {
        const recovered = await inspectContainer(paths, containerName, options);
        if (!recovered) {
          absenceConfirmed = true;
          throw createError;
        }
        ownsRuntime = true;
        verifyManagedContainer(recovered, manifest);
      }
      await startThroughUserSystemd(paths, containerName, options);
      const running = await waitForContainerReady(paths, containerName, state.readyPath, launchId, options);
      if (!containerRunning(running) || !processIsAlive(running.State?.Pid, options)) {
        throw new Error(
          `Cell '${name}' did not remain running (status ${running?.State?.Status ?? "missing"}, ` +
            `exit ${running?.State?.ExitCode ?? "?"}). Use 'pi-cell logs ${name}' for details.`,
        );
      }
      verifyManagedContainer(running, manifest);
      shouldAttach = !options.detach;
    } catch (error) {
      if (!createAttempted || absenceConfirmed) {
        await unlink(state.requestPath).catch((unlinkError) => {
          if (unlinkError.code !== "ENOENT") throw unlinkError;
        });
        await releaseWorkspace();
      } else if (!ownsRuntime) {
        throw new Error(
          `${error.message} The container outcome could not be reconciled, so the workspace lease and launch request were retained. ` +
            `Inspect '${containerName}' before running 'pi-cell remove ${name}'.`,
          { cause: error },
        );
      }
      throw error;
    }
    return { paths, name, containerName, shouldAttach, existing: false };
  } finally {
    await releaseOperation();
  }
}

export async function runProfileCell(profileId, piArgs = [], options = {}) {
  const prepared = await prepareRun(profileId, piArgs, options);
  const stdout = options.stdout ?? process.stdout;
  if (!prepared.shouldAttach) {
    stdout.write(`Pi cell '${prepared.name}' is running. Attach with: pi-cell attach ${prepared.name}\n`);
    return 0;
  }
  stdout.write(`Attaching to Pi cell '${prepared.name}'. Detach without stopping it with Ctrl-].\n`);
  return attachProcess(prepared.paths, prepared.containerName, options);
}

async function managedCell(paths, name, options = {}) {
  const state = await loadManifest(paths, name);
  if (!state.manifest) throw new Error(`Unknown Pi cell '${name}'.`);
  const inspect = await inspectContainer(paths, state.manifest.containerName, options);
  if (inspect) verifyManagedContainer(inspect, state.manifest);
  return { ...state, inspect };
}

export async function attachCell(name, options = {}) {
  const paths = options.paths ?? resolveHarnessPaths(options.env ?? process.env, options.pathOverrides);
  const cell = await managedCell(paths, name, options);
  if (!containerRunning(cell.inspect) || !processIsAlive(cell.inspect.State?.Pid, options)) {
    throw new Error(`Pi cell '${name}' is not running with a live container process.`);
  }
  (options.stdout ?? process.stdout).write(`Detach without stopping '${name}' with Ctrl-].\n`);
  return attachProcess(paths, cell.manifest.containerName, options);
}

export async function statusCell(name, options = {}) {
  const paths = options.paths ?? resolveHarnessPaths(options.env ?? process.env, options.pathOverrides);
  const cell = await managedCell(paths, name, options);
  const reportedStatus = cell.inspect?.State?.Status ?? "removed";
  const status =
    reportedStatus === "running" && !processIsAlive(cell.inspect?.State?.Pid, options)
      ? "stale-running"
      : reportedStatus;
  const exitCode = cell.inspect?.State?.ExitCode;
  (options.stdout ?? process.stdout).write(
    `${name}\t${status}${status === "running" ? "" : `\texit=${exitCode ?? "-"}`}\t${cell.manifest.profileId}\t${cell.manifest.workspace}` +
      `${cell.manifest.plannotatorPort ? `\tplannotator=127.0.0.1:${cell.manifest.plannotatorPort}` : ""}\n`,
  );
  return 0;
}

export async function listCells(options = {}) {
  const paths = options.paths ?? resolveHarnessPaths(options.env ?? process.env, options.pathOverrides);
  await ensureManagedDirectory(paths.cellsDir);
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(paths.cellsDir, { withFileTypes: true });
  const names = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name).sort();
  for (const name of names) await statusCell(name, { ...options, paths });
  if (!names.length) (options.stdout ?? process.stdout).write("No Pi cells.\n");
  return 0;
}

export async function logsCell(name, options = {}) {
  const paths = options.paths ?? resolveHarnessPaths(options.env ?? process.env, options.pathOverrides);
  const cell = await managedCell(paths, name, options);
  if (!cell.inspect) throw new Error(`Pi cell '${name}' runtime has been removed; retained session state remains.`);
  const spawnImpl = options.spawnImpl ?? spawn;
  return new Promise((resolvePromise, reject) => {
    const args = ["logs", ...(options.follow ? ["--follow"] : []), cell.manifest.containerName];
    const child = spawnImpl(paths.podmanBin, args, { stdio: "inherit", shell: false, env: options.env ?? process.env });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolvePromise(signal ? 129 : (code ?? 1)));
  });
}

export async function stopCell(name, options = {}) {
  const paths = options.paths ?? resolveHarnessPaths(options.env ?? process.env, options.pathOverrides);
  const releaseOperation = await acquireOperationLock(paths, name);
  try {
    const cell = await managedCell(paths, name, options);
    if (!cell.inspect) throw new Error(`Pi cell '${name}' runtime has already been removed.`);
    if (!containerRunning(cell.inspect)) throw new Error(`Pi cell '${name}' is already stopped.`);
    if (!processIsAlive(cell.inspect.State?.Pid, options)) {
      throw new Error(`Pi cell '${name}' has stale running metadata; remove the dead runtime explicitly.`);
    }
    await execCapture(paths.podmanBin, ["stop", "--time=30", cell.manifest.containerName], {
      ...options,
      timeoutMs: options.stopTimeoutMs ?? STOP_TIMEOUT_MS,
    });
    (options.stdout ?? process.stdout).write(`Stopped Pi cell '${name}'. Session state is retained.\n`);
    return 0;
  } finally {
    await releaseOperation();
  }
}

async function releaseWorkspaceLease(paths, manifest) {
  if (!manifest.mutable) return;
  const releaseWorkspaceOperation = await acquireWorkspaceOperationLock(paths, manifest.workspaceHash);
  try {
    await removeOwnedWorkspaceLease(paths, manifest);
  } finally {
    await releaseWorkspaceOperation();
  }
}

export async function removeCell(name, options = {}) {
  const paths = options.paths ?? resolveHarnessPaths(options.env ?? process.env, options.pathOverrides);
  const releaseOperation = await acquireOperationLock(paths, name);
  try {
    const cell = await managedCell(paths, name, options);
    const live = containerRunning(cell.inspect) && processIsAlive(cell.inspect.State?.Pid, options);
    if (live) throw new Error(`Refusing to remove running cell '${name}'; stop it explicitly first.`);
    if (cell.inspect) {
      await execCapture(
        paths.podmanBin,
        ["rm", ...(containerRunning(cell.inspect) ? ["--force"] : []), cell.manifest.containerName],
        options,
      );
    }
    await releaseWorkspaceLease(paths, cell.manifest);
    await unlink(cell.requestPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    await writeJsonAtomic(cell.manifestPath, { ...cell.manifest, removedAt: new Date().toISOString() });
    (options.stdout ?? process.stdout).write(`Removed Pi cell '${name}' runtime. Retained home and sessions at ${cell.cellDir}.\n`);
    return 0;
  } finally {
    await releaseOperation();
  }
}

export async function doctorCells(options = {}) {
  const env = options.env ?? process.env;
  const paths = options.paths ?? resolveHarnessPaths(env, options.pathOverrides);
  const catalog = options.catalog ?? (await loadCatalog(paths));
  const result = await inspectCellHost(paths, catalog, options);
  const stdout = options.stdout ?? process.stdout;
  stdout.write(`OK ${result.podmanVersion}\n`);
  stdout.write(`OK rootless Podman with ${result.cgroupManager} cgroups ${result.cgroupsVersion}\n`);
  stdout.write("OK user lingering enabled\n");
  stdout.write(`OK cell image ${paths.cellImage} (${result.image.Id}) with Pi ${catalog.pi.version}\n`);
  return 0;
}

export async function runCellInvocation(invocation, options = {}) {
  if (invocation.action === "run") {
    return runProfileCell(invocation.profileId, invocation.piArgs, {
      ...options,
      name: invocation.name,
      workspace: invocation.workspace,
      detach: invocation.detach,
    });
  }
  if (invocation.action === "attach") return attachCell(invocation.name, options);
  if (invocation.action === "status") return statusCell(invocation.name, options);
  if (invocation.action === "list") return listCells(options);
  if (invocation.action === "logs") return logsCell(invocation.name, { ...options, follow: invocation.follow });
  if (invocation.action === "stop") return stopCell(invocation.name, options);
  if (invocation.action === "remove") return removeCell(invocation.name, options);
  if (invocation.action === "doctor") return doctorCells(options);
  throw new Error(usage());
}
