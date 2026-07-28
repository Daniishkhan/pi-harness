import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import {
  buildCellMounts,
  buildPodmanCreateArgs,
  assertSafeCellMountTarget,
  cellIdentity,
  inspectCellHost,
  parseCellInvocation,
  plannotatorPortForWorkspace,
  resolveCellWorkspace,
  resolveNpmDependencyClosure,
  runProfileCell,
  stopCell,
  waitForContainerReady,
  workspaceDigest,
} from "../lib/cells.mjs";
import { assertCellSandbox, consumeLaunchRequest, publishCellReady } from "../container/entrypoint.mjs";
import { loadWorkload } from "../lib/manifests.mjs";
import { computeHarnessPayloadHash } from "../lib/payload.mjs";
import { harnessFixture } from "./helpers.mjs";

test("cell CLI keeps management flags separate from Pi arguments", () => {
  assert.deepEqual(
    parseCellInvocation([
      "run",
      "eng",
      "--name",
      "backend-fix",
      "--workspace",
      "/srv/backend",
      "--detach",
      "--",
      "--model",
      "provider/model",
      "fix it",
    ]),
    {
      action: "run",
      profileId: "eng",
      name: "backend-fix",
      workspace: "/srv/backend",
      detach: true,
      piArgs: ["--model", "provider/model", "fix it"],
    },
  );
  assert.deepEqual(parseCellInvocation(["logs", "backend-fix", "--follow"]), {
    action: "logs",
    name: "backend-fix",
    follow: true,
  });
  assert.throws(() => parseCellInvocation(["attach", "Bad_Name"]), /Cell names/);
});

test("cell identity follows the canonical workspace and broad mounts are refused", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-cell-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const subdirectory = join(workspace, "packages", "api");
  const link = join(root, "workspace-link");
  const cellsDir = join(root, "cells");
  await mkdir(home);
  await mkdir(subdirectory, { recursive: true });
  await mkdir(join(cellsDir, "bad-workspace"), { recursive: true });
  await symlink(workspace, link);

  const canonical = await resolveCellWorkspace(link, { homeDir: home });
  const expected = await realpath(workspace);
  assert.equal(canonical, expected);
  assert.equal(cellIdentity("eng", canonical), cellIdentity("eng", expected));
  assert.match(cellIdentity("research", expected), /^pi-research-workspace-[a-f0-9]{10}$/);
  const gitRoot = (_command, args, options, callback) => {
    assert.equal("GIT_DIR" in options.env, false);
    if (args.includes("--show-toplevel")) callback(null, `${expected}\n`, "");
    else callback(new Error("unexpected Git probe"), "", "");
  };
  assert.equal(
    await resolveCellWorkspace(subdirectory, {
      homeDir: home,
      execFileImpl: gitRoot,
      env: { ...process.env, GIT_DIR: join(root, "hostile-git-dir") },
    }),
    expected,
  );
  const unrelatedGitRoot = (_command, args, _options, callback) => {
    if (args.includes("--show-toplevel")) callback(null, `${home}\n`, "");
    else callback(new Error("unexpected Git probe"), "", "");
  };
  await assert.rejects(
    resolveCellWorkspace(subdirectory, { homeDir: home, execFileImpl: unrelatedGitRoot }),
    /Git reported a worktree root that does not contain the requested workspace/,
  );
  const missingGit = (_command, _args, _options, callback) => {
    const error = new Error("spawn git ENOENT");
    error.code = "ENOENT";
    callback(error, "", "");
  };
  await assert.rejects(
    resolveCellWorkspace(subdirectory, { homeDir: home, execFileImpl: missingGit }),
    /Unable to determine the canonical Git worktree.*spawn git ENOENT/,
  );
  await assert.rejects(resolveCellWorkspace(home, { homeDir: home }), /home directory or one of its ancestors/);
  await assert.rejects(resolveCellWorkspace("/", { homeDir: home }), /filesystem root/);
  await assert.rejects(
    resolveCellWorkspace(join(cellsDir, "bad-workspace"), { homeDir: home, cellsDir }),
    /overlaps retained Pi cell state/,
  );
});

