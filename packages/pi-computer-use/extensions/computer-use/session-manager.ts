import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import type { ActOperation, BrowserTarget, ComputerAction, Risk } from "./policy.js";
import { evaluatePolicy, isAllowedPageUrl, isAmbiguousMutatingOperation, referencedSnapshotLine } from "./policy.js";
import { boundText, PlaywrightCliBackend, sanitizeBrowserText, type BrowserTab } from "./backends/playwright.js";

export interface ComputerRequest {
  action: ComputerAction; target?: BrowserTarget; operation?: ActOperation; url?: string; ref?: string; text?: string;
  value?: string; fromRef?: string; toRef?: string; depth?: number; query?: string; regex?: string; index?: number;
  minLevel?: "error" | "warning" | "info" | "debug"; trace?: "start" | "stop"; width?: number; height?: number;
  dx?: number; dy?: number; risk?: Risk; reason?: string;
}
export interface ApprovalRequest { title: string; message: string; }
export type Approve = (request: ApprovalRequest) => Promise<boolean>;
export interface ComputerResult { text: string; image?: { data: string; mimeType: "image/png" }; }
export interface BrowserBackend {
  connectDev(profilePath: string, signal?: AbortSignal): Promise<{ output: string }>;
  attachCurrent(signal?: AbortSignal): Promise<{ output: string }>;
  detach(signal?: AbortSignal): Promise<{ output: string }>;
  close(signal?: AbortSignal): Promise<{ output: string }>;
  tabState(signal?: AbortSignal): Promise<BrowserTab[]>;
  console(minLevel: string | undefined, signal?: AbortSignal): Promise<{ output: string }>;
  network(index: number | undefined, signal?: AbortSignal): Promise<{ output: string }>;
  trace(mode: "start" | "stop", signal?: AbortSignal): Promise<{ output: string }>;
  snapshot(options: { depth?: number; ref?: string; query?: string; regex?: string }, signal?: AbortSignal): Promise<{ output: string }>;
  action(command: string, args: string[], signal?: AbortSignal): Promise<{ output: string }>;
  screenshot(path: string, ref: string | undefined, signal?: AbortSignal): Promise<{ output: string }>;
  dispose(): Promise<void>;
}

const MAX_SCREENSHOT_BYTES = 3 * 1024 * 1024;

export class ComputerSessionManager {
  private queue: Promise<void> = Promise.resolve();
  private target?: BrowserTarget;
  private currentAuthorized = false;
  private healthy = true;
  private lastSnapshot = "";
  private currentUrl?: string;
  readonly sessionName: string;

  private readonly backend: BrowserBackend;
  private readonly devProfilePath: string;

  constructor(backend: BrowserBackend | undefined, devProfilePath: string, sessionName = `pi-computer-${randomUUID()}`) {
    this.sessionName = sessionName;
    this.backend = backend ?? new PlaywrightCliBackend(sessionName);
    this.devProfilePath = devProfilePath;
  }

  status(): { connected: boolean; healthy: boolean; target?: BrowserTarget; sessionName: string; currentUrl?: string } {
    return { connected: Boolean(this.target), healthy: this.healthy, target: this.target, sessionName: this.sessionName, currentUrl: this.currentUrl };
  }

  execute(request: ComputerRequest, allowedOrigins: string[], approve: Approve, signal?: AbortSignal): Promise<ComputerResult> {
    return this.serial(() => this.executeNow(request, allowedOrigins, approve, signal));
  }

