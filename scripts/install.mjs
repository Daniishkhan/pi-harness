#!/usr/bin/env node

import { constants } from "node:fs";
import { access, copyFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const noDependencies = args.has("--no-deps");
const forceConfig = args.has("--force-config");
const allowedArgs = new Set(["--dry-run", "--no-deps", "--force-config"]);
for (const arg of args) {
  if (!allowedArgs.has(arg)) {
    console.error(`Unknown option: ${arg}`);
    process.exit(2);
  }
}

const pi = process.env.PI_BIN || "pi";
const agentDir = resolve(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"));
const packages = [
  "npm:pi-web-access@0.23.0",
  "npm:pi-subagents@0.50.0",
  "npm:pi-powerline-footer@0.15.0",
  "npm:pi-lsp@0.1.7",
  "npm:pi-mcp-adapter@2.26.0",
  "npm:@hk_net/pi-usage-bars@0.4.2",
  "npm:pi-notify@1.4.0",
  "npm:@mobrienv/pi-tidy-tools@0.4.1",
];

function run(command, commandArgs) {
  console.log(`+ ${[command, ...commandArgs].join(" ")}`);
  if (dryRun) return;
  const result = spawnSync(command, commandArgs, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!dryRun) {
  const probe = spawnSync(pi, ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    console.error(`Unable to run ${pi}. Install Pi and make it available on PATH first.`);
    process.exit(1);
  }
}

if (!noDependencies) {
  for (const packageSpec of packages) run(pi, ["install", packageSpec]);
}
run(pi, ["install", root]);

const sourceTheme = join(root, "config", "powerline-footer", "theme.json");
const targetTheme = join(agentDir, "extensions", "powerline-footer", "theme.json");
if (dryRun) {
  console.log(`+ copy ${sourceTheme} -> ${targetTheme}${forceConfig ? " (overwrite)" : " (if absent)"}`);
} else {
  await mkdir(dirname(targetTheme), { recursive: true });
  let targetExists = true;
  try {
    await access(targetTheme, constants.F_OK);
  } catch {
    targetExists = false;
  }

  if (!targetExists || forceConfig) {
    await copyFile(sourceTheme, targetTheme);
    console.log(`${targetExists ? "Updated" : "Installed"} ${targetTheme}`);
  } else {
    const [source, target] = await Promise.all([readFile(sourceTheme), readFile(targetTheme)]);
    if (source.equals(target)) {
      console.log(`Kept matching ${targetTheme}`);
    } else {
      console.log(`Skipped existing ${targetTheme}; rerun with --force-config to replace it.`);
    }
  }
}

console.log("\nSetup registered. Restart Pi or run /reload in an existing session.");
console.log("Review settings.example.json and mcp.example.json; they are never applied automatically.");
console.log("Optional: run `herdr integration install pi` from a Herdr installation.");
console.log("Optional Vertex AI: set GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION, then configure ADC.");