test("npm resource mounts include a verified transitive dependency closure", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-cell-dependencies-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const npmRoot = join(root, "node_modules");
  const rootPackage = join(npmRoot, "root-package");
  const flatDependency = join(npmRoot, "flat-dependency");
  const peerDependency = join(npmRoot, "peer-dependency");
  const nestedDependency = join(rootPackage, "node_modules", "nested-dependency");
  const writePackage = async (path, manifest) => {
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "package.json"), `${JSON.stringify({ version: "1.0.0", main: "index.js", ...manifest })}\n`);
    await writeFile(join(path, "index.js"), "export default true;\n");
  };
  await writePackage(rootPackage, {
    name: "root-package",
    dependencies: { "flat-dependency": "1.0.0", "nested-dependency": "1.0.0" },
    optionalDependencies: { "missing-optional": "1.0.0" },
    peerDependencies: { "peer-dependency": "1.0.0", "missing-optional-peer": "1.0.0" },
    peerDependenciesMeta: { "missing-optional-peer": { optional: true } },
  });
  await writePackage(flatDependency, { name: "flat-dependency" });
  await writePackage(peerDependency, { name: "peer-dependency" });
  await writePackage(nestedDependency, { name: "nested-dependency" });

  const canonicalNpmRoot = await realpath(npmRoot);
  const closure = await resolveNpmDependencyClosure(rootPackage, npmRoot);
  assert.deepEqual(
    closure.map((path) => relative(canonicalNpmRoot, path)).sort(),
    ["flat-dependency", "peer-dependency", "root-package", join("root-package", "node_modules", "nested-dependency")].sort(),
  );
});

test("cell mounts expose only selected runtime state and preserve workload write boundaries", async (t) => {
  const fixture = await harnessFixture();
  t.after(fixture.cleanup);
  const workspace = join(fixture.root, "workspace");
  await mkdir(workspace);
  const noGit = (_command, _args, _options, callback) => {
    const error = new Error("not a Git repository");
    error.code = 128;
    callback(error, "", "not a Git repository");
  };

  const eng = await loadWorkload(fixture.paths, "eng", fixture.catalog);
  const engMounts = await buildCellMounts(
    {
      cellDir: join(fixture.paths.cellsDir, "eng-cell"),
      workload: eng,
      catalog: fixture.catalog,
      paths: fixture.paths,
      workspace,
    },
    { execFileImpl: noGit },
  );
  const byTarget = new Map(engMounts.map((mount) => [mount.target, mount]));
  assert.equal(byTarget.get(workspace).mode, "rw");
  assert.equal(byTarget.get("/home/pi").mode, "rw");
  assert.equal(byTarget.get("/state/base-agent/auth.json").mode, "rw");
  assert.equal(byTarget.get("/state/base-agent/models-store.json").mode, "rw");
  assert.notEqual(byTarget.get("/state/base-agent/auth.json").source, join(fixture.paths.baseAgentDir, "auth.json"));
  assert.equal((await stat(byTarget.get("/state/base-agent/auth.json").source)).mode & 0o777, 0o600);
  assert.equal(byTarget.get("/state/base-agent/workbench/writer-leases").mode, "rw");
  assert.equal(byTarget.has("/state/base-agent"), false);
  assert.equal(byTarget.get("/state/base-agent/packages/pi-workbench").mode, "ro");
  assert.equal(byTarget.get("/state/base-agent/npm/node_modules/pi-web-access").mode, "ro");

  await mkdir(join(workspace, ".git"));
  const rewrittenStandardGitDir = (_command, args, _options, callback) => {
    if (args.includes("--absolute-git-dir")) callback(null, `${join(workspace, ".git")}\n`, "");
    else if (args.includes("--git-common-dir")) callback(null, `${fixture.paths.baseAgentDir}\n`, "");
    else callback(new Error("unexpected Git probe"), "", "");
  };
  await assert.rejects(
    buildCellMounts(
      {
        cellDir: join(fixture.paths.cellsDir, "protected-common-dir"),
        workload: eng,
        catalog: fixture.catalog,
        paths: fixture.paths,
        workspace,
      },
      { execFileImpl: rewrittenStandardGitDir },
    ),
    /Standard Git worktree has an external or rewritten git directory/,
  );
  await rm(join(workspace, ".git"), { recursive: true });

  const research = await loadWorkload(fixture.paths, "research", fixture.catalog);
  const researchMounts = await buildCellMounts(
    {
      cellDir: join(fixture.paths.cellsDir, "research-cell"),
      workload: research,
      catalog: fixture.catalog,
      paths: fixture.paths,
      workspace,
    },
    { execFileImpl: noGit },
  );
  assert.equal(researchMounts.find((mount) => mount.target === workspace).mode, "ro");
});