  cleanup(): Promise<void> {
    return this.serial(async () => {
      if (this.target) await this.disconnectNow();
      else await this.backend.dispose();
    });
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async executeNow(request: ComputerRequest, allowedOrigins: string[], approve: Approve, signal?: AbortSignal): Promise<ComputerResult> {
    if (request.action === "status") return this.healthStatus(signal);
    if (request.action === "connect") return this.connectNow(request.target, approve, signal);
    if (request.action === "disconnect") { await this.disconnectNow(signal); return { text: "Browser disconnected." }; }
    this.requireConnection(request.target);

    const tabsBefore = await this.refreshTabState(signal);
    const currentTab = tabsBefore.find((tab) => tab.current);
    const pageUrls = request.action === "tabs" ? tabsBefore.map((tab) => tab.url) : [currentTab?.url ?? ""];

    let policySnapshot = this.lastSnapshot;
    if (request.action === "act" && isAmbiguousMutatingOperation(request.operation) && isAllowedPageUrl(currentTab?.url, allowedOrigins)) {
      const snapshot = await this.backend.snapshot({ depth: 4 }, signal);
      this.rememberSnapshot(snapshot.output);
      policySnapshot = request.ref ? referencedSnapshotLine(snapshot.output, request.ref) ?? "" : snapshot.output;
    }

    const policy = evaluatePolicy({ ...request, target: this.target, url: request.url, pageUrls, snapshotText: policySnapshot, allowedOrigins });
    if (policy.denyReason) throw new Error(policy.denyReason);
    let approved = false;
    if (policy.requiresApproval) {
      await this.requirePolicyApproval(request, policy.reasons, approve);
      approved = true;
    }

    let result: ComputerResult;
    switch (request.action) {
      case "tabs": result = { text: this.formatTabs(tabsBefore) }; break;
      case "inspect": {
        const snapshot = await this.backend.snapshot({ depth: request.depth, ref: request.ref, query: request.query, regex: request.regex }, signal);
        this.rememberSnapshot(snapshot.output);
        result = this.textResult(snapshot);
        break;
      }
      case "console": result = this.textResult(await this.backend.console(request.minLevel, signal)); break;
      case "network": result = this.textResult(await this.backend.network(request.index, signal)); break;
      case "trace": result = this.textResult(await this.backend.trace(request.trace as "start" | "stop", signal), "Trace command completed. Trace artifacts may contain sensitive page, network, and console data."); break;
      case "screenshot": result = await this.takeScreenshot(request.ref, signal); break;
      case "act": result = await this.act(request, signal); break;
      default: throw new Error(`Unsupported computer action: ${request.action}`);
    }

    if (request.action !== "tabs") {
      const tabsAfter = await this.refreshTabState(signal);
      if (!approved) {
        const currentAfter = tabsAfter.find((tab) => tab.current);
        const postPolicy = evaluatePolicy({ action: request.action, target: this.target, pageUrls: [currentAfter?.url ?? ""], allowedOrigins });
        if (postPolicy.requiresApproval) {
          await this.requireApproval(approve, "Approve browser result?", `The page changed while the command was running. Approve returning content from the final page.\n${postPolicy.reasons.join("\n")}`);
        }
      }
    }
    return result;
  }

  private async healthStatus(signal?: AbortSignal): Promise<ComputerResult> {
    if (!this.target) return { text: "Disconnected." };
    try {
      await this.refreshTabState(signal);
      this.healthy = true;
      return { text: `Connected: ${this.target}.` };
    } catch {
      this.healthy = false;
      return { text: `Connection unhealthy: ${this.target}. Run /computer disconnect to clean up before reconnecting.` };
    }
  }

  private async connectNow(target: BrowserTarget | undefined, approve: Approve, signal?: AbortSignal): Promise<ComputerResult> {
    if (!target) throw new Error("connect requires target: current or dev.");
    if (this.target) await this.disconnectNow(signal);
    let attempted = false;
    try {
      if (target === "current") {
        await this.requireApproval(approve, "Connect to current Chrome?", "This attaches to your personal Chrome profile for this Pi session only. It can expose signed-in tabs. Enable Chrome remote debugging at chrome://inspect/#remote-debugging first. The Playwright extension is an alternative, but is not installed or enabled automatically.");
        attempted = true;
        await this.backend.attachCurrent(signal);
        this.currentAuthorized = true;
      } else {
        attempted = true;
        await this.backend.connectDev(this.devProfilePath, signal);
      }
      this.target = target;
      this.healthy = true;
      await this.refreshTabState(signal);
      return { text: `Connected to ${target} browser.` };
    } catch (error) {
      const cleanupError = attempted ? await this.rollbackStart(target) : undefined;
      if (!cleanupError) this.resetState();
      else {
        this.target = target;
        this.currentAuthorized = target === "current";
        this.healthy = false;
      }
      const guidance = target === "current"
        ? " Enable Chrome remote debugging at chrome://inspect/#remote-debugging, or manually install the Playwright bridge extension."
        : " Verify Google Chrome is installed and the dedicated dev profile is not locked by another process.";
      const cleanupMessage = cleanupError ? ` Automatic rollback also failed (${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}); run /computer disconnect again before continuing.` : "";
      throw new Error(`${error instanceof Error ? error.message : String(error)}${guidance}${cleanupMessage}`);
    }
  }

  private async rollbackStart(target: BrowserTarget): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (target === "current") await this.backend.detach(); else await this.backend.close();
        lastError = undefined;
      } catch (error) { lastError = error; }
      if (attempt < 2) await delay(250);
    }
    try { await this.backend.dispose(); } catch (error) { lastError ??= error; }
    return lastError;
  }

  private async disconnectNow(signal?: AbortSignal): Promise<void> {
    const target = this.target;
    if (!target) return;
    try {
      if (target === "current") await this.backend.detach(signal); else await this.backend.close(signal);
      await this.backend.dispose();
      this.resetState();
    } catch (error) {
      this.healthy = false;
      throw error;
    }
  }

  private resetState(): void {
    this.target = undefined;
    this.currentAuthorized = false;
    this.healthy = true;
    this.lastSnapshot = "";
    this.currentUrl = undefined;
  }

  private requireConnection(requestedTarget?: BrowserTarget): void {
    if (!this.target) throw new Error("No browser is connected. Use computer connect with target dev or current first.");
    if (this.target === "current" && !this.currentAuthorized) throw new Error("Current Chrome authorization is no longer valid for this Pi session.");
    if (requestedTarget && requestedTarget !== this.target) throw new Error(`Connected browser target is ${this.target}, not ${requestedTarget}.`);
  }
  private async requirePolicyApproval(request: ComputerRequest, reasons: string[], approve: Approve): Promise<void> {
    const operation = request.action === "act" ? `Operation: ${request.operation ?? "unknown"}.` : `Action: ${request.action}.`;
    const destination = request.url ? `Destination: ${sanitizeBrowserText(request.url)}.` : undefined;
    const modelReason = request.reason ? `Model-supplied reason: ${sanitizeBrowserText(request.reason)}` : undefined;
    await this.requireApproval(approve, "Approve browser action?", [operation, destination, ...reasons.map(sanitizeBrowserText), modelReason].filter(Boolean).join("\n"));
  }
  private async requireApproval(approve: Approve, title: string, message: string): Promise<void> {
    if (!await approve({ title, message })) throw new Error("Browser action was not approved. No action was taken.");
  }
  private async refreshTabState(signal?: AbortSignal): Promise<BrowserTab[]> {
    try {
      const tabs = await this.backend.tabState(signal);
      const current = tabs.find((tab) => tab.current);
      if (!current) throw new Error("Unable to determine the current browser tab safely.");
      this.currentUrl = current.url;
      this.healthy = true;
      return tabs;
    } catch (error) {
      this.healthy = false;
      throw error;
    }
  }
  private formatTabs(tabs: BrowserTab[]): string {
    return boundText(sanitizeBrowserText(JSON.stringify(tabs, null, 2)));
  }
  private async act(request: ComputerRequest, signal?: AbortSignal): Promise<ComputerResult> {
    const operation = request.operation;
    if (!operation) throw new Error("act requires an operation.");
    const args = actionArgs(request);
    const command: Record<ActOperation, string> = { goto: "goto", click: "click", dblclick: "dblclick", fill: "fill", type: "type", press: "press", hover: "hover", select: "select", check: "check", uncheck: "uncheck", drag: "drag", scroll: "mousewheel", reload: "reload", back: "go-back", forward: "go-forward", "tab-new": "tab-new", "tab-select": "tab-select", "tab-close": "tab-close", "dialog-accept": "dialog-accept", "dialog-dismiss": "dialog-dismiss", resize: "resize" };
    const result = await this.backend.action(command[operation], args, signal);
    this.rememberSnapshot(result.output);
    if (operation === "fill" || operation === "type" || operation === "dialog-accept") return { text: `Completed ${operation}. Inspect the page to verify the result.` };
    return this.textResult(result, `Completed ${operation}.`);
  }
  private async takeScreenshot(ref: string | undefined, signal?: AbortSignal): Promise<ComputerResult> {
    const directory = await mkdtemp(join(tmpdir(), "pi-computer-screenshot-"));
    const path = join(directory, `${randomUUID()}.png`);
    try {
      await this.backend.screenshot(path, ref, signal);
      const size = (await stat(path)).size;
      if (size > MAX_SCREENSHOT_BYTES) throw new Error(`Screenshot is ${size} bytes, exceeding the ${MAX_SCREENSHOT_BYTES}-byte safety limit. Resize the browser and retry.`);
      return { text: "Screenshot captured for visual inspection.", image: { data: await readFile(path, "base64"), mimeType: "image/png" } };
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  private rememberSnapshot(snapshot: string): void { this.lastSnapshot = sanitizeBrowserText(snapshot).slice(0, 16_000); }
  private textResult(result: { output: string }, prefix?: string): ComputerResult {
    return { text: boundText(sanitizeBrowserText([prefix, result.output].filter(Boolean).join("\n").trim() || "Completed.")) };
  }
}

function required(value: string | number | undefined, description: string): string { if (value === undefined || value === "") throw new Error(`act ${description} is required.`); return String(value); }
export function actionArgs(request: ComputerRequest): string[] {
  switch (request.operation) {
    case "goto": return [required(request.url, "url")]; case "click": case "dblclick": case "hover": case "check": case "uncheck": return [required(request.ref, "ref")];
    case "fill": return [required(request.ref, "ref"), required(request.text, "text")]; case "type": case "press": return [required(request.text, "text")];
    case "select": return [required(request.ref, "ref"), required(request.value, "value")]; case "drag": return [required(request.fromRef, "fromRef"), required(request.toRef, "toRef")];
    case "scroll": return [required(request.dx, "dx"), required(request.dy, "dy")]; case "tab-new": return request.url ? [request.url] : [];
    case "tab-select": case "tab-close": return [required(request.index, "index")]; case "dialog-accept": return request.text ? [request.text] : [];
    case "resize": return [required(request.width, "width"), required(request.height, "height")]; default: return [];
  }
}
