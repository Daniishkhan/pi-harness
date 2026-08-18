import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { addAllowedOrigin, getDevProfilePath, readConfig, writeConfig } from "../extensions/computer-use/config.js";
import {
  boundText,
  buildPlaywrightArgs,
  createChildEnvironment,
  formatCliCommandFailure,
  parseTabStateOutput,
  redactSensitiveHeaders,
  resolvePlaywrightCliRuntime,
  sanitizeBrowserText,
} from "../extensions/computer-use/backends/playwright.js";
import { evaluatePolicy, isLocalOrigin, referencedSnapshotLine } from "../extensions/computer-use/policy.js";
import { needsOriginConfig, parseComputerCommand, validateRequest } from "../extensions/computer-use/index.js";
import { actionArgs, ComputerSessionManager, type BrowserBackend } from "../extensions/computer-use/session-manager.js";
import type { BrowserTab } from "../extensions/computer-use/backends/playwright.js";

class FakeBackend implements BrowserBackend {
  calls: string[] = [];
  tabsValue: BrowserTab[] = [{ index: 0, current: true, title: "App", url: "http://localhost:3000" }];
  snapshotOutput = 'Page URL: http://localhost:3000\n- button "Save" [ref=e1]';
  screenshotBytes = Buffer.from("png");
  failTabs = false;
  failConnect = false;
  failClose = false;
  screenshotPath?: string;
  actionDelay?: Promise<void>;

  async connectDev(): Promise<{ output: string }> { this.calls.push("connectDev"); if (this.failConnect) throw new Error("connect failed after launch"); return { output: "" }; }
  async attachCurrent(): Promise<{ output: string }> { this.calls.push("attachCurrent"); return { output: "" }; }
  async detach(): Promise<{ output: string }> { this.calls.push("detach"); return { output: "" }; }
  async close(): Promise<{ output: string }> { this.calls.push("close"); if (this.failClose) throw new Error("close failed"); return { output: "" }; }
  async tabState(): Promise<BrowserTab[]> { this.calls.push("tabState"); if (this.failTabs) throw new Error("tabs failed"); return this.tabsValue; }
  async console(): Promise<{ output: string }> { return { output: "" }; }
  async network(): Promise<{ output: string }> { return { output: "" }; }
  async trace(): Promise<{ output: string }> { this.calls.push("trace"); return { output: "" }; }
  async snapshot(): Promise<{ output: string }> { this.calls.push("snapshot"); return { output: this.snapshotOutput }; }
  async action(command: string): Promise<{ output: string }> { this.calls.push(command); await this.actionDelay; return { output: this.snapshotOutput }; }
  async screenshot(path: string): Promise<{ output: string }> { this.calls.push("screenshot"); this.screenshotPath = path; await writeFile(path, this.screenshotBytes); return { output: "" }; }
  async dispose(): Promise<void> { this.calls.push("dispose"); }
}

const approve = async () => true;

test("configuration accepts exact origins and writes strict data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-computer-use-test-"));
  const path = join(directory, "computer-use.json");
  await writeConfig({ allowedOrigins: ["https://example.test"] }, path);
  assert.deepEqual(await readConfig(path), { allowedOrigins: ["https://example.test"] });
  await addAllowedOrigin("http://app.localhost", path);
  assert.match(await readFile(path, "utf8"), /app\.localhost/);
  await assert.rejects(() => addAllowedOrigin("https://example.test/path", path), /exact/);
  await writeFile(path, '{"unknown":true}');
  await assert.rejects(() => readConfig(path), /unsupported fields/);
});

test("dev browser profiles are isolated and path-safe per Pi session", () => {
  const agentDir = join(tmpdir(), "agent");
  const profileRoot = join(agentDir, "state", "pi-computer-use", "dev-profiles");
  const first = getDevProfilePath(agentDir, "session-a");
  const second = getDevProfilePath(agentDir, "session-b");
  const unsafe = getDevProfilePath(agentDir, "../../outside");
  assert.equal(first, join(profileRoot, "session-a"));
  assert.notEqual(first, second);
  assert.equal(dirname(unsafe), profileRoot);
  assert.match(unsafe, /session-[a-f0-9]{24}$/);
  assert.equal(getDevProfilePath(agentDir, "a".repeat(128)), join(profileRoot, "a".repeat(128)));
  assert.match(getDevProfilePath(agentDir, "a".repeat(129)), /session-[a-f0-9]{24}$/);
});

