import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { resolveContained } from "./paths.mjs";

export function resourceRoot(resource, paths) {
  if (resource.base !== "agent") throw new Error(`Unsupported resource base '${resource.base}'.`);
  return resolveContained(paths.baseAgentDir, resource.path, "resource path");
}

export function extensionPath(catalog, resourceName, paths) {
  const resource = catalog.resources[resourceName];
  if (!resource) throw new Error(`Unknown extension resource '${resourceName}'.`);
  const root = resourceRoot(resource, paths);
  return resource.kind === "extension" ? root : resolveContained(root, resource.extension, `${resourceName} extension`);
}

export function packagePath(catalog, resourceName, paths) {
  const resource = catalog.resources[resourceName];
  if (!resource || resource.kind !== "package") throw new Error(`Resource '${resourceName}' is not a package.`);
  return resourceRoot(resource, paths);
}

export function skillPath(catalog, skillName, paths) {
  const skill = catalog.skills[skillName];
  if (!skill) throw new Error(`Unknown skill '${skillName}'.`);
  if (skill.base === "repo") return resolveContained(paths.repoRoot, skill.path, `${skillName} skill`);
  if (skill.base === "sharedSkills") return resolveContained(paths.sharedSkillsDir, skill.path, `${skillName} skill`);
  return resolveContained(resourceRoot(catalog.resources[skill.resource], paths), skill.path, `${skillName} skill`);
}

async function requirePath(path, kind, label) {
  await access(path, constants.R_OK);
  const info = await stat(path);
  if (kind === "file" && !info.isFile()) throw new Error(`${label} is not a file: ${path}`);
  if (kind === "directory" && !info.isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
}

export async function verifyCatalogResources(catalog, paths) {
  const checked = [];
  for (const [name, resource] of Object.entries(catalog.resources)) {
    const root = resourceRoot(resource, paths);
    if (resource.kind === "extension") {
      await requirePath(root, "file", `${name} extension`);
      checked.push({ name, path: root, kind: "extension" });
      continue;
    }
    await requirePath(root, "directory", `${name} package`);
    const manifestPath = join(root, "package.json");
    await requirePath(manifestPath, "file", `${name} package manifest`);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (manifest.name !== resource.packageName || manifest.version !== resource.version) {
      throw new Error(
        `${name} pin mismatch at ${manifestPath}: expected ${resource.packageName}@${resource.version}, ` +
          `found ${manifest.name ?? "<missing>"}@${manifest.version ?? "<missing>"}.`,
      );
    }
    const entry = extensionPath(catalog, name, paths);
    await requirePath(entry, "file", `${name} extension entry`);
    checked.push({ name, path: root, kind: "package", version: resource.version });
  }
  for (const name of Object.keys(catalog.skills)) {
    const path = skillPath(catalog, name, paths);
    await requirePath(path, "directory", `${name} skill`);
    await requirePath(join(path, "SKILL.md"), "file", `${name} SKILL.md`);
  }
  return checked;
}
