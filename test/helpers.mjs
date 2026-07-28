import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadCatalog } from "../lib/manifests.mjs";
import { resolveHarnessPaths } from "../lib/paths.mjs";

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function touch(path, content = "export default function noop() {}\n") {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

export async function harnessFixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-harness-test-"));
  const baseAgentDir = join(root, "base-agent");
  const profilesDir = join(root, "profiles");
  const sharedSkillsDir = join(root, "shared-skills");
  const paths = resolveHarnessPaths(
    {},
    {
      baseAgentDir,
      profilesDir,
      sharedSkillsDir,
      launcherBinDir: join(root, "bin"),
      piBin: "/fixture/pi",
    },
  );
  const catalog = await loadCatalog(paths);

  await writeJson(join(baseAgentDir, "settings.json"), {
    theme: "fixture",
    defaultProvider: "fixture-provider",
    packages: ["unwanted-package"],
    extensions: ["unwanted-extension"],
    skills: ["unwanted-skill"],
    prompts: ["unwanted-prompt"],
    themes: ["unwanted-theme"],
    subagents: { agentOverrides: { fixture: { model: "provider/model" } } },
  });
  await touch(join(baseAgentDir, "auth.json"), "{}\n");
  await touch(join(baseAgentDir, "models-store.json"), "{}\n");
  await mkdir(join(baseAgentDir, "themes"), { recursive: true });
  await mkdir(join(baseAgentDir, "workbench", "writer-leases"), { recursive: true });

  for (const resource of Object.values(catalog.resources)) {
    const rootPath = join(baseAgentDir, resource.path);
    if (resource.kind === "extension") {
      await touch(rootPath);
      continue;
    }
    await writeJson(join(rootPath, "package.json"), { name: resource.packageName, version: resource.version });
    await touch(join(rootPath, resource.extension));
  }
  for (const skill of Object.values(catalog.skills)) {
    let skillRoot;
    if (skill.base === "repo") continue;
    if (skill.base === "sharedSkills") skillRoot = join(sharedSkillsDir, skill.path);
    else skillRoot = join(baseAgentDir, catalog.resources[skill.resource].path, skill.path);
    await touch(join(skillRoot, "SKILL.md"), "---\nname: fixture\ndescription: fixture\n---\n");
  }

  return {
    root,
    paths,
    catalog,
    cleanup: () => rm(root, { recursive: true, force: true }),
    readJson: async (path) => JSON.parse(await readFile(path, "utf8")),
  };
}
