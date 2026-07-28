import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertProfileId, PROFILE_IDS, resolveContained } from "./paths.mjs";

const CATALOG_KEYS = new Set(["schemaVersion", "pi", "resources", "skills"]);
const PI_KEYS = new Set(["version"]);
const EXTENSION_RESOURCE_KEYS = new Set(["kind", "base", "path", "required"]);
const PACKAGE_RESOURCE_KEYS = new Set([
  "kind",
  "base",
  "path",
  "packageName",
  "version",
  "extension",
  "required",
]);
const SKILL_KEYS = new Set(["base", "resource", "path"]);
const WORKLOAD_KEYS = new Set([
  "schemaVersion",
  "id",
  "name",
  "systemPrompt",
  "promptMode",
  "inheritContextFiles",
  "readOnly",
  "extensions",
  "skills",
  "tools",
  "requiredCommands",
  "forbiddenCommands",
  "child",
]);
const CHILD_KEYS = new Set(["extensions", "packages"]);
const MUTATION_TOOLS = new Set([
  "bash",
  "edit",
  "write",
  "assign_engineering",
  "plannotator_submit_plan",
]);
const PROFILE_BOUNDARIES = Object.freeze({
  eng: { inheritContextFiles: true, readOnly: false },
  design: { inheritContextFiles: true, readOnly: false },
  research: { inheritContextFiles: false, readOnly: true },
  learn: { inheritContextFiles: false, readOnly: false },
});

export class ManifestError extends Error {
  constructor(message) {
    super(message);
    this.name = "ManifestError";
  }
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ManifestError(`${label} must be an object.`);
  }
  return value;
}

function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new ManifestError(`${label} contains unknown key '${key}'.`);
  }
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new ManifestError(`${label} must be a non-empty string.`);
  return value;
}

function boolean(value, label) {
  if (typeof value !== "boolean") throw new ManifestError(`${label} must be a boolean.`);
  return value;
}

function stringList(value, label, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new ManifestError(`${label} must be ${allowEmpty ? "an" : "a non-empty"} array.`);
  }
  const result = value.map((item, index) => nonEmptyString(item, `${label}[${index}]`));
  if (new Set(result).size !== result.length) throw new ManifestError(`${label} must not contain duplicates.`);
  return result;
}

function relativePath(value, label) {
  const result = nonEmptyString(value, label);
  resolveContained("/manifest-root", result, label);
  return result;
}

async function readJson(path, label) {
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new ManifestError(`Unable to read ${label} at ${path}: ${error.message}`);
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new ManifestError(`Invalid JSON in ${label} at ${path}: ${error.message}`);
  }
}

export function validateCatalog(raw) {
  const catalog = object(raw, "catalog");
  exactKeys(catalog, CATALOG_KEYS, "catalog");
  if (catalog.schemaVersion !== 1) throw new ManifestError("catalog.schemaVersion must equal 1.");

  const pi = object(catalog.pi, "catalog.pi");
  exactKeys(pi, PI_KEYS, "catalog.pi");
  nonEmptyString(pi.version, "catalog.pi.version");

  const resources = object(catalog.resources, "catalog.resources");
  if (Object.keys(resources).length === 0) throw new ManifestError("catalog.resources must not be empty.");
  for (const [name, rawResource] of Object.entries(resources)) {
    nonEmptyString(name, "catalog resource name");
    const resource = object(rawResource, `catalog.resources.${name}`);
    if (resource.kind === "extension") {
      exactKeys(resource, EXTENSION_RESOURCE_KEYS, `catalog.resources.${name}`);
      if (resource.base !== "agent") throw new ManifestError(`catalog.resources.${name}.base must equal 'agent'.`);
      relativePath(resource.path, `catalog.resources.${name}.path`);
    } else if (resource.kind === "package") {
      exactKeys(resource, PACKAGE_RESOURCE_KEYS, `catalog.resources.${name}`);
      if (resource.base !== "agent") throw new ManifestError(`catalog.resources.${name}.base must equal 'agent'.`);
      relativePath(resource.path, `catalog.resources.${name}.path`);
      nonEmptyString(resource.packageName, `catalog.resources.${name}.packageName`);
      nonEmptyString(resource.version, `catalog.resources.${name}.version`);
      relativePath(resource.extension, `catalog.resources.${name}.extension`);
    } else {
      throw new ManifestError(`catalog.resources.${name}.kind must be 'extension' or 'package'.`);
    }
    if (resource.required !== undefined && typeof resource.required !== "boolean") {
      throw new ManifestError(`catalog.resources.${name}.required must be a boolean.`);
    }
  }

  const skills = object(catalog.skills, "catalog.skills");
  for (const [name, rawSkill] of Object.entries(skills)) {
    const skill = object(rawSkill, `catalog.skills.${name}`);
    exactKeys(skill, SKILL_KEYS, `catalog.skills.${name}`);
    if (!["repo", "sharedSkills", "resource"].includes(skill.base)) {
      throw new ManifestError(`catalog.skills.${name}.base must be repo, sharedSkills, or resource.`);
    }
    relativePath(skill.path, `catalog.skills.${name}.path`);
    if (skill.base === "resource") {
      const resourceName = nonEmptyString(skill.resource, `catalog.skills.${name}.resource`);
      if (!resources[resourceName]) throw new ManifestError(`catalog.skills.${name} references unknown resource '${resourceName}'.`);
    } else if (skill.resource !== undefined) {
      throw new ManifestError(`catalog.skills.${name}.resource is only valid with base 'resource'.`);
    }
  }

  return catalog;
}