test("Git metadata mounts accept only a validated linked-worktree topology", async (t) => {
  const fixture = await harnessFixture();
  t.after(fixture.cleanup);
  const workspace = join(fixture.root, "linked-worktree");
  const commonDir = join(fixture.root, "source-repo", ".git");
  const worktreesRoot = join(commonDir, "worktrees");
  const gitDir = join(worktreesRoot, "linked-worktree");
  await mkdir(workspace);
  await mkdir(gitDir, { recursive: true });
  await writeFile(join(workspace, ".git"), `gitdir: ${gitDir}\n`);
  await writeFile(join(gitDir, "commondir"), "../..\n");
  await writeFile(join(gitDir, "gitdir"), `${join(workspace, ".git")}\n`);

  const linkedGit = (_command, args, options, callback) => {
    assert.equal("GIT_WORK_TREE" in options.env, false);
    if (args.includes("--absolute-git-dir")) callback(null, `${gitDir}\n`, "");
    else if (args.includes("--git-common-dir")) callback(null, `${commonDir}\n`, "");
    else callback(new Error("unexpected Git probe"), "", "");
  };
  const eng = await loadWorkload(fixture.paths, "eng", fixture.catalog);
  const canonicalCommonDir = await realpath(commonDir);
  const mounts = await buildCellMounts(
    {
      cellDir: join(fixture.paths.cellsDir, "linked-cell"),
      workload: eng,
      catalog: fixture.catalog,
      paths: fixture.paths,
      workspace,
    },
    {
      execFileImpl: linkedGit,
      env: { ...process.env, GIT_WORK_TREE: join(fixture.root, "hostile-worktree") },
    },
  );
  assert.deepEqual(
    mounts.find((mount) => mount.target === canonicalCommonDir),
    {
      source: canonicalCommonDir,
      target: canonicalCommonDir,
      mode: "rw",
      label: "Git common directory",
    },
  );

  const otherWorktree = join(fixture.root, "other-worktree");
  await mkdir(otherWorktree);
  await writeFile(join(otherWorktree, ".git"), `gitdir: ${gitDir}\n`);
  await writeFile(join(gitDir, "gitdir"), `${join(otherWorktree, ".git")}\n`);
  await assert.rejects(
    buildCellMounts(
      {
        cellDir: join(fixture.paths.cellsDir, "forged-linked-cell"),
        workload: eng,
        catalog: fixture.catalog,
        paths: fixture.paths,
        workspace,
      },
      { execFileImpl: linkedGit },
    ),
    /Linked-worktree backlink does not resolve to the selected workspace/,
  );
});

