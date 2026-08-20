#!/usr/bin/env node

import { lstat, readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ignoredDirectories = new Set([".git", "node_modules", "coverage", "test-results"]);
const privateBasenames = new Set([
  "auth.json",
  "models-store.json",
  "mcp.json",
  "settings.json",
  "run-history.jsonl",
  "vertex-ai.config.json",
]);
const secretPatterns = [
  { label: "GitHub token", pattern: /\b(?:gho|ghp|github_pat)_[A-Za-z0-9_]{20,}\b/ },
  { label: "OpenAI-style key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { label: "Google API key", pattern: /\bAIza[A-Za-z0-9_-]{20,}\b/ },
  { label: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: "absolute macOS home path", pattern: /\/Users\/(?!example(?:\/|\b)|your-name(?:\/|\b))[^/\s]+(?:\/|\b)/i },
];

const failures = [];
const files = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name)) continue;
    const absolute = join(directory, entry.name);
    const path = relative(root, absolute).replaceAll("\\", "/");
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) {
      failures.push(`${path}: symlinks are not allowed in the shared bundle`);
      continue;
    }
    if (stat.isDirectory()) {
      await walk(absolute);
      continue;
    }
    if (stat.isFile()) files.push({ absolute, path });
  }
}

await walk(root);

const ignoreProbe = spawnSync("git", ["check-ignore", "--stdin", "-z"], {
  cwd: root,
  encoding: "utf8",
  input: `${files.map(({ path }) => path).join("\0")}\0`,
});
if (ignoreProbe.error || ![0, 1].includes(ignoreProbe.status ?? -1)) {
  failures.push("unable to determine ignored local files with git check-ignore");
}
const ignoredPaths = new Set((ignoreProbe.stdout ?? "").split("\0").filter(Boolean));
const checkedFiles = files.filter(({ path }) => !ignoredPaths.has(path));

for (const { absolute, path } of checkedFiles) {
  const basename = path.split("/").at(-1);
  if (basename && privateBasenames.has(basename)) {
    failures.push(`${path}: private runtime/configuration file must not be tracked`);
  }

  if (/\.(?:png|jpg|jpeg|gif|webp|ico|zip|gz)$/i.test(path)) continue;
  const content = await readFile(absolute, "utf8");
  for (const { label, pattern } of secretPatterns) {
    if (pattern.test(content)) failures.push(`${path}: contains ${label}`);
  }
}

const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (!packageJson.private) failures.push("package.json: package must remain private");
if (!packageJson.keywords?.includes("pi-package")) failures.push("package.json: missing pi-package keyword");

const resourceGroups = [
  ["extensions", packageJson.pi?.extensions],
  ["skills", packageJson.pi?.skills],
  ["prompts", packageJson.pi?.prompts],
  ["themes", packageJson.pi?.themes],
// Subagent agents are owned by the separate private pipeline repository; this
// package ships none, so the manifest key is intentionally absent.
];
for (const [label, paths] of resourceGroups) {
  if (!Array.isArray(paths) || paths.length === 0) {
    failures.push(`package.json: missing pi.${label} resources`);
    continue;
  }
  for (const resourcePath of paths) {
    const absolute = resolve(root, resourcePath);
    try {
      await lstat(absolute);
    } catch {
      failures.push(`package.json: ${label} path does not exist: ${resourcePath}`);
    }
  }
}

for (const { absolute, path } of checkedFiles.filter(({ path }) => path.endsWith("/SKILL.md") || path.startsWith("agents/") && path.endsWith(".md"))) {
  const content = await readFile(absolute, "utf8");
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---(?:\n|$)/)?.[1];
  if (!frontmatter) {
    failures.push(`${path}: missing YAML frontmatter`);
    continue;
  }
  if (!/^name:\s*\S+/m.test(frontmatter)) failures.push(`${path}: missing name`);
  if (!/^description:\s*\S+/m.test(frontmatter)) failures.push(`${path}: missing description`);
}

const jsonPaths = [
  "package.json",
  "settings.example.json",
  "mcp.example.json",
  "config/powerline-footer/theme.json",
  ...checkedFiles
    .map(({ path }) => path)
    .filter((path) => path.startsWith("themes/") && path.endsWith(".json")),
];
for (const jsonPath of new Set(jsonPaths)) {
  try {
    JSON.parse(await readFile(join(root, jsonPath), "utf8"));
  } catch (error) {
    failures.push(`${jsonPath}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
}

if (failures.length > 0) {
  console.error("Pi harness checks failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Pi harness checks passed (${checkedFiles.length} shareable files scanned).`);
}