export function validateWorkload(raw, catalog, expectedId) {
  const workload = object(raw, `workload ${expectedId}`);
  exactKeys(workload, WORKLOAD_KEYS, `workload ${expectedId}`);
  if (workload.schemaVersion !== 1) throw new ManifestError(`${expectedId}.schemaVersion must equal 1.`);
  assertProfileId(workload.id);
  if (workload.id !== expectedId) throw new ManifestError(`${expectedId}.id must equal '${expectedId}'.`);
  nonEmptyString(workload.name, `${expectedId}.name`);
  relativePath(workload.systemPrompt, `${expectedId}.systemPrompt`);
  if (!["append", "replace"].includes(workload.promptMode)) {
    throw new ManifestError(`${expectedId}.promptMode must be 'append' or 'replace'.`);
  }
  boolean(workload.inheritContextFiles, `${expectedId}.inheritContextFiles`);
  boolean(workload.readOnly, `${expectedId}.readOnly`);
  const boundary = PROFILE_BOUNDARIES[expectedId];
  if (
    workload.inheritContextFiles !== boundary.inheritContextFiles ||
    workload.readOnly !== boundary.readOnly
  ) {
    throw new ManifestError(
      `${expectedId} boundary must set inheritContextFiles=${boundary.inheritContextFiles} and readOnly=${boundary.readOnly}.`,
    );
  }

  const extensions = stringList(workload.extensions, `${expectedId}.extensions`);
  const skills = stringList(workload.skills, `${expectedId}.skills`, { allowEmpty: true });
  const tools = stringList(workload.tools, `${expectedId}.tools`);
  stringList(workload.requiredCommands, `${expectedId}.requiredCommands`, { allowEmpty: true });
  stringList(workload.forbiddenCommands, `${expectedId}.forbiddenCommands`, { allowEmpty: true });
  if (extensions[0] !== "vertex") {
    throw new ManifestError(`${expectedId}.extensions must start with vertex.`);
  }
  for (const name of extensions) {
    if (!catalog.resources[name]) throw new ManifestError(`${expectedId}.extensions references unknown resource '${name}'.`);
  }
  for (const name of skills) {
    if (!catalog.skills[name]) throw new ManifestError(`${expectedId}.skills references unknown skill '${name}'.`);
  }
  if (workload.readOnly) {
    const mutationTool = tools.find((tool) => MUTATION_TOOLS.has(tool));
    if (mutationTool) throw new ManifestError(`${expectedId} is read-only but enables mutation tool '${mutationTool}'.`);
  }

  const child = object(workload.child, `${expectedId}.child`);
  exactKeys(child, CHILD_KEYS, `${expectedId}.child`);
  const childExtensions = stringList(child.extensions, `${expectedId}.child.extensions`, { allowEmpty: true });
  const childPackages = stringList(child.packages, `${expectedId}.child.packages`, { allowEmpty: true });
  for (const name of childExtensions) {
    if (!catalog.resources[name]) throw new ManifestError(`${expectedId}.child.extensions references unknown resource '${name}'.`);
  }
  for (const name of childPackages) {
    const resource = catalog.resources[name];
    if (!resource || resource.kind !== "package") {
      throw new ManifestError(`${expectedId}.child.packages '${name}' must reference a package resource.`);
    }
  }

  if (expectedId === "eng") {
    if (workload.promptMode !== "append") throw new ManifestError("eng.promptMode must be 'append'.");
    if (JSON.stringify(childExtensions) !== '["vertex"]' || JSON.stringify(childPackages) !== '["engineering"]') {
      throw new ManifestError("eng child resources must be vertex then Pi Engineering.");
    }
  }
  if (expectedId === "research") {
    if (
      JSON.stringify(childExtensions) !== '["vertex"]' ||
      JSON.stringify(childPackages) !== '["web-access","engineering","research"]'
    ) {
      throw new ManifestError("research child resources must be vertex, web-access, Pi Engineering, then Pi Research.");
    }
  }
  if (expectedId !== "eng" && workload.promptMode !== "replace") {
    throw new ManifestError(`${expectedId}.promptMode must be 'replace'.`);
  }
  if ((expectedId === "design" || expectedId === "learn") && childPackages.length !== 0) {
    throw new ManifestError(`${expectedId} must not configure child packages.`);
  }
  return workload;
}

export async function loadCatalog(paths) {
  return validateCatalog(await readJson(paths.catalogPath, "catalog"));
}

export async function loadWorkload(paths, profileId, catalog) {
  assertProfileId(profileId);
  const path = join(paths.workloadsDir, `${profileId}.json`);
  return validateWorkload(await readJson(path, `workload ${profileId}`), catalog, profileId);
}

export async function loadHarnessConfiguration(paths) {
  const catalog = await loadCatalog(paths);
  const workloads = new Map();
  for (const profileId of PROFILE_IDS) workloads.set(profileId, await loadWorkload(paths, profileId, catalog));
  return { catalog, workloads };
}
