import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { extensionPath, packagePath } from "./resources.mjs";
import { profileHome, profileSessionDir } from "./paths.mjs";

const RESOURCE_ARRAY_KEYS = Object.freeze(["packages", "extensions", "skills", "prompts", "themes"]);

async function pathInfo(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function ensureDirectory(path, mode = 0o700) {
  const existing = await pathInfo(path);
  if (existing?.isSymbolicLink()) throw new Error(`Refusing to use symlink as managed directory: ${path}`);
  if (existing && !existing.isDirectory()) throw new Error(`Managed directory path is occupied by a non-directory: ${path}`);
  await mkdir(path, { recursive: true, mode });
  await chmod(path, mode);
}

export async function ensureSafeSymlink(linkPath, targetPath, { targetKind } = {}) {
  const target = resolve(targetPath);
  let targetInfo;
  try {
    targetInfo = await stat(target);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`Cannot link missing shared target: ${target}`);
    throw error;
  }
  if (targetKind === "file" && !targetInfo.isFile()) throw new Error(`Shared target is not a file: ${target}`);
  if (targetKind === "directory" && !targetInfo.isDirectory()) throw new Error(`Shared target is not a directory: ${target}`);

  const existing = await pathInfo(linkPath);
  if (existing) {
    if (!existing.isSymbolicLink()) {
      throw new Error(`Refusing to replace existing non-symlink profile path: ${linkPath}`);
    }
    const rawTarget = await readlink(linkPath);
    const currentTarget = resolve(dirname(linkPath), rawTarget);
    let currentReal;
    let expectedReal;
    try {
      [currentReal, expectedReal] = await Promise.all([realpath(currentTarget), realpath(target)]);
    } catch {
      throw new Error(`Refusing to replace dangling or unreadable profile symlink: ${linkPath}`);
    }
    if (currentReal !== expectedReal) {
      throw new Error(`Refusing to retarget existing profile symlink ${linkPath}: points to ${currentReal}, expected ${expectedReal}.`);
    }
    return { path: linkPath, target, changed: false };
  }

  await mkdir(dirname(linkPath), { recursive: true, mode: 0o700 });
  const portableTarget = relative(dirname(linkPath), target) || ".";
  await symlink(portableTarget, linkPath, targetKind === "directory" ? "dir" : "file");
  return { path: linkPath, target, changed: true };
}

async function readBaseSettings(path) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read shared Pi settings at ${path}: ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Shared Pi settings must contain a JSON object: ${path}`);
  }
  return parsed;
}

export function buildProfileSettings(baseSettings, workload, catalog, paths) {
  const settings = { ...baseSettings };
  for (const key of RESOURCE_ARRAY_KEYS) delete settings[key];
  settings.defaultProjectTrust = "never";
  settings.extensions = workload.child.extensions.map((name) => extensionPath(catalog, name, paths));
  settings.packages = workload.child.packages.map((name) => ({
    source: packagePath(catalog, name, paths),
    extensions: [catalog.resources[name].extension],
    skills: [],
    prompts: [],
    themes: [],
  }));
  settings.skills = [];
  settings.prompts = [];
  settings.themes = [];
  return settings;
}

async function writeJsonSafely(path, value, label) {
  const existing = await pathInfo(path);
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    throw new Error(`Refusing to overwrite non-regular profile ${label} path: ${path}`);
  }
  const content = `${JSON.stringify(value, null, 2)}\n`;
  if (existing && (await readFile(path, "utf8")) === content) {
    await chmod(path, 0o600);
    return false;
  }
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, path);
  await chmod(path, 0o600);
  return true;
}

export async function prepareProfileHome(profileId, workload, catalog, paths) {
  const home = profileHome(paths, profileId);
  const sessions = profileSessionDir(paths, profileId);
  await ensureDirectory(paths.profilesDir);
  await ensureDirectory(home);
  await ensureDirectory(sessions);

  const sharedWriterLeases = join(paths.baseAgentDir, "workbench", "writer-leases");
  await ensureDirectory(sharedWriterLeases);
  await ensureDirectory(join(home, "workbench"));

  const links = [];
  links.push(
    await ensureSafeSymlink(join(home, "auth.json"), join(paths.baseAgentDir, "auth.json"), { targetKind: "file" }),
  );
  links.push(
    await ensureSafeSymlink(join(home, "models-store.json"), join(paths.baseAgentDir, "models-store.json"), {
      targetKind: "file",
    }),
  );
  links.push(
    await ensureSafeSymlink(join(home, "themes"), join(paths.baseAgentDir, "themes"), { targetKind: "directory" }),
  );
  links.push(
    await ensureSafeSymlink(join(home, "workbench", "writer-leases"), sharedWriterLeases, {
      targetKind: "directory",
    }),
  );

  const baseSettingsPath = join(paths.baseAgentDir, "settings.json");
  const baseSettings = await readBaseSettings(baseSettingsPath);
  const settings = buildProfileSettings(baseSettings, workload, catalog, paths);
  const settingsPath = join(home, "settings.json");
  const settingsChanged = await writeJsonSafely(settingsPath, settings, "settings");
  // Profile trust is intentionally non-persistent. Parent launches pass
  // --no-approve and specialist children default to never; clearing this
  // harness-owned store prevents a prior /trust decision from overriding that.
  const trustPath = join(home, "trust.json");
  const trustChanged = await writeJsonSafely(trustPath, {}, "trust store");

  return { profileId, home, sessions, settingsPath, settings, settingsChanged, trustPath, trustChanged, links };
}

export { RESOURCE_ARRAY_KEYS };