test("policy recognizes local pages and fails closed for unknown or external pages", () => {
  assert.equal(isLocalOrigin("http://app.localhost:3000"), true);
  assert.equal(isLocalOrigin("https://example.test"), false);
  const unknown = evaluatePolicy({ action: "inspect", target: "dev", pageUrls: [""], allowedOrigins: [] });
  assert.equal(unknown.requiresApproval, true);
  const external = evaluatePolicy({ action: "inspect", target: "current", pageUrls: ["https://example.test"], allowedOrigins: [] });
  assert.equal(external.requiresApproval, true);
  const configured = evaluatePolicy({ action: "inspect", target: "dev", pageUrls: ["https://example.test/path"], allowedOrigins: ["https://example.test"] });
  assert.equal(configured.requiresApproval, false);
});

test("policy gates mutations, Enter chords, dialogs, traces, and uploads", () => {
  const click = evaluatePolicy({ action: "act", target: "dev", operation: "click", pageUrls: ["http://localhost:3000"], allowedOrigins: [] });
  assert.equal(click.requiresApproval, true);
  const enter = evaluatePolicy({ action: "act", target: "dev", operation: "press", text: "Control+Enter", pageUrls: ["http://localhost:3000"], allowedOrigins: [] });
  assert.equal(enter.inferredRisk, "submit");
  const dismiss = evaluatePolicy({ action: "act", target: "dev", operation: "dialog-dismiss", pageUrls: ["http://localhost:3000"], allowedOrigins: [] });
  assert.equal(dismiss.requiresApproval, true);
  const trace = evaluatePolicy({ action: "trace", target: "dev", pageUrls: ["http://localhost:3000"], allowedOrigins: [] });
  assert.equal(trace.requiresApproval, true);
  const upload = evaluatePolicy({ action: "act", target: "dev", operation: "click", risk: "upload", pageUrls: ["http://localhost:3000"], allowedOrigins: [] });
  assert.match(upload.denyReason ?? "", /refused/);
});

test("snapshot refs match Playwright bracket syntax", () => {
  assert.equal(referencedSnapshotLine('- button "Delete" [ref=e12]', "e12"), '- button "Delete" [ref=e12]');
});

test("command, action, and CLI arguments match the pinned CLI", () => {
  assert.deepEqual(parseComputerCommand("connect current"), { command: "connect", target: "current" });
  assert.deepEqual(parseComputerCommand("settings"), { command: "settings-show" });
  assert.deepEqual(parseComputerCommand("settings allow https://example.test"), { command: "settings-allow", origin: "https://example.test" });
  assert.throws(() => parseComputerCommand("connect"), /Usage/);
  assert.equal(needsOriginConfig("disconnect"), false);
  assert.equal(needsOriginConfig("inspect"), true);
  assert.deepEqual(actionArgs({ action: "act", operation: "scroll", dx: 0, dy: 600 }), ["0", "600"]);
  assert.deepEqual(actionArgs({ action: "act", operation: "tab-select", index: 0 }), ["0"]);
  assert.throws(() => validateRequest({ action: "network", index: 0 }), /one-based/);
  validateRequest({ action: "network", index: 1 });
  assert.deepEqual(buildPlaywrightArgs("pi-session", "/tmp/config.json", "open", ["about:blank"]), ["-s=pi-session", "--config=/tmp/config.json", "--raw", "open", "about:blank"]);
  assert.deepEqual(buildPlaywrightArgs("pi-session", "/tmp/config.json", "click", ["e1"]), ["-s=pi-session", "--raw", "click", "e1"]);
});

test("Playwright CLI runtime resolves a hoisted or nested installation", async () => {
  const runtime = resolvePlaywrightCliRuntime();
  await access(runtime.scriptPath);
  assert.match(runtime.scriptPath, /@playwright[\\/]cli[\\/]playwright-cli\.js$/);
});

