import assert from "node:assert/strict";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { loadWorkload } from "../lib/manifests.mjs";
import { profileHome } from "../lib/paths.mjs";
import { ensureSafeSymlink, prepareProfileHome } from "../lib/profile-home.mjs";
import { harnessFixture } from "./helpers.mjs";

test("generated settings preserve model policy but replace every resource array", async (t) => {
  const fixture = await harnessFixture();
  t.after(fixture.cleanup);
  const baseSettingsPath = join(fixture.paths.baseAgentDir, "settings.json");
  const baseSettings = JSON.parse(await readFile(baseSettingsPath, "utf8"));
  await writeFile(baseSettingsPath, `${JSON.stringify({ ...baseSettings, defaultProjectTrust: "always" }, null, 2)}\n`);
  const eng = await loadWorkload(fixture.paths, "eng", fixture.catalog);
  const prepared = await prepareProfileHome("eng", eng, fixture.catalog, fixture.paths);
  const settings = JSON.parse(await readFile(prepared.settingsPath, "utf8"));
  assert.equal(settings.defaultProvider, "fixture-provider");
  assert.equal(settings.defaultProjectTrust, "never");
  assert.deepEqual(settings.subagents.agentOverrides.fixture, { model: "provider/model" });
  assert.deepEqual(settings.extensions, [join(fixture.paths.baseAgentDir, "extensions/vertex-ai/index.ts")]);
  assert.deepEqual(settings.packages, [
    {
      source: join(fixture.paths.baseAgentDir, "packages/pi-workbench"),
      extensions: ["extensions/index.ts"],
      skills: [],
      prompts: [],
      themes: [],
    },
  ]);
  assert.deepEqual(settings.skills, []);
  assert.deepEqual(settings.prompts, []);
  assert.deepEqual(settings.themes, []);
  assert.equal(settings.packages.includes("unwanted-package"), false);
  assert.equal((await lstat(prepared.settingsPath)).isSymbolicLink(), false);
});

test("profile preparation clears saved project trust decisions", async (t) => {
  const fixture = await harnessFixture();
  t.after(fixture.cleanup);
  const eng = await loadWorkload(fixture.paths, "eng", fixture.catalog);
  const home = profileHome(fixture.paths, "eng");
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "trust.json"), '{"/untrusted/project":true}\n');

  const prepared = await prepareProfileHome("eng", eng, fixture.catalog, fixture.paths);
  assert.deepEqual(JSON.parse(await readFile(prepared.trustPath, "utf8")), {});
  assert.equal((await lstat(prepared.trustPath)).isSymbolicLink(), false);
});

test("research child settings have ordered read-only resources and no mutation tools", async (t) => {
  const fixture = await harnessFixture();
  t.after(fixture.cleanup);
  const research = await loadWorkload(fixture.paths, "research", fixture.catalog);
  const prepared = await prepareProfileHome("research", research, fixture.catalog, fixture.paths);
  assert.equal(research.readOnly, true);
  for (const tool of ["bash", "edit", "write", "assign_engineering"]) assert.equal(research.tools.includes(tool), false);
  assert.deepEqual(prepared.settings.extensions, [join(fixture.paths.baseAgentDir, "extensions/vertex-ai/index.ts")]);
  assert.deepEqual(
    prepared.settings.packages.map(({ source, extensions, skills, prompts, themes }) => ({
      source,
      extensions,
      skills,
      prompts,
      themes,
    })),
    [
      {
        source: join(fixture.paths.baseAgentDir, "npm/node_modules/pi-web-access"),
        extensions: ["index.ts"],
        skills: [],
        prompts: [],
        themes: [],
      },
      {
        source: join(fixture.paths.baseAgentDir, "packages/pi-workbench"),
        extensions: ["extensions/index.ts"],
        skills: [],
        prompts: [],
        themes: [],
      },
      {
        source: join(fixture.paths.baseAgentDir, "packages/pi-research"),
        extensions: ["extensions/index.ts"],
        skills: [],
        prompts: [],
        themes: [],
      },
    ],
  );
});

test("profile homes share auth, model store, themes, and exactly one writer lease directory", async (t) => {
  const fixture = await harnessFixture();
  t.after(fixture.cleanup);
  for (const id of ["eng", "research"]) {
    const workload = await loadWorkload(fixture.paths, id, fixture.catalog);
    await prepareProfileHome(id, workload, fixture.catalog, fixture.paths);
    const home = profileHome(fixture.paths, id);
    assert.equal(await realpath(join(home, "auth.json")), await realpath(join(fixture.paths.baseAgentDir, "auth.json")));
    assert.equal(
      await realpath(join(home, "models-store.json")),
      await realpath(join(fixture.paths.baseAgentDir, "models-store.json")),
    );
    assert.equal(await realpath(join(home, "themes")), await realpath(join(fixture.paths.baseAgentDir, "themes")));
    assert.equal(
      await realpath(join(home, "workbench", "writer-leases")),
      await realpath(join(fixture.paths.baseAgentDir, "workbench", "writer-leases")),
    );
  }
});

test("safe symlink creation refuses occupied or differently targeted paths", async (t) => {
  const fixture = await harnessFixture();
  t.after(fixture.cleanup);
  const target = join(fixture.root, "target");
  const other = join(fixture.root, "other");
  const occupied = join(fixture.root, "occupied");
  await writeFile(target, "target");
  await writeFile(other, "other");
  await writeFile(occupied, "do not replace");
  await assert.rejects(() => ensureSafeSymlink(occupied, target, { targetKind: "file" }), /Refusing to replace/);

  const link = join(fixture.root, "link");
  await ensureSafeSymlink(link, target, { targetKind: "file" });
  await assert.rejects(() => ensureSafeSymlink(link, other, { targetKind: "file" }), /Refusing to retarget/);
});
