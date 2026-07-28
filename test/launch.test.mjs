import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildPiArgs,
  buildProfileEnvironment,
  parseInvocation,
  scopeSessionPassthroughArgs,
  validatePassthroughArgs,
} from "../lib/launch.mjs";
import { loadCatalog, loadWorkload } from "../lib/manifests.mjs";
import { profileHome, profileSessionDir, resolveHarnessPaths } from "../lib/paths.mjs";

test("path roots are environment-overridable and sessions are unique", () => {
  const paths = resolveHarnessPaths({
    PI_HARNESS_HOME_DIR: "/tmp/harness-home",
    PI_HARNESS_BASE_AGENT_DIR: "/tmp/base-agent",
    PI_HARNESS_PROFILES_DIR: "/tmp/profiles",
    PI_HARNESS_SHARED_SKILLS_DIR: "/tmp/shared-skills",
    PI_HARNESS_BIN_DIR: "/tmp/bin",
    PI_HARNESS_PI_BIN: "/tmp/pi-bin",
    PI_HARNESS_HERDR_BIN: "/tmp/herdr-bin",
  });
  assert.equal(paths.baseAgentDir, "/tmp/base-agent");
  assert.equal(paths.sharedSkillsDir, "/tmp/shared-skills");
  assert.equal(paths.piBin, "/tmp/pi-bin");
  assert.equal(paths.herdrBin, "/tmp/herdr-bin");
  assert.equal(profileHome(paths, "eng"), "/tmp/profiles/eng");
  assert.equal(profileSessionDir(paths, "eng"), "/tmp/profiles/eng/sessions");
  assert.notEqual(profileSessionDir(paths, "eng"), profileSessionDir(paths, "research"));
});

test("launcher selects profiles from argv entry or explicit pi-run argument", () => {
  assert.deepEqual(parseInvocation("/bin/pi-eng", ["--model", "x"]), {
    profileId: "eng",
    args: ["--model", "x"],
  });
  assert.deepEqual(parseInvocation("/bin/pi-run.mjs", ["learn", "hello"]), {
    profileId: "learn",
    args: ["hello"],
  });
  assert.throws(() => parseInvocation("/bin/pi-run", ["unknown"]), /Unknown Pi workload/);
});

test("research argv is exact, explicit, and context-isolated", async () => {
  const paths = resolveHarnessPaths({}, {
    baseAgentDir: "/tmp/base-agent",
    profilesDir: "/tmp/profiles",
    sharedSkillsDir: "/tmp/shared-skills",
  });
  const catalog = await loadCatalog(paths);
  const workload = await loadWorkload(paths, "research", catalog);
  const prepared = { sessions: "/tmp/profiles/research/sessions" };
  assert.deepEqual(buildPiArgs(workload, catalog, paths, prepared, ["--model", "provider/model"]), [
    "--model",
    "provider/model",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-approve",
    "--no-context-files",
    "--system-prompt",
    join(paths.repoRoot, "system-prompts", "research.md"),
    "--session-dir",
    "/tmp/profiles/research/sessions",
    "--tools",
    "read,grep,find,ls,web_search,fetch_content,get_search_content",
    "-e",
    "/tmp/base-agent/extensions/vertex-ai/index.ts",
    "-e",
    "/tmp/base-agent/npm/node_modules/pi-web-access/index.ts",
    "-e",
    "/tmp/base-agent/packages/pi-workbench/extensions/index.ts",
    "-e",
    "/tmp/base-agent/packages/pi-research/extensions/index.ts",
    "--skill",
    "/tmp/base-agent/npm/node_modules/pi-web-access/skills/librarian",
  ]);
});

test("engineering appends its prompt and controlled resource flags cannot be injected", async () => {
  const paths = resolveHarnessPaths({}, { baseAgentDir: "/tmp/base", profilesDir: "/tmp/profiles" });
  const catalog = await loadCatalog(paths);
  const workload = await loadWorkload(paths, "eng", catalog);
  const args = buildPiArgs(workload, catalog, paths, { sessions: "/tmp/profiles/eng/sessions" });
  assert.ok(args.includes("--append-system-prompt"));
  assert.equal(args.includes("--system-prompt"), false);
  assert.throws(() => validatePassthroughArgs(["-e", "/tmp/evil.ts"]), /controls '-e'/);
  assert.throws(() => validatePassthroughArgs(["--tools=read,write"]), /controls '--tools=read,write'/);
  assert.throws(() => validatePassthroughArgs(["--theme", "custom"]), /controls '--theme'/);
  assert.throws(() => validatePassthroughArgs(["-a"]), /controls '-a'/);
  assert.throws(() => validatePassthroughArgs(["-na"]), /controls '-na'/);
});