test("Podman creation is direct, rootless-hardened, and does not inherit ambient secrets", () => {
  const mounts = [
    { source: "/srv/work", target: "/srv/work", mode: "rw" },
    { source: "/srv/cell/home", target: "/home/pi", mode: "rw" },
  ];
  const args = buildPodmanCreateArgs({
    name: "backend-fix",
    containerName: "pi-cell-backend-fix",
    profileId: "eng",
    workspace: "/srv/work",
    workspaceHash: "a".repeat(64),
    plannotatorPort: 23_456,
    image: "sha256:fixture",
    mounts,
    uid: 1000,
    gid: 1000,
    env: {
      TERM: "xterm-256color",
      OPENAI_API_KEY: "must-not-leak",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      HERDR_ENV: "1",
    },
  });
  assert.equal(args[0], "create");
  for (const required of [
    "--interactive",
    "--tty",
    "--restart=no",
    "--entrypoint=/opt/pi-harness/container/bootstrap.sh",
    "--no-healthcheck",
    "--image-volume=ignore",
    "--stop-signal=SIGTERM",
    "--network=pasta:--map-guest-addr,none",
    "--userns=keep-id",
    "--cap-drop=all",
    "--cap-add=net_admin",
    "--cap-add=setgid",
    "--cap-add=setpcap",
    "--cap-add=setuid",
    "--security-opt=no-new-privileges",
    "--http-proxy=false",
    "--unsetenv-all",
    "--read-only",
  ]) assert.ok(args.includes(required), `missing ${required}`);
  assert.ok(args.includes("--user=0:0"));
  assert.ok(args.includes("--env=PI_HARNESS_CELL_UID=1000"));
  assert.ok(args.includes("--env=PI_HARNESS_CELL_GID=1000"));
  const serialized = args.join("\n");
  assert.doesNotMatch(serialized, /must-not-leak|SSH_AUTH_SOCK|HERDR_ENV|agent\.sock/);
  assert.match(serialized, /--publish=127\.0\.0\.1:23456:23456\/tcp/);
  assert.match(serialized, /--env=PLANNOTATOR_REMOTE=1/);
  assert.doesNotMatch(serialized, /0\.0\.0\.0/);
  assert.equal(args.at(-1), "sha256:fixture");
  assert.equal(plannotatorPortForWorkspace("a".repeat(64)), 21_530);
});

test("cell bootstrap mount targets cannot shadow its trusted runtime", () => {
  for (const target of ["/opt", "/opt/pi-harness/lab", "/usr/local/project", "/state/project", "/run/project"]) {
    assert.throws(() => assertSafeCellMountTarget(target, "fixture workspace"), /overlaps reserved cell runtime path/);
  }
  assert.equal(assertSafeCellMountTarget("/opt/projects/lab"), "/opt/projects/lab");
  assert.equal(assertSafeCellMountTarget("/home/danish/project"), "/home/danish/project");
});

test("cell entrypoint refuses to read requests outside its dropped keep-id sandbox", () => {
  assert.doesNotThrow(() => assertCellSandbox({
    env: { PI_HARNESS_CELL_UID: "1000", PI_HARNESS_CELL_GID: "1001" },
    runtime: {
      getuid: () => 1000,
      getgid: () => 1001,
    },
    readStatus: () =>
      "CapInh:\t0000000000000000\nCapPrm:\t0000000000000000\nCapEff:\t0000000000000000\nCapBnd:\t0000000000000000\nCapAmb:\t0000000000000000\nNoNewPrivs:\t1\n",
  }));
  assert.throws(() => assertCellSandbox({
    env: { PI_HARNESS_CELL_UID: "1000", PI_HARNESS_CELL_GID: "1001" },
    runtime: { getuid: () => 0, getgid: () => 0 },
    readStatus: () => "",
  }), /did not reach its target identity/);
});

