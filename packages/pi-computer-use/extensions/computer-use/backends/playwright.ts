import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

export interface CliResult { output: string; }
export interface SnapshotOptions { depth?: number; ref?: string; query?: string; regex?: string; }
export interface BrowserTab { index: number; current: boolean; title: string; url: string; }

const MAX_OUTPUT_CHARS = 16_000;
const MAX_OUTPUT_LINES = 400;
const MAX_DIAGNOSTIC_CHARS = 500;
const START_COMMANDS = new Set(["open", "attach"]);
const TAB_STATE_CODE = "async page => JSON.stringify(await Promise.all(page.context().pages().map(async (p, index) => ({ index, current: p === page, title: await p.title(), url: p.url() }))))";
const SAFE_ENVIRONMENT_KEYS = new Set([
  "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TERM",
  "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "SystemRoot", "WINDIR",
  "LOCALAPPDATA", "APPDATA", "PROGRAMFILES", "ProgramFiles", "ProgramFiles(x86)",
]);

export function boundText(value: string): string {
  const lines = value.split("\n");
  const limitedLines = lines.slice(0, MAX_OUTPUT_LINES).join("\n");
  const limited = limitedLines.slice(0, MAX_OUTPUT_CHARS);
  return limited === value ? value.trim() : `${limited.trim()}\n[output truncated]`;
}

export function buildPlaywrightArgs(sessionName: string, configPath: string, command: string, args: string[]): string[] {
  const result = [`-s=${sessionName}`];
  if (START_COMMANDS.has(command)) result.push(`--config=${configPath}`);
  result.push("--raw", command, ...args);
  return result;
}

export function formatCliCommandFailure(command: string, code: number | null, output: string): string {
  const base = `Playwright CLI command '${command}' failed (exit ${code ?? "unknown"}).`;
  if (!START_COMMANDS.has(command)) return base;
  const diagnostic = sanitizeBrowserText(output)
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("Error: ") && !line.startsWith("Error: Daemon pid="))
    ?.slice("Error: ".length, "Error: ".length + MAX_DIAGNOSTIC_CHARS);
  return diagnostic ? `${base} ${diagnostic}` : base;
}

export function createChildEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { CI: "1", NO_UPDATE_NOTIFIER: "1" };
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    if (source[key] !== undefined) environment[key] = source[key];
  }
  return environment;
}

export function parseTabStateOutput(output: string): BrowserTab[] {
  let value: unknown;
  try {
    value = JSON.parse(output);
    if (typeof value === "string") value = JSON.parse(value);
  } catch {
    throw new Error("Unable to determine browser tab origins safely.");
  }
  if (!Array.isArray(value) || value.length === 0) throw new Error("Unable to determine browser tab origins safely.");
  const tabs: BrowserTab[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error("Unable to determine browser tab origins safely.");
    const tab = entry as Record<string, unknown>;
    if (!Number.isInteger(tab.index) || typeof tab.current !== "boolean" || typeof tab.title !== "string" || typeof tab.url !== "string") {
      throw new Error("Unable to determine browser tab origins safely.");
    }
    tabs.push({ index: tab.index as number, current: tab.current, title: tab.title, url: tab.url });
  }
  if (tabs.filter((tab) => tab.current).length !== 1) throw new Error("Unable to determine the current browser tab safely.");
  return tabs;
}

export function sanitizeBrowserText(value: string): string {
  const sensitiveName = "[^:\\n]*(?:auth(?:orization)?|token|secret|cookie|credential|session|api[-_]?key|password|passwd)[^:\\n]*";
  const sensitiveParameter = "[^&=\\s)]*(?:token|secret|password|passwd|api[_-]?key|signature|credential|session|oauth|code)[^&=\\s)]*";
  return value
    .replace(/(https?:\/\/)[^/@\s:]+:[^/@\s]+@/gi, "$1[redacted]@")
    .replace(new RegExp(`(\"(?:${sensitiveName})\"\\s*:\\s*)\"[^\"]*\"`, "gi"), "$1\"[redacted]\"")
    .split("\n")
    .map((line) => {
      const match = line.match(/^(\s*[-*]?\s*)([^:]+):(.*)$/);
      return match && new RegExp(`(?:auth|token|secret|cookie|credential|session|api[-_]?key|password|passwd)`, "i").test((match[2] ?? "").trim())
        ? `${match[1]}${match[2]}: [redacted]`
        : line;
    })
    .join("\n")
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, (match) => `${match.split(/\s/, 1)[0]} [redacted]`)
    .replace(new RegExp(`([?&](?:${sensitiveParameter})=)[^&\\s)]+`, "gi"), "$1[redacted]");
}

export const redactSensitiveHeaders = sanitizeBrowserText;

export interface PlaywrightCliRuntime {
  scriptPath: string;
  packageRoot: string;
}

export function resolvePlaywrightCliRuntime(): PlaywrightCliRuntime {
  const here = dirname(fileURLToPath(import.meta.url));
  const require = createRequire(import.meta.url);
  const packageJsonPath = require.resolve("@playwright/cli/package.json");
  return {
    scriptPath: join(dirname(packageJsonPath), "playwright-cli.js"),
    packageRoot: resolve(here, "../../.."),
  };
}

