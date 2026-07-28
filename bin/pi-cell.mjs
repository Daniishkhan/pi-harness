#!/usr/bin/env node

import { parseCellInvocation, runCellInvocation } from "../lib/cells.mjs";

try {
  const invocation = parseCellInvocation(process.argv.slice(2));
  process.exitCode = await runCellInvocation(invocation);
} catch (error) {
  process.stderr.write(`pi-cell: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
