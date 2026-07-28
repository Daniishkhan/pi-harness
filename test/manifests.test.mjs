import assert from "node:assert/strict";
import test from "node:test";
import { loadHarnessConfiguration, validateCatalog, validateWorkload } from "../lib/manifests.mjs";
import { resolveHarnessPaths } from "../lib/paths.mjs";

test("loads the strict catalog and all four workload manifests", async () => {
  const config = await loadHarnessConfiguration(resolveHarnessPaths());
  assert.deepEqual([...config.workloads.keys()], ["eng", "design", "research", "learn"]);
  assert.equal(config.catalog.pi.version, "0.82.1");
  assert.deepEqual(config.workloads.get("research").child.packages, ["web-access", "engineering", "research"]);
  assert.deepEqual(config.workloads.get("eng").child.packages, ["engineering"]);
  assert.deepEqual(config.workloads.get("design").child.packages, []);
  assert.deepEqual(config.workloads.get("learn").child.packages, []);
  assert.deepEqual(config.workloads.get("research").forbiddenCommands, ["engineering", "eng", "workbench", "work"]);
});

test("catalog and workload schemas reject unknown keys", async () => {
  const { catalog, workloads } = await loadHarnessConfiguration(resolveHarnessPaths());
  assert.throws(() => validateCatalog({ ...structuredClone(catalog), surprise: true }), /unknown key 'surprise'/);
  assert.throws(
    () => validateWorkload({ ...structuredClone(workloads.get("eng")), surprise: true }, catalog, "eng"),
    /unknown key 'surprise'/,
  );
});

test("read-only workloads reject mutation tools", async () => {
  const { catalog, workloads } = await loadHarnessConfiguration(resolveHarnessPaths());
  const research = structuredClone(workloads.get("research"));
  research.tools.push("write");
  assert.throws(() => validateWorkload(research, catalog, "research"), /read-only.*mutation tool 'write'/);
});

test("fixed child resource contracts fail closed", async () => {
  const { catalog, workloads } = await loadHarnessConfiguration(resolveHarnessPaths());
  const research = structuredClone(workloads.get("research"));
  research.child.packages = ["engineering", "web-access", "research"];
  assert.throws(() => validateWorkload(research, catalog, "research"), /must be vertex, web-access, Pi Engineering/);

  const design = structuredClone(workloads.get("design"));
  design.child.packages = ["chrome"];
  assert.throws(() => validateWorkload(design, catalog, "design"), /must not configure child packages/);
});

test("profile context and read-only boundaries are fixed invariants", async () => {
  const { catalog, workloads } = await loadHarnessConfiguration(resolveHarnessPaths());
  assert.deepEqual(
    Object.fromEntries(
      [...workloads].map(([id, workload]) => [id, {
        inheritContextFiles: workload.inheritContextFiles,
        readOnly: workload.readOnly,
      }]),
    ),
    {
      eng: { inheritContextFiles: true, readOnly: false },
      design: { inheritContextFiles: true, readOnly: false },
      research: { inheritContextFiles: false, readOnly: true },
      learn: { inheritContextFiles: false, readOnly: false },
    },
  );

  const unsafeLearn = structuredClone(workloads.get("learn"));
  unsafeLearn.inheritContextFiles = true;
  assert.throws(() => validateWorkload(unsafeLearn, catalog, "learn"), /learn boundary/);

  const mutableResearch = structuredClone(workloads.get("research"));
  mutableResearch.readOnly = false;
  assert.throws(() => validateWorkload(mutableResearch, catalog, "research"), /research boundary/);
});
