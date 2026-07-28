#!/usr/bin/env node

import { parseInvocation, createLaunchPlan, runLaunchPlan } from "../lib/launch.mjs";
import { profileHome, resolveHarnessPaths } from "../lib/paths.mjs";
import { runDoctor } from "../scripts/doctor.mjs";

async function main() {
  const invocation = parseInvocation(process.argv[1], process.argv.slice(2));
  const paths = resolveHarnessPaths(process.env);

  if (invocation.args.length === 1 && invocation.args[0] === "--print-agent-dir") {
    process.stdout.write(`${profileHome(paths, invocation.profileId)}\n`);
    return 0;
  }
  if (invocation.args.length === 1 && invocation.args[0] === "--doctor") {
    return runDoctor({ profileIds: [invocation.profileId] });
  }

  const plan = await createLaunchPlan(invocation.profileId, invocation.args, { paths, env: process.env });
  return runLaunchPlan(plan);
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`pi-harness: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