test("tab metadata parser accepts strict machine output and rejects ambiguity", () => {
  const payload = JSON.stringify(JSON.stringify([
    { index: 0, current: false, title: "Other ](spoof)", url: "https://example.test/path](http://localhost:3000/" },
    { index: 1, current: true, title: "App", url: "http://localhost:3000/path" },
  ]));
  assert.deepEqual(parseTabStateOutput(payload), [
    { index: 0, current: false, title: "Other ](spoof)", url: "https://example.test/path](http://localhost:3000/" },
    { index: 1, current: true, title: "App", url: "http://localhost:3000/path" },
  ]);
  assert.throws(() => parseTabStateOutput(JSON.stringify(JSON.stringify([{ index: 0, current: false, title: "App", url: "http://localhost" }]))), /current browser tab/);
  assert.throws(() => parseTabStateOutput("not json"), /origins safely/);
});

test("child environment excludes ambient Playwright and Node injection", () => {
  const environment = createChildEnvironment({ PATH: "/bin", HOME: "/tmp/home", NODE_OPTIONS: "--require=/tmp/evil.js", PLAYWRIGHT_MCP_INIT_SCRIPT: "/tmp/evil.js" });
  assert.equal(environment.PATH, "/bin");
  assert.equal(environment.NODE_OPTIONS, undefined);
  assert.equal(environment.PLAYWRIGHT_MCP_INIT_SCRIPT, undefined);
});

test("start failures preserve one sanitized actionable CLI diagnostic", () => {
  const output = [
    "Error: Daemon pid=123: Daemon process exited with code 1",
    "Error: Browser is already in use for /tmp/dev-profile, use --isolated to run multiple instances",
    "authorization: Bearer secret-value",
  ].join("\n");
  assert.equal(
    formatCliCommandFailure("open", 1, output),
    "Playwright CLI command 'open' failed (exit 1). Browser is already in use for /tmp/dev-profile, use --isolated to run multiple instances",
  );
  assert.equal(formatCliCommandFailure("click", 1, output), "Playwright CLI command 'click' failed (exit 1).");
  assert.equal(formatCliCommandFailure("open", 1, "daemon stopped"), "Playwright CLI command 'open' failed (exit 1).");
  const sensitive = formatCliCommandFailure("attach", 1, "Error: Failed at https://user:pass@example.test/?access_token=secret-value");
  assert.doesNotMatch(sensitive, /user:pass|secret-value/);
  assert.match(sensitive, /\[redacted\]/);
  assert.ok(formatCliCommandFailure("open", 1, `Error: ${"x".repeat(1_000)}`).length < 600);
});

test("browser text redaction removes broad credential headers, URL values, and userinfo", () => {
  const input = [
    "authorization: Bearer abc123",
    "x-auth-token: token-value",
    "client-secret: client-value",
    "url: https://user:pass@app.test/?refresh_token=refresh&id_token=id&X-Amz-Signature=signed",
    '{"set-cookie":"sid=secret"}',
  ].join("\n");
  const redacted = redactSensitiveHeaders(input);
  assert.equal(redacted, sanitizeBrowserText(input));
  assert.doesNotMatch(redacted, /abc123|token-value|client-value|user:pass|refresh&id|signed|sid=secret/);
  assert.match(redacted, /\[redacted\]/);
});

test("text output is bounded", () => {
  assert.match(boundText("x".repeat(20_000)), /output truncated/);
  assert.ok(boundText("x".repeat(20_000)).length < 17_000);
});

test("manager detaches current Chrome and closes dev Chrome", async () => {
  const current = new FakeBackend();
  const currentManager = new ComputerSessionManager(current, "/tmp/dev-profile");
  await currentManager.execute({ action: "connect", target: "current" }, [], approve);
  await currentManager.cleanup();
  assert.deepEqual(current.calls, ["attachCurrent", "tabState", "detach", "dispose"]);

  const dev = new FakeBackend();
  const devManager = new ComputerSessionManager(dev, "/tmp/dev-profile");
  await devManager.execute({ action: "connect", target: "dev" }, [], approve);
  await devManager.cleanup();
  assert.deepEqual(dev.calls, ["connectDev", "tabState", "close", "dispose"]);
});

test("connection verification failure rolls back the started browser", async () => {
  const backend = new FakeBackend();
  backend.failTabs = true;
  const manager = new ComputerSessionManager(backend, "/tmp/dev-profile");
  await assert.rejects(() => manager.execute({ action: "connect", target: "dev" }, [], approve), /tabs failed/);
  assert.deepEqual(backend.calls, ["connectDev", "tabState", "close", "close", "close", "dispose"]);
  assert.equal(manager.status().connected, false);
});