test("missing Podman is an execution failure, never an absent-container result", async (t) => {
  const fixture = await harnessFixture();
  t.after(fixture.cleanup);
  const missing = (_command, _args, _options, callback) => {
    const error = new Error("spawn podman ENOENT");
    error.code = "ENOENT";
    callback(error, "", "");
  };
  await assert.rejects(
    inspectCellHost(fixture.paths, fixture.catalog, { platform: "linux", execFileImpl: missing }),
    /spawn podman ENOENT/,
  );
});

test("a live bootstrap PID is not ready until the sandboxed Pi spawn handshake", async (t) => {
  const fixture = await harnessFixture();
  t.after(fixture.cleanup);
  const execFileImpl = (_command, args, _options, callback) => {
    if (args[0] === "container" && args[1] === "exists") {
      callback(null, "", "");
      return;
    }
    if (args[0] === "container" && args[1] === "inspect") {
      callback(null, JSON.stringify([{ State: { Running: true, Status: "running", Pid: 4242 } }]), "");
      return;
    }
    callback(new Error(`unexpected command: ${args.join(" ")}`), "", "");
  };
  await assert.rejects(
    waitForContainerReady(
      fixture.paths,
      "pi-cell-bootstrap-only",
      join(fixture.root, "missing-ready.json"),
      "12345678-1234-4123-8123-123456789abc",
      {
        execFileImpl,
        processIsAlive: () => true,
        startReadyTimeoutMs: 5,
        startReadyPollMs: 1,
      },
    ),
    /readiness handshake timed out/,
  );
});

test("cell image payload hashes change with runtime code but ignore install-only files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-cell-payload-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "runtime.mjs"), "export const version = 1;\n");
  const first = await computeHarnessPayloadHash(root);
  await mkdir(join(root, "node_modules", "ignored"), { recursive: true });
  await writeFile(join(root, "node_modules", "ignored", "index.js"), "ambient install\n");
  await writeFile(join(root, ".gitignore"), "node_modules\n");
  await writeFile(join(root, "package-lock.json"), "{}\n");
  assert.equal(await computeHarnessPayloadHash(root), first);
  await writeFile(join(root, "runtime.mjs"), "export const version = 2;\n");
  assert.notEqual(await computeHarnessPayloadHash(root), first);
});

test("a confirmed pre-create failure clears its prompt and writer lease", async (t) => {
  const fixture = await harnessFixture();
  t.after(fixture.cleanup);
  const workspace = join(fixture.root, "failed-workspace");
  await mkdir(workspace);
  const name = "failed-create";
  const payloadHash = "fixture-payload";
  const execFileImpl = (command, args, _options, callback) => {
    if (command === "git") {
      const error = new Error("not a Git repository");
      error.code = 128;
      callback(error, "", "not a Git repository");
      return;
    }
    if (command === "loginctl") {
      callback(null, "yes\n", "");
      return;
    }
    if (args[0] === "--version") {
      callback(null, "podman version 5.4.2\n", "");
      return;
    }
    if (args[0] === "info") {
      callback(null, "true|systemd|v2\n", "");
      return;
    }
    if (args[0] === "image") {
      callback(
        null,
        JSON.stringify([
          {
            Id: "sha256:fixture",
            Config: {
              Labels: {
                "io.pi-harness.image-schema": "1",
                "io.pi-harness.pi-version": "0.82.1",
                "io.pi-harness.payload-sha256": payloadHash,
              },
            },
          },
        ]),
        "",
      );
      return;
    }
    if (args[0] === "container" && args[1] === "exists") {
      const error = new Error("missing");
      error.code = 1;
      callback(error, "", "");
      return;
    }
    if (args[0] === "create") {
      const error = new Error("create rejected");
      error.code = 125;
      callback(error, "", "invalid mount");
      return;
    }
    callback(new Error(`unexpected command: ${command} ${args.join(" ")}`), "", "");
  };

  await assert.rejects(
    runProfileCell("eng", ["must-not-replay"], {
      paths: fixture.paths,
      workspace,
      name,
      detach: true,
      execFileImpl,
      platform: "linux",
      uid: 1000,
      gid: 1000,
      user: "fixture",
      payloadHash,
      stdout: { write() {} },
    }),
    /invalid mount/,
  );
  await assert.rejects(readFile(join(fixture.paths.cellsDir, name, "launch", "request.json")), { code: "ENOENT" });
  await assert.rejects(
    stat(join(fixture.paths.cellsDir, ".locks", "workspaces", `${workspaceDigest(await realpath(workspace))}.lock`)),
    { code: "ENOENT" },
  );
});