test("explicit session and fork paths stay inside the selected profile", () => {
  const sessions = "/tmp/profiles/eng/sessions";
  const local = "/tmp/profiles/eng/sessions/--project--/session.jsonl";
  assert.deepEqual(scopeSessionPassthroughArgs(["--session", local], sessions, "/tmp/project"), [
    "--session",
    local,
  ]);
  assert.deepEqual(scopeSessionPassthroughArgs([`--fork=${local}`], sessions, "/tmp/project"), [
    "--fork",
    local,
  ]);
  assert.throws(
    () => scopeSessionPassthroughArgs(["--session", "/tmp/profiles/research/sessions/a.jsonl"], sessions),
    /escapes the selected workload session directory/,
  );
  assert.throws(
    () => scopeSessionPassthroughArgs(["--fork=../research/sessions/a.jsonl"], sessions, "/tmp/profiles/eng"),
    /escapes the selected workload session directory/,
  );
});

test("profile-local session IDs and native resume modes keep Pi semantics", () => {
  const sessions = "/tmp/profiles/learn/sessions";
  assert.deepEqual(
    scopeSessionPassthroughArgs(
      ["--session", "019abc12", "--fork=019abc12-dead", "-r", "--resume", "-c", "--continue", "hello"],
      sessions,
    ),
    ["--session", "019abc12", "--fork", "019abc12-dead", "-r", "--resume", "-c", "--continue", "hello"],
  );
  assert.throws(() => scopeSessionPassthroughArgs(["--session=../../research"], sessions), /escapes/);
  assert.throws(() => scopeSessionPassthroughArgs(["--fork", ""], sessions), /non-empty/);
  assert.throws(() => scopeSessionPassthroughArgs(["--session", ".."], sessions), /ambiguous/);
  assert.throws(() => scopeSessionPassthroughArgs(["--fork"], sessions), /requires/);
});

test("session path containment follows existing symlinks", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "pi-harness-session-boundary-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const sessions = join(fixture, "profiles", "eng", "sessions");
  const outside = join(fixture, "profiles", "research", "sessions");
  await mkdir(sessions, { recursive: true });
  await mkdir(outside, { recursive: true });
  await symlink(outside, join(sessions, "cross-profile"));

  assert.throws(
    () => scopeSessionPassthroughArgs(["--session", join(sessions, "cross-profile", "session.jsonl")], sessions),
    /escapes the selected workload session directory/,
  );
});

test("child environment overrides inherited session roots and gives Herdr a wrapper hint", () => {
  const paths = resolveHarnessPaths({}, { profilesDir: "/tmp/profiles" });
  const prepared = { home: "/tmp/profiles/eng", sessions: "/tmp/profiles/eng/sessions" };
  const env = buildProfileEnvironment("eng", paths, prepared, {
    HERDR_ENV: "1",
    PI_CODING_AGENT_SESSION_DIR: "/tmp/wrong-sessions",
    PI_ENGINEERING_RUNTIME_HOST_ONLY: "1",
  });
  assert.equal(env.PI_CODING_AGENT_DIR, prepared.home);
  assert.equal(env.PI_CODING_AGENT_SESSION_DIR, prepared.sessions);
  assert.equal(env.HERDR_AGENT, "pi");
  assert.equal(env.PI_ENGINEERING_RUNTIME_HOST_ONLY, undefined);
  assert.equal(
    buildProfileEnvironment("research", paths, prepared, { PI_ENGINEERING_RUNTIME_HOST_ONLY: "0" })
      .PI_ENGINEERING_RUNTIME_HOST_ONLY,
    "1",
  );
  assert.equal(
    buildProfileEnvironment("eng", paths, prepared, { HERDR_ENV: "1", HERDR_AGENT: "custom" }).HERDR_AGENT,
    "custom",
  );
});