test("a start call that rejects still receives repeated rollback", async () => {
  const backend = new FakeBackend();
  backend.failConnect = true;
  const manager = new ComputerSessionManager(backend, "/tmp/dev-profile");
  await assert.rejects(() => manager.execute({ action: "connect", target: "dev" }, [], approve), /connect failed after launch/);
  assert.deepEqual(backend.calls, ["connectDev", "close", "close", "close", "dispose"]);
  assert.equal(manager.status().connected, false);
});

test("status health probe marks a disappeared daemon unhealthy", async () => {
  const backend = new FakeBackend();
  const manager = new ComputerSessionManager(backend, "/tmp/dev-profile");
  await manager.execute({ action: "connect", target: "dev" }, [], approve);
  backend.failTabs = true;
  const status = await manager.execute({ action: "status" }, [], approve);
  assert.match(status.text, /unhealthy/);
  assert.equal(manager.status().healthy, false);
  backend.failTabs = false;
  await manager.execute({ action: "disconnect" }, [], approve);
});

test("failed disconnect remains visible and can be retried", async () => {
  const backend = new FakeBackend();
  const manager = new ComputerSessionManager(backend, "/tmp/dev-profile");
  await manager.execute({ action: "connect", target: "dev" }, [], approve);
  backend.failClose = true;
  await assert.rejects(() => manager.execute({ action: "disconnect" }, [], approve), /close failed/);
  assert.equal(manager.status().connected, true);
  backend.failClose = false;
  await manager.execute({ action: "disconnect" }, [], approve);
  assert.equal(manager.status().connected, false);
});

test("rejected approval prevents a mutating backend call", async () => {
  const backend = new FakeBackend();
  const manager = new ComputerSessionManager(backend, "/tmp/dev-profile");
  await manager.execute({ action: "connect", target: "dev" }, [], approve);
  await assert.rejects(() => manager.execute({ action: "act", operation: "click", ref: "e1", risk: "normal" }, [], async () => false), /not approved/);
  assert.equal(backend.calls.includes("click"), false);
});

test("all returned browser text is sanitized", async () => {
  const backend = new FakeBackend();
  backend.snapshotOutput = 'Page URL: http://localhost:3000/?access_token=secret\n- heading "OK"';
  backend.tabsValue = [{ index: 0, current: true, title: "App", url: "http://localhost:3000/?refresh_token=secret" }];
  const manager = new ComputerSessionManager(backend, "/tmp/dev-profile");
  await manager.execute({ action: "connect", target: "dev" }, [], approve);
  assert.doesNotMatch((await manager.execute({ action: "inspect" }, [], approve)).text, /access_token=secret/);
  assert.doesNotMatch((await manager.execute({ action: "tabs" }, [], approve)).text, /refresh_token=secret/);
  await manager.cleanup();
});

test("screenshot files are deleted and oversized images are refused", async () => {
  const backend = new FakeBackend();
  const manager = new ComputerSessionManager(backend, "/tmp/dev-profile");
  await manager.execute({ action: "connect", target: "dev" }, [], approve);
  const image = await manager.execute({ action: "screenshot" }, [], approve);
  assert.equal(image.image?.data, Buffer.from("png").toString("base64"));
  await assert.rejects(() => access(backend.screenshotPath as string));

  backend.screenshotBytes = Buffer.alloc(3 * 1024 * 1024 + 1);
  await assert.rejects(() => manager.execute({ action: "screenshot" }, [], approve), /safety limit/);
  await assert.rejects(() => access(backend.screenshotPath as string));
  await manager.cleanup();
});

test("manager serializes concurrent browser actions", async () => {
  const backend = new FakeBackend();
  const manager = new ComputerSessionManager(backend, "/tmp/dev-profile");
  await manager.execute({ action: "connect", target: "dev" }, [], approve);
  let release!: () => void;
  backend.actionDelay = new Promise<void>((resolve) => { release = resolve; });
  const first = manager.execute({ action: "act", operation: "hover", ref: "e1" }, [], approve);
  let secondCompleted = false;
  const second = manager.execute({ action: "status" }, [], approve).then((result) => { secondCompleted = true; return result; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(secondCompleted, false);
  release();
  await first;
  assert.match((await second).text, /Connected/);
  await manager.cleanup();
});