test("launch requests are permission-checked and consumed before Pi can run", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-cell-request-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const request = join(root, "request.json");
  const launchId = "12345678-1234-4123-8123-123456789abc";
  await writeFile(request, JSON.stringify({ schemaVersion: 2, launchId, profileId: "eng", args: ["fix it"] }), {
    mode: 0o600,
  });
  assert.deepEqual(await consumeLaunchRequest(request), { schemaVersion: 2, launchId, profileId: "eng", args: ["fix it"] });
  await assert.rejects(readFile(request), { code: "ENOENT" });

  const broad = join(root, "broad.json");
  await writeFile(broad, JSON.stringify({ schemaVersion: 2, launchId, profileId: "eng", args: [] }), { mode: 0o644 });
  await chmod(broad, 0o644);
  await assert.rejects(consumeLaunchRequest(broad), /permissions are too broad/);

  const ready = join(root, "ready.json");
  await publishCellReady(ready, launchId);
  assert.deepEqual(JSON.parse(await readFile(ready, "utf8")), { schemaVersion: 1, launchId });
  assert.equal((await stat(ready)).mode & 0o777, 0o600);
});

test("graceful cell stop gives Podman more client time than its signal grace", async (t) => {
  const fixture = await harnessFixture();
  t.after(fixture.cleanup);
  const name = "stop-timeout";
  const workspace = join(fixture.root, "stop-workspace");
  await mkdir(workspace);
  const canonicalWorkspace = await realpath(workspace);
  const workspaceHash = workspaceDigest(canonicalWorkspace);
  const containerName = `pi-cell-${name}`;
  const manifest = {
    schemaVersion: 1,
    name,
    profileId: "eng",
    workspace: canonicalWorkspace,
    workspaceHash,
    mutable: true,
    containerName,
  };
  await mkdir(join(fixture.paths.cellsDir, name), { recursive: true });
  await writeFile(join(fixture.paths.cellsDir, name, "manifest.json"), `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  let stopCall;
  const execFileImpl = (_command, args, options, callback) => {
    if (args[0] === "container" && args[1] === "exists") {
      callback(null, "", "");
      return;
    }
    if (args[0] === "container" && args[1] === "inspect") {
      callback(
        null,
        JSON.stringify([
          {
            Config: {
              Labels: {
                "io.pi-harness.managed": "true",
                "io.pi-harness.cell": name,
                "io.pi-harness.profile": "eng",
                "io.pi-harness.workspace-sha256": workspaceHash,
              },
            },
            State: { Running: true, Status: "running", ExitCode: 0, Pid: 4242 },
          },
        ]),
        "",
      );
      return;
    }
    if (args[0] === "stop") {
      stopCall = { args: [...args], timeout: options.timeout };
      callback(null, "", "");
      return;
    }
    callback(new Error(`unexpected command: ${args.join(" ")}`), "", "");
  };

  assert.equal(
    await stopCell(name, {
      paths: fixture.paths,
      execFileImpl,
      processIsAlive: () => true,
      stdout: { write() {} },
    }),
    0,
  );
  assert.deepEqual(stopCall, { args: ["stop", "--time=30", containerName], timeout: 60_000 });
});

test("a stopped cell is never auto-restarted or given a second prompt", async (t) => {
  const fixture = await harnessFixture();
  t.after(fixture.cleanup);
  const workspace = join(fixture.root, "workspace");
  await mkdir(workspace);
  const name = "stopped-contract";
  const canonicalWorkspace = await realpath(workspace);
  const hash = workspaceDigest(canonicalWorkspace);
  const payloadHash = "fixture-payload";
  let exists = false;
  let running = false;
  let starts = 0;
  const calls = [];
  const labels = {
    "io.pi-harness.managed": "true",
    "io.pi-harness.cell": name,
    "io.pi-harness.profile": "eng",
    "io.pi-harness.workspace-sha256": hash,
  };
  const execFileImpl = (command, args, options, callback) => {
    calls.push({ command, args: [...args], shell: options.shell });
    if (command === "git") {
      const error = new Error("not a Git repository");
      error.code = 128;
      callback(error, "", "not a Git repository");
      return;
    }
    if (command === "loginctl") {
      callback(null, "yes\n", "");
      return;
    }
    if (command === fixture.paths.systemdRunBin) {
      starts += 1;
      running = true;
      void (async () => {
        const launchDir = join(fixture.paths.cellsDir, name, "launch");
        const requestPath = join(launchDir, "request.json");
        const request = JSON.parse(await readFile(requestPath, "utf8"));
        await rm(requestPath);
        await publishCellReady(join(launchDir, "ready.json"), request.launchId);
        callback(null, "", "");
      })().catch((error) => callback(error, "", ""));
      return;
    }
    if (args[0] === "--version") {
      callback(null, "podman version 5.4.2\n", "");
      return;
    }
    if (args[0] === "info") {
      callback(null, "true|systemd|v2\n", "");
      return;
    }
    if (args[0] === "image") {
      callback(
        null,
        JSON.stringify([
          {
            Id: "sha256:fixture",
            Config: {
              Labels: {
                "io.pi-harness.image-schema": "1",
                "io.pi-harness.pi-version": "0.82.1",
                "io.pi-harness.payload-sha256": payloadHash,
              },
            },
          },
        ]),
        "",
      );
      return;
    }
    if (args[0] === "container" && args[1] === "exists") {
      if (exists) callback(null, "", "");
      else {
        const error = new Error("missing");
        error.code = 1;
        callback(error, "", "");
      }
      return;
    }
    if (args[0] === "container" && args[1] === "inspect") {
      callback(
        null,
        JSON.stringify([
          {
            Config: { Labels: labels },
            State: { Running: running, Status: running ? "running" : "exited", ExitCode: 0, Pid: running ? process.pid : 0 },
          },
        ]),
        "",
      );
      return;
    }
    if (args[0] === "create") {
      exists = true;
      const error = new Error("Podman materialization exceeded the client timeout");
      error.code = "ETIMEDOUT";
      callback(error, "", "");
      return;
    }
    callback(new Error(`unexpected command: ${command} ${args.join(" ")}`), "", "");
  };
  const output = { write() {} };
  const options = {
    paths: fixture.paths,
    workspace,
    name,
    detach: true,
    execFileImpl,
    platform: "linux",
    uid: 1000,
    gid: 1000,
    user: "fixture",
    stdout: output,
    payloadHash,
  };

  assert.equal(await runProfileCell("eng", ["first prompt"], options), 0);
  assert.equal(starts, 1);
  assert.ok(calls.every((call) => call.shell === false));
  const systemdCall = calls.find((call) => call.command === fixture.paths.systemdRunBin);
  assert.ok(systemdCall.args.includes("--property=Type=exec"));
  assert.equal(systemdCall.args.includes("--wait"), false);
  assert.deepEqual(systemdCall.args.slice(-4), ["start", "--attach", "--sig-proxy=false", `pi-cell-${name}`]);

  running = false;
  await assert.rejects(runProfileCell("eng", [], options), /will not be restarted automatically/);
  await assert.rejects(runProfileCell("eng", ["second prompt"], options), /will not be restarted automatically/);
  assert.equal(starts, 1);
});