export class PlaywrightCliBackend {
  readonly sessionName: string;
  private readonly cliRuntime: PlaywrightCliRuntime;
  private tempDir?: string;
  private configPath?: string;

  constructor(sessionName = `pi-computer-${randomUUID()}`) {
    this.sessionName = sessionName;
    this.cliRuntime = resolvePlaywrightCliRuntime();
  }

  async connectDev(profilePath: string, signal?: AbortSignal): Promise<CliResult> {
    await mkdir(profilePath, { recursive: true, mode: 0o700 });
    await this.ensureConfig();
    return this.run("open", ["about:blank", "--persistent", `--profile=${profilePath}`, "--headed", "--browser=chrome"], signal);
  }

  async attachCurrent(signal?: AbortSignal): Promise<CliResult> {
    await this.ensureConfig();
    return this.run("attach", ["--cdp=chrome"], signal);
  }

  async detach(signal?: AbortSignal): Promise<CliResult> { return this.run("detach", [], signal); }
  async close(signal?: AbortSignal): Promise<CliResult> { return this.run("close", [], signal); }
  async tabState(signal?: AbortSignal): Promise<BrowserTab[]> {
    const result = await this.run("run-code", [TAB_STATE_CODE], signal);
    return parseTabStateOutput(result.output);
  }
  async console(minLevel: string | undefined, signal?: AbortSignal): Promise<CliResult> {
    const result = await this.run("console", minLevel ? [minLevel] : [], signal);
    return { output: sanitizeBrowserText(result.output) };
  }
  async network(index: number | undefined, signal?: AbortSignal): Promise<CliResult> {
    if (index === undefined) {
      const result = await this.run("requests", [], signal);
      return { output: sanitizeBrowserText(result.output) };
    }
    const request = await this.run("request-headers", [String(index)], signal);
    let responseText = "Response headers unavailable.";
    try { responseText = (await this.run("response-headers", [String(index)], signal)).output; } catch { /* an unfinished request may not have response headers */ }
    return { output: boundText(sanitizeBrowserText(`Request headers:\n${request.output}\n\nResponse headers:\n${responseText}`)) };
  }
  async trace(mode: "start" | "stop", signal?: AbortSignal): Promise<CliResult> { return this.run(mode === "start" ? "tracing-start" : "tracing-stop", [], signal); }
  async snapshot(options: SnapshotOptions, signal?: AbortSignal): Promise<CliResult> {
    if (options.query) return this.run("find", [options.query], signal);
    if (options.regex) return this.run("find", ["--regex", options.regex], signal);
    const args: string[] = [];
    if (options.depth !== undefined) args.push(`--depth=${options.depth}`);
    if (options.ref) args.push(options.ref);
    return this.run("snapshot", args, signal);
  }
  async action(command: string, args: string[], signal?: AbortSignal): Promise<CliResult> { return this.run(command, args, signal); }
  async screenshot(path: string, ref: string | undefined, signal?: AbortSignal): Promise<CliResult> {
    return this.run("screenshot", [...(ref ? [ref] : []), `--filename=${path}`], signal);
  }

  async dispose(): Promise<void> {
    if (this.tempDir) await rm(this.tempDir, { recursive: true, force: true });
    this.tempDir = undefined;
    this.configPath = undefined;
  }

  private async ensureConfig(): Promise<void> {
    if (this.configPath) return;
    this.tempDir = await mkdtemp(join(tmpdir(), "pi-computer-use-"));
    const outputDir = join(this.tempDir, "output");
    await mkdir(outputDir, { recursive: true, mode: 0o700 });
    this.configPath = join(this.tempDir, "cli.config.json");
    const config = {
      browser: { initPage: [], initScript: [] },
      outputMode: "stdout",
      outputDir,
      allowUnrestrictedFileAccess: false,
      codegen: "none",
    };
    await writeFile(this.configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });
  }

  private async run(command: string, args: string[], signal?: AbortSignal): Promise<CliResult> {
    await this.ensureConfig();
    const configPath = this.configPath;
    if (!configPath) throw new Error("Playwright CLI configuration was not initialized.");
    const childArgs = buildPlaywrightArgs(this.sessionName, configPath, command, args);
    return new Promise<CliResult>((resolve, reject) => {
      let output = "";
      let settled = false;
      const child = spawn(process.execPath, [this.cliRuntime.scriptPath, ...childArgs], {
        cwd: this.cliRuntime.packageRoot,
        env: createChildEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        if (error) reject(error); else resolve({ output: boundText(output) });
      };
      const append = (chunk: Buffer) => { if (output.length < MAX_OUTPUT_CHARS * 2) output += chunk.toString("utf8"); };
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      child.once("error", () => finish(new Error("Unable to start the package-local Playwright CLI. Run package installation first.")));
      child.once("close", (code) => finish(code === 0 ? undefined : new Error(formatCliCommandFailure(command, code, output))));
      const stop = () => { child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 1_000).unref(); };
      const onAbort = () => { stop(); finish(new Error("Browser command cancelled.")); };
      const timeout = setTimeout(() => { stop(); finish(new Error("Browser command timed out.")); }, 60_000);
      if (signal?.aborted) onAbort(); else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
