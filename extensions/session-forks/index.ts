import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
	getAgentDir,
	SessionManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Box,
	getCellDimensions,
	Image,
	Key,
	matchesKey,
	sliceByColumn,
	Text,
	truncateToWidth,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import {
	type BtwDiagramCall,
	type BtwDiagramRequest,
	BTW_DIAGRAM_TOOL_NAME,
	parseBtwDiagramRequest,
} from "./diagram-protocol.js";

const EXTENSION_ID = "session-forks";
const ENTRY_TYPE = "session-forks-display";
const STATE_VERSION = 2;
const MAX_CONCURRENT_THREADS = 4;
const RUN_TIMEOUT_MS = 30 * 60 * 1000;
const FORCE_KILL_AFTER_MS = 5_000;
const MAX_STDERR_BYTES = 16 * 1024;
const MAX_JSON_EVENT_BYTES = 4 * 1024 * 1024;
const MAX_LIVE_ANSWER_BYTES = 512 * 1024;
const MAX_ENTRY_BYTES = 50 * 1024;
const MAX_ENTRY_LINES = 2_000;
const MAX_INLINE_SVG_BYTES = 8 * 1024 * 1024;
const MAX_INLINE_PNG_BYTES = 20 * 1024 * 1024;
const DIAGRAM_RENDER_WIDTH = 1_600;
const DIAGRAM_RENDER_HEIGHT = 1_000;
const DIAGRAM_RENDER_GRACE_MS = 5_000;
const DIAGRAM_VIEWPORT_TIMEOUT_MS = 8_000;
const DIAGRAM_VIEWPORT_DEBOUNCE_MS = 60;
const MIN_DIAGRAM_ZOOM = 0.25;
const MAX_DIAGRAM_ZOOM = 8;
const MOUSE_CAPTURE_ENABLE = "\x1b[?1002h\x1b[?1006h";
const MOUSE_CAPTURE_DISABLE = "\x1b[?1002l\x1b[?1006l";
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls", BTW_DIAGRAM_TOOL_NAME];
const READ_ONLY_CLI_FLAGS = "--no-extensions --tools read,grep,find,ls --exclude-tools bash,edit,write";
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const BTW_DIAGRAM_TOOL_PATH = fileURLToPath(new URL("./diagram-tool.ts", import.meta.url));

// Child extensions are disabled by default for isolation. Opt in only when the
// selected model provider itself comes from an extension.
const LOAD_CHILD_EXTENSIONS = process.env.PI_SESSION_FORK_LOAD_EXTENSIONS === "1";
// If extension loading is explicitly enabled, do not register this extension
// recursively in the child process.
const IS_SIDE_THREAD_CHILD = process.env.PI_SESSION_FORK_CHILD === "1";
const IS_NESTED_SUBAGENT = process.env.PI_SUBAGENT_CHILD === "1" || Boolean(
	process.env.PI_SUBAGENT_PARENT_SESSION
	&& process.env.PI_SESSION_ID
	&& process.env.PI_SUBAGENT_PARENT_SESSION !== process.env.PI_SESSION_ID,
);

type ThreadStatus =
	| "queued"
	| "running"
	| "stopping"
	| "completed"
	| "failed"
	| "stopped"
	| "interrupted"
	| "orphaned";

interface QueuedPrompt {
	prompt: string;
	enqueuedAt: number;
}

interface ForkThread {
	id: string;
	sessionFile: string;
	childSessionId?: string;
	markerEntryId?: string;
	parentSessionFile: string;
	cwd: string;
	createdAt: number;
	updatedAt: number;
	status: ThreadStatus;
	model?: string;
	thinkingLevel: string;
	projectTrusted: boolean;
	promptCount: number;
	queue: QueuedPrompt[];
	currentPrompt?: string;
	lastQuestion: string;
	lastAnswerPreview?: string;
	lastError?: string;
	lastExitCode?: number;
	pid?: number;
}

interface ForkRegistry {
	version: typeof STATE_VERSION;
	parentSessionId: string;
	parentSessionFile?: string;
	counter: number;
	lastThreadId?: string;
	threads: ForkThread[];
}

interface DisplayEntryData {
	title: string;
	body: string;
	details?: string;
	timestamp: number;
}

interface RunningPrompt {
	child: ChildProcess;
	threadId: string;
	tempDir: string;
	lockFile: string;
	lockToken: string;
	stdoutBuffer: string;
	stderr: string;
	streamingAnswer?: string;
	finalAnswer?: string;
	assistantError?: string;
	assistantStopReason?: string;
	currentTool?: string;
	diagramCalls: Map<string, BtwDiagramRequest>;
	latestDiagramCall?: BtwDiagramCall;
	stopReason?: "user" | "shutdown" | "timeout";
	spawnError?: string;
	settled: boolean;
	timeoutHandle?: ReturnType<typeof setTimeout>;
	killHandle?: ReturnType<typeof setTimeout>;
	closePromise: Promise<void>;
	resolveClose: () => void;
}

type BtwDiagramRenderStatus = "requested" | "rendering" | "ready" | "error";

interface BtwDiagramViewState {
	key: string;
	request: BtwDiagramRequest;
	status: BtwDiagramRenderStatus;
	title: string;
	updatedAt: number;
	theme?: "light" | "dark";
	svgPath?: string;
	pngPath?: string;
	pngBase64?: string;
	zoom?: number;
	panX?: number;
	panY?: number;
	transforming?: boolean;
	error?: string;
}

interface DiagramRenderJob {
	key: string;
	child: ChildProcess;
	outputPath?: string;
	timeoutHandle?: ReturnType<typeof setTimeout>;
	killHandle?: ReturnType<typeof setTimeout>;
}

interface DiagramRenderReceipt {
	diagram_id: string;
	status: "artifact_only" | "rendered";
	svg_path: string;
	png_path: string;
}

interface DiagramViewportReceipt {
	png_path: string;
	width: number;
	height: number;
}

type BtwDiagramTransform =
	| { type: "pan"; deltaX: number; deltaY: number }
	| { type: "zoom"; factor: number }
	| { type: "fit" };

interface SgrMouseEvent {
	button: number;
	column: number;
	row: number;
	release: boolean;
}

interface OverlayImageTuiInternals {
	compositeLineAt?: (
		baseLine: string,
		overlayLine: string,
		startColumn: number,
		overlayWidth: number,
		totalWidth: number,
	) => string;
	getKittyImageReservedRows?: (lines: string[], index: number, maxIndex?: number) => number;
}

const overlayImageCompatibleTuis = new WeakSet<object>();

interface ForkSnapshot {
	sessionFile: string;
	childSessionId?: string;
	markerEntryId: string;
	removedUnsafeThinking: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function sanitizeTerminalText(value: string): string {
	return value.replace(
		/\x1b\[[0-?]*[ -/]*[@-~]|\x9b[0-?]*[ -/]*[@-~]|\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b[PX^_][\s\S]*?\x1b\\|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g,
		"",
	);
}

function oneLine(value: string, maxLength = 120): string {
	const normalized = sanitizeTerminalText(value).replace(/\s+/g, " ").trim();
	return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function appendTail(current: string, next: string, maxBytes: number): string {
	const combined = current + next;
	if (Buffer.byteLength(combined, "utf8") <= maxBytes) return combined;
	let tail = combined.slice(-maxBytes);
	while (Buffer.byteLength(tail, "utf8") > maxBytes) tail = tail.slice(1);
	return tail;
}

function truncateForEntry(text: string): { text: string; truncated: boolean } {
	const lines = text.split("\n");
	let output = lines.slice(0, MAX_ENTRY_LINES).join("\n");
	let truncated = lines.length > MAX_ENTRY_LINES;
	if (Buffer.byteLength(output, "utf8") > MAX_ENTRY_BYTES) {
		output = output.slice(0, MAX_ENTRY_BYTES);
		while (Buffer.byteLength(output, "utf8") > MAX_ENTRY_BYTES) output = output.slice(0, -1);
		truncated = true;
	}
	if (truncated) output += "\n\n[Display truncated. The complete conversation remains in the side-thread session file.]";
	return { text: output, truncated };
}

function textFromMessage(message: unknown): string {
	if (!isRecord(message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is Record<string, unknown> => isRecord(part) && part.type === "text" && typeof part.text === "string")
		.map((part) => part.text as string)
		.join("\n")
		.trim();
}

function latestAssistantText(sessionFile: string, markerEntryId?: string): string | undefined {
	if (!markerEntryId || !existsSync(sessionFile)) return undefined;
	let afterMarker = false;
	let latest: string | undefined;
	for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as unknown;
			if (!isRecord(entry)) continue;
			if (!afterMarker) {
				if (entry.id === markerEntryId) afterMarker = true;
				continue;
			}
			if (entry.type !== "message" || !isRecord(entry.message) || entry.message.role !== "assistant") continue;
			const text = textFromMessage(entry.message);
			if (text) latest = text;
		} catch {
			// A live child can leave a temporarily incomplete trailing line. Ignore it.
		}
	}
	return latest;
}

interface SideConversationTurn {
	question: string;
	answer?: string;
	state?: "running" | "queued";
	diagram?: BtwDiagramCall;
}

function diagramCallsFromAssistantMessage(message: unknown): BtwDiagramCall[] {
	if (!isRecord(message) || !Array.isArray(message.content)) return [];
	const calls: BtwDiagramCall[] = [];
	for (const part of message.content) {
		if (!isRecord(part) || part.type !== "toolCall" || part.name !== BTW_DIAGRAM_TOOL_NAME || typeof part.id !== "string") continue;
		try {
			calls.push({ key: part.id, request: parseBtwDiagramRequest(part.arguments) });
		} catch {
			// Pi records rejected tool calls too. Only a matching successful tool
			// result below can promote a well-formed request into the modal.
		}
	}
	return calls;
}

function unwrapSideThreadRequest(text: string): string {
	const marker = "\n## Request\n\n";
	const index = text.indexOf(marker);
	let request = index >= 0 ? text.slice(index + marker.length) : text;
	const attachmentEnd = request.lastIndexOf("\n</file>");
	if (attachmentEnd >= 0) request = request.slice(0, attachmentEnd);
	return request.trim();
}

function sideConversationTurns(sessionFile: string, markerEntryId?: string): SideConversationTurn[] {
	if (!markerEntryId || !existsSync(sessionFile)) return [];
	const turns: SideConversationTurn[] = [];
	const pendingDiagrams = new Map<string, { turnIndex: number; call: BtwDiagramCall }>();
	let afterMarker = false;
	for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as unknown;
			if (!isRecord(entry)) continue;
			if (!afterMarker) {
				if (entry.id === markerEntryId) afterMarker = true;
				continue;
			}
			if (entry.type !== "message" || !isRecord(entry.message)) continue;
			const text = textFromMessage(entry.message);
			if (entry.message.role === "user") {
				if (text) turns.push({ question: unwrapSideThreadRequest(text) });
				continue;
			}
			if (entry.message.role === "assistant" && turns.length > 0) {
				const turn = turns[turns.length - 1];
				if (turn && text) turn.answer = turn.answer ? `${turn.answer}\n\n${text}` : text;
				for (const call of diagramCallsFromAssistantMessage(entry.message)) {
					pendingDiagrams.set(call.key, { turnIndex: turns.length - 1, call });
				}
				continue;
			}
			if (
				entry.message.role === "toolResult"
				&& entry.message.toolName === BTW_DIAGRAM_TOOL_NAME
				&& typeof entry.message.toolCallId === "string"
			) {
				const pending = pendingDiagrams.get(entry.message.toolCallId);
				pendingDiagrams.delete(entry.message.toolCallId);
				if (pending && entry.message.isError !== true) {
					const turn = turns[pending.turnIndex];
					if (turn) turn.diagram = pending.call;
				}
			}
		} catch {
			// Ignore a trailing line while the child is still appending to its session.
		}
	}
	return turns;
}

function sessionIdFromFile(sessionFile: string): string | undefined {
	if (!existsSync(sessionFile)) return undefined;
	for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as unknown;
			if (isRecord(entry) && entry.type === "session" && typeof entry.id === "string") return entry.id;
		} catch {
			return undefined;
		}
	}
	return undefined;
}

function markerEntryIdFromFile(sessionFile: string, threadId: string): string | undefined {
	if (!existsSync(sessionFile)) return undefined;
	try {
		for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
			if (!line.trim()) continue;
			const entry = JSON.parse(line) as unknown;
			if (!isRecord(entry) || entry.type !== "session_info" || typeof entry.id !== "string") continue;
			if (typeof entry.name === "string" && entry.name.startsWith(`side thread ${threadId}:`)) return entry.id;
		}
	} catch {
		return undefined;
	}
	return undefined;
}

function safeStateFileName(sessionId: string): string {
	return sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function statePathFor(sessionId: string): string {
	return join(getAgentDir(), "state", EXTENSION_ID, `${safeStateFileName(sessionId)}.json`);
}

function newRegistry(parentSessionId: string, parentSessionFile?: string): ForkRegistry {
	return {
		version: STATE_VERSION,
		parentSessionId,
		...(parentSessionFile ? { parentSessionFile } : {}),
		counter: 0,
		threads: [],
	};
}

function parseThread(value: unknown): ForkThread | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.id !== "string" || typeof value.sessionFile !== "string" || typeof value.cwd !== "string") return undefined;
	if (typeof value.parentSessionFile !== "string" || typeof value.createdAt !== "number" || typeof value.updatedAt !== "number") return undefined;
	if (typeof value.status !== "string" || typeof value.lastQuestion !== "string") return undefined;
	const queue = Array.isArray(value.queue)
		? value.queue
			.filter((item): item is Record<string, unknown> => isRecord(item) && typeof item.prompt === "string" && typeof item.enqueuedAt === "number")
			.map((item) => ({ prompt: item.prompt as string, enqueuedAt: item.enqueuedAt as number }))
		: [];
	return {
		id: value.id,
		sessionFile: value.sessionFile,
		...(typeof value.childSessionId === "string" ? { childSessionId: value.childSessionId } : {}),
		...(typeof value.markerEntryId === "string" ? { markerEntryId: value.markerEntryId } : {}),
		parentSessionFile: value.parentSessionFile,
		cwd: value.cwd,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
		status: value.status as ThreadStatus,
		...(typeof value.model === "string" ? { model: value.model } : {}),
		thinkingLevel: typeof value.thinkingLevel === "string" ? value.thinkingLevel : "off",
		projectTrusted: value.projectTrusted === true,
		promptCount: typeof value.promptCount === "number" ? value.promptCount : 0,
		queue,
		...(typeof value.currentPrompt === "string" ? { currentPrompt: value.currentPrompt } : {}),
		lastQuestion: value.lastQuestion,
		...(typeof value.lastAnswerPreview === "string" ? { lastAnswerPreview: value.lastAnswerPreview } : {}),
		...(typeof value.lastError === "string" ? { lastError: value.lastError } : {}),
		...(typeof value.lastExitCode === "number" ? { lastExitCode: value.lastExitCode } : {}),
		...(typeof value.pid === "number" ? { pid: value.pid } : {}),
	};
}

function loadRegistry(filePath: string, parentSessionId: string, parentSessionFile?: string): ForkRegistry {
	if (!existsSync(filePath)) return newRegistry(parentSessionId, parentSessionFile);
	try {
		const raw = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
		if (!isRecord(raw) || raw.parentSessionId !== parentSessionId) {
			throw new Error("State file identity does not match the active Pi session.");
		}
		if (raw.version !== 1 && raw.version !== STATE_VERSION) {
			throw new Error(`Unsupported side-thread state version: ${String(raw.version)}.`);
		}
		const threads = Array.isArray(raw.threads)
			? raw.threads.map(parseThread).filter((thread): thread is ForkThread => thread !== undefined)
			: [];
		for (const thread of threads) {
			thread.childSessionId ??= sessionIdFromFile(thread.sessionFile);
			thread.markerEntryId ??= markerEntryIdFromFile(thread.sessionFile, thread.id);
			if (!thread.markerEntryId) {
				thread.lastError = "This legacy side thread has no answer-boundary marker; inherited parent answers will not be displayed.";
			}
		}
		return {
			version: STATE_VERSION,
			parentSessionId,
			...(typeof raw.parentSessionFile === "string"
				? { parentSessionFile: raw.parentSessionFile }
				: parentSessionFile
					? { parentSessionFile }
					: {}),
			counter: typeof raw.counter === "number" ? raw.counter : threads.length,
			...(typeof raw.lastThreadId === "string" ? { lastThreadId: raw.lastThreadId } : {}),
			threads,
		};
	} catch (error) {
		throw new Error(`Could not load side-thread state from ${filePath}: ${errorMessage(error)}`, { cause: error });
	}
}

function persistRegistry(filePath: string | undefined, registry: ForkRegistry): void {
	if (!filePath) return;
	const directory = dirname(filePath);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, filePath);
}

function isPidAlive(pid: number | undefined): boolean {
	if (!pid || !Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isPidAlive(pid)) return true;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return !isPidAlive(pid);
}

function looksLikeOurChild(pid: number, sessionFile: string): boolean {
	if (process.platform === "win32") return false;
	const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
	return result.status === 0 && result.stdout.includes(sessionFile) && result.stdout.includes("--session");
}

interface RuntimeLease {
	directory: string;
	token: string;
}

interface ThreadLockMetadata {
	token: string;
	ownerPid: number;
	childPid?: number;
	threadId: string;
	createdAt: number;
}

function runtimeLeaseDirectory(stateFile: string): string {
	return `${stateFile}.runtime-lock`;
}

function acquireRuntimeLease(stateFile: string): RuntimeLease {
	const directory = runtimeLeaseDirectory(stateFile);
	mkdirSync(dirname(directory), { recursive: true, mode: 0o700 });
	for (let attempt = 0; attempt < 8; attempt++) {
		const token = randomUUID();
		let created = false;
		try {
			mkdirSync(directory, { mode: 0o700 });
			created = true;
		} catch (error) {
			const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
			if (code !== "EEXIST") throw error;
		}
		if (created) {
			try {
				writeFileSync(join(directory, "owner.json"), `${JSON.stringify({ token, pid: process.pid, createdAt: Date.now() })}\n`, {
					encoding: "utf8",
					mode: 0o600,
				});
				return { directory, token };
			} catch (error) {
				rmSync(directory, { recursive: true, force: true });
				throw error;
			}
		}

		let ownerPid: number | undefined;
		try {
			const owner = JSON.parse(readFileSync(join(directory, "owner.json"), "utf8")) as unknown;
			if (isRecord(owner) && typeof owner.pid === "number") ownerPid = owner.pid;
		} catch {
			// A competing process may still be writing owner.json. Treat it as live.
			throw new Error("Another Pi runtime is currently acquiring this session's side-thread lease.");
		}
		if (isPidAlive(ownerPid)) {
			throw new Error(`Another Pi runtime (PID ${ownerPid}) already manages side threads for this session.`);
		}

		const quarantine = `${directory}.stale-${process.pid}-${randomUUID()}`;
		try {
			renameSync(directory, quarantine);
			rmSync(quarantine, { recursive: true, force: true });
		} catch (error) {
			const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
			if (code !== "ENOENT") throw error;
		}
	}
	throw new Error("Could not acquire the side-thread runtime lease after concurrent retries.");
}

function releaseRuntimeLease(lease: RuntimeLease | undefined): void {
	if (!lease || !existsSync(lease.directory)) return;
	try {
		const owner = JSON.parse(readFileSync(join(lease.directory, "owner.json"), "utf8")) as unknown;
		if (isRecord(owner) && owner.token === lease.token) rmSync(lease.directory, { recursive: true, force: true });
	} catch {
		// Never delete a lease whose ownership cannot be verified.
	}
}

function threadLockPath(sessionFile: string): string {
	return `${sessionFile}.${EXTENSION_ID}.lock`;
}

function readThreadLock(lockFile: string): ThreadLockMetadata | undefined {
	if (!existsSync(lockFile)) return undefined;
	try {
		const value = JSON.parse(readFileSync(lockFile, "utf8")) as unknown;
		if (!isRecord(value) || typeof value.token !== "string" || typeof value.ownerPid !== "number") return undefined;
		if (typeof value.threadId !== "string" || typeof value.createdAt !== "number") return undefined;
		return {
			token: value.token,
			ownerPid: value.ownerPid,
			...(typeof value.childPid === "number" ? { childPid: value.childPid } : {}),
			threadId: value.threadId,
			createdAt: value.createdAt,
		};
	} catch {
		return undefined;
	}
}

function acquireThreadLock(thread: ForkThread): { lockFile: string; token: string } {
	const lockFile = threadLockPath(thread.sessionFile);
	if (existsSync(lockFile)) {
		const lock = readThreadLock(lockFile);
		const owner = lock ? ` (owner PID ${lock.ownerPid}${lock.childPid ? `, child PID ${lock.childPid}` : ""})` : "";
		throw new Error(`Side-thread session ${thread.id} is locked${owner}. Stop or unlock it before continuing.`);
	}

	const token = randomUUID();
	const fd = openSync(lockFile, "wx", 0o600);
	try {
		writeFileSync(fd, `${JSON.stringify({ token, ownerPid: process.pid, threadId: thread.id, createdAt: Date.now() })}\n`, "utf8");
	} catch (error) {
		closeSync(fd);
		rmSync(lockFile, { force: true });
		throw error;
	}
	closeSync(fd);
	return { lockFile, token };
}

function updateThreadLockChild(lockFile: string, token: string, childPid: number | undefined): void {
	if (!childPid) return;
	const lock = readThreadLock(lockFile);
	if (!lock || lock.token !== token) throw new Error("Side-thread lock ownership changed before child startup completed.");
	const temporary = `${lockFile}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(temporary, `${JSON.stringify({ ...lock, childPid })}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, lockFile);
}

function releaseThreadLock(lockFile: string, token: string): void {
	const lock = readThreadLock(lockFile);
	if (lock?.token === token) rmSync(lockFile, { force: true });
}

function clearStaleThreadLock(thread: ForkThread): boolean {
	const lockFile = threadLockPath(thread.sessionFile);
	if (!existsSync(lockFile)) return true;
	const lock = readThreadLock(lockFile);
	if (!lock || lock.childPid === undefined) return false;
	if (isPidAlive(thread.pid) || isPidAlive(lock.childPid) || isPidAlive(lock.ownerPid)) return false;
	rmSync(lockFile, { force: true });
	return true;
}

function reconcileLoadedThreads(registry: ForkRegistry): void {
	for (const thread of registry.threads) {
		if (thread.status !== "running" && thread.status !== "stopping" && thread.status !== "queued") continue;
		const lock = readThreadLock(threadLockPath(thread.sessionFile));
		const liveChildPid = thread.pid && isPidAlive(thread.pid)
			? thread.pid
			: lock?.childPid && isPidAlive(lock.childPid)
				? lock.childPid
				: undefined;
		if (liveChildPid || (lock && isPidAlive(lock.ownerPid))) {
			thread.status = "orphaned";
			thread.pid = liveChildPid;
			thread.lastError = "Another Pi runtime may still own this side-thread session. Stop it before continuing.";
		} else {
			const lockCleared = clearStaleThreadLock(thread);
			thread.status = thread.queue.length > 0 && lockCleared ? "queued" : "interrupted";
			thread.lastError = lockCleared
				? "The parent Pi runtime ended before this side-thread prompt completed."
				: "A malformed or unverified lock still protects this side-thread session.";
			thread.pid = undefined;
		}
		thread.currentPrompt = undefined;
		thread.updatedAt = Date.now();
	}
}

function atomicRewriteJsonl(filePath: string, entries: unknown[]): void {
	const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	const mode = existsSync(filePath) ? statSync(filePath).mode & 0o777 : 0o600;
	writeFileSync(temporary, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, {
		encoding: "utf8",
		mode,
	});
	renameSync(temporary, filePath);
}

function isUnsafeAnthropicThinking(message: Record<string, unknown>, block: unknown): boolean {
	if (!isRecord(block)) return false;
	if (block.type === "redacted_thinking") return true;
	if (block.type !== "thinking") return false;
	const provider = typeof message.provider === "string" ? message.provider.toLowerCase() : "";
	const api = typeof message.api === "string" ? message.api.toLowerCase() : "";
	const model = typeof message.model === "string" ? message.model.toLowerCase() : "";
	const anthropic = provider === "anthropic" || api === "anthropic-messages" || model.startsWith("anthropic/");
	if (!anthropic) return false;
	const signature = typeof block.thinkingSignature === "string"
		? block.thinkingSignature
		: typeof block.signature === "string"
			? block.signature
			: undefined;
	return block.redacted === true || Boolean(signature);
}

function sanitizeForkedThinking(sessionFile: string): boolean {
	const entries: unknown[] = [];
	let changed = false;
	for (const [index, line] of readFileSync(sessionFile, "utf8").split("\n").entries()) {
		if (!line.trim()) continue;
		let entry: unknown;
		try {
			entry = JSON.parse(line) as unknown;
		} catch (error) {
			throw new Error(`Invalid forked session JSONL on line ${index + 1}: ${errorMessage(error)}`);
		}
		if (isRecord(entry) && entry.type === "message" && isRecord(entry.message) && entry.message.role === "assistant") {
			const content = entry.message.content;
			if (Array.isArray(content)) {
				const filtered = content.filter((block) => !isUnsafeAnthropicThinking(entry.message as Record<string, unknown>, block));
				if (filtered.length !== content.length) {
					entry.message.content = filtered;
					changed = true;
				}
			}
		}
		entries.push(entry);
	}
	if (changed) atomicRewriteJsonl(sessionFile, entries);
	return changed;
}

function createForkSnapshot(
	ctx: ExtensionCommandContext,
	threadId: string,
	question: string,
): ForkSnapshot {
	const parentSessionFile = ctx.sessionManager.getSessionFile();
	if (!parentSessionFile) throw new Error("The current session is not persisted, so it cannot be forked.");
	if (!existsSync(parentSessionFile)) {
		throw new Error("The current session file does not exist yet. Let Pi finish at least one response, then try again.");
	}
	const leafId = ctx.sessionManager.getLeafId();
	if (!leafId) throw new Error("The current session has no conversation entry to fork from.");

	const source = SessionManager.open(parentSessionFile);
	const sessionFile = source.createBranchedSession(leafId);
	if (!sessionFile) throw new Error("Pi did not return a persisted fork session file.");

	// createBranchedSession intentionally defers writing sessions with no assistant
	// message. Materialize its in-memory snapshot so a subprocess can open it.
	if (!existsSync(sessionFile)) {
		const header = source.getHeader();
		if (!header) throw new Error("The forked session has no session header.");
		mkdirSync(dirname(sessionFile), { recursive: true });
		atomicRewriteJsonl(sessionFile, [header, ...source.getEntries()]);
	}

	const removedUnsafeThinking = sanitizeForkedThinking(sessionFile);
	const child = SessionManager.open(sessionFile);
	const markerEntryId = child.appendSessionInfo(`side thread ${threadId}: ${oneLine(question, 70)}`);
	return {
		sessionFile,
		childSessionId: child.getSessionId(),
		markerEntryId,
		removedUnsafeThinking,
	};
}

function modelUsesAnthropicMessages(ctx: ExtensionContext): boolean {
	if (!ctx.model) return false;
	const model = ctx.model as unknown as { provider?: string; api?: string };
	return model.provider?.toLowerCase() === "anthropic" || model.api?.toLowerCase() === "anthropic-messages";
}

function buildSideThreadPrompt(prompt: string): string {
	return `# Side-thread request

You are running in a background side thread forked from another Pi session. The inherited conversation is authoritative context for this request.

Rules:
- Answer the request directly and stay focused.
- This side thread is read-only. You may inspect files, but do not edit files, run mutating commands, or cause external side effects.
- You have one presentation-only capability, ${BTW_DIAGRAM_TOOL_NAME}. It attaches or replaces a diagram inside this /btw modal without changing the working tree.
- Use ${BTW_DIAGRAM_TOOL_NAME} when the user asks to diagram, map, visualize, or explain a flow visually. You may also use it when a visual materially improves exploratory learning, but never for decoration.
- Call ${BTW_DIAGRAM_TOOL_NAME} at most once per turn and keep your prose answer understandable without the diagram.
- Do not try to message, steer, or modify the main session.
- If the request asks for implementation, provide analysis or a proposed patch/plan rather than changing the working tree.

## Request

${prompt}
`;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const bunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !bunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const executable = basename(process.execPath).toLowerCase();
	if (!/^(node|nodejs|bun)(\.exe)?$/.test(executable)) return { command: process.execPath, args };
	return { command: "pi", args };
}

function childEnvironment(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, PI_SESSION_FORK_CHILD: "1" };
	for (const key of [
		"PI_SESSION_ID",
		"PI_SESSION_FILE",
		"PI_PROVIDER",
		"PI_MODEL",
		"PI_REASONING_LEVEL",
		"PI_SUBAGENT_PARENT_SESSION",
	]) {
		delete env[key];
	}
	return env;
}

function threadCompletions(registry: ForkRegistry, prefix: string) {
	if (/\s/.test(prefix)) return null;
	const normalized = prefix.trim().toLowerCase();
	const items = registry.threads
		.slice()
		.reverse()
		.filter((thread) => thread.id.toLowerCase().startsWith(normalized))
		.map((thread) => ({
			value: thread.id,
			label: thread.id,
			description: `${thread.status} · ${oneLine(thread.lastQuestion, 55)}`,
		}));
	return items.length ? items : null;
}

function termdiagExecutable(): string {
	const configured = process.env.TERMDIAG_BIN?.trim();
	if (configured) return configured;
	const cargoInstall = join(homedir(), ".cargo", "bin", "termdiag");
	return existsSync(cargoInstall) ? cargoInstall : "termdiag";
}

function parseDiagramRenderReceipt(stdout: string): DiagramRenderReceipt {
	let value: unknown;
	try {
		value = JSON.parse(stdout.trim()) as unknown;
	} catch {
		throw new Error("termdiag returned an invalid JSON receipt.");
	}
	if (
		!isRecord(value)
		|| typeof value.diagram_id !== "string"
		|| (value.status !== "artifact_only" && value.status !== "rendered")
		|| typeof value.svg_path !== "string"
		|| typeof value.png_path !== "string"
	) {
		throw new Error("termdiag returned a malformed render receipt.");
	}
	return {
		diagram_id: value.diagram_id,
		status: value.status,
		svg_path: value.svg_path,
		png_path: value.png_path,
	};
}

function parseDiagramViewportReceipt(stdout: string): DiagramViewportReceipt {
	let value: unknown;
	try {
		value = JSON.parse(stdout.trim()) as unknown;
	} catch {
		throw new Error("termdiag returned an invalid viewport receipt.");
	}
	if (
		!isRecord(value)
		|| typeof value.png_path !== "string"
		|| value.width !== DIAGRAM_RENDER_WIDTH
		|| value.height !== DIAGRAM_RENDER_HEIGHT
	) {
		throw new Error("termdiag returned a malformed viewport receipt.");
	}
	return { png_path: value.png_path, width: value.width, height: value.height };
}

function confinedRegularFile(outputDirectory: string, candidatePath: string, maxBytes: number, description: string): string {
	const root = realpathSync(outputDirectory);
	const candidate = realpathSync(candidatePath);
	if (!candidate.startsWith(`${root}${sep}`)) {
		throw new Error(`termdiag returned ${description} outside the private /btw diagram directory.`);
	}
	const metadata = statSync(candidate);
	if (!metadata.isFile() || metadata.size <= 0 || metadata.size > maxBytes) {
		throw new Error(`The rendered ${description} must be a regular file no larger than ${maxBytes} bytes.`);
	}
	return candidate;
}

function readConfinedPng(outputDirectory: string, pngPath: string): { path: string; base64: string } {
	const candidate = confinedRegularFile(outputDirectory, pngPath, MAX_INLINE_PNG_BYTES, "PNG");
	const bytes = readFileSync(candidate);
	if (
		bytes.length < 24
		|| bytes[0] !== 0x89
		|| bytes[1] !== 0x50
		|| bytes[2] !== 0x4e
		|| bytes[3] !== 0x47
		|| bytes.readUInt32BE(16) === 0
		|| bytes.readUInt32BE(20) === 0
		|| bytes.readUInt32BE(16) > DIAGRAM_RENDER_WIDTH
		|| bytes.readUInt32BE(20) > DIAGRAM_RENDER_HEIGHT
	) {
		throw new Error("termdiag returned an invalid or oversized PNG frame.");
	}
	return { path: candidate, base64: bytes.toString("base64") };
}

function parseSgrMouse(data: string): SgrMouseEvent | undefined {
	const match = data.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
	if (!match) return undefined;
	const button = Number(match[1]);
	const column = Number(match[2]);
	const row = Number(match[3]);
	if (!Number.isSafeInteger(button) || !Number.isSafeInteger(column) || !Number.isSafeInteger(row)) return undefined;
	return { button, column, row, release: match[4] === "m" };
}

function kittyImageRows(line: string): number {
	const prefix = line.indexOf("\x1b_G");
	if (prefix < 0) return 1;
	const end = line.indexOf(";", prefix + 3);
	if (end < 0) return 1;
	for (const parameter of line.slice(prefix + 3, end).split(",")) {
		const [key, value] = parameter.split("=", 2);
		if (key !== "r" || value === undefined) continue;
		const rows = Number(value);
		if (Number.isSafeInteger(rows) && rows > 0 && rows <= 10_000) return rows;
	}
	return 1;
}

/**
 * Pi 0.83's overlay compositor pads every overlay row to terminal width. That
 * breaks the empty-row reservation used by its own multi-row Kitty Image
 * component. Install a narrow, idempotent compatibility shim that preserves
 * Kitty overlay blocks while leaving all ordinary line composition untouched.
 */
function installOverlayImageCompatibility(tui: TUI): void {
	if (overlayImageCompatibleTuis.has(tui)) return;
	const internals = tui as TUI & OverlayImageTuiInternals;
	const composite = internals.compositeLineAt;
	const reservedRows = internals.getKittyImageReservedRows;
	if (typeof composite !== "function" || typeof reservedRows !== "function") return;

	internals.compositeLineAt = function (
		baseLine: string,
		overlayLine: string,
		startColumn: number,
		overlayWidth: number,
		totalWidth: number,
	): string {
		if (!overlayLine.includes("\x1b_G")) {
			return composite.call(this, baseLine, overlayLine, startColumn, overlayWidth, totalWidth);
		}
		if (baseLine.includes("\x1b_G")) return baseLine;
		const before = sliceByColumn(baseLine, 0, startColumn, true);
		return before + " ".repeat(Math.max(0, startColumn - visibleWidth(before))) + overlayLine;
	};
	internals.getKittyImageReservedRows = function (lines: string[], index: number, maxIndex = lines.length - 1): number {
		const rows = kittyImageRows(lines[index] ?? "");
		if (rows <= 1) return reservedRows.call(this, lines, index, maxIndex);
		return Math.max(1, Math.min(rows, maxIndex - index + 1, lines.length - index));
	};
	overlayImageCompatibleTuis.add(tui);
}

function diagramImageCellSize(maxColumns: number, maxRows: number): { columns: number; rows: number } {
	const cells = getCellDimensions();
	const widthScale = (Math.max(1, maxColumns) * cells.widthPx) / DIAGRAM_RENDER_WIDTH;
	const heightScale = (Math.max(1, maxRows) * cells.heightPx) / DIAGRAM_RENDER_HEIGHT;
	const scale = Math.min(widthScale, heightScale);
	return {
		columns: Math.max(1, Math.min(maxColumns, Math.ceil((DIAGRAM_RENDER_WIDTH * scale) / cells.widthPx))),
		rows: Math.max(1, Math.min(maxRows, Math.ceil((DIAGRAM_RENDER_HEIGHT * scale) / cells.heightPx))),
	};
}

function diagramTitle(request: BtwDiagramRequest): string {
	const title = request.spec.title;
	if (typeof title === "string" && title.trim()) return oneLine(title, 100);
	return typeof request.spec.id === "string" ? oneLine(request.spec.id, 100) : "Diagram";
}

interface BtwOverlaySource {
	threads(): ForkThread[];
	turns(thread: ForkThread): SideConversationTurn[];
	live(thread: ForkThread): { text?: string; tool?: string } | undefined;
	diagram(thread: ForkThread): BtwDiagramViewState | undefined;
	transform(thread: ForkThread, transform: BtwDiagramTransform): void;
	subscribe(listener: () => void): () => void;
}

interface BtwOverlayAction {
	type: "follow-up";
	threadId: string;
}

class BtwOverlay {
	private selectedId: string | undefined;
	private scrollOffset = 0;
	private followTail = true;
	private view: "answer" | "diagram" = "answer";
	private image: Image | undefined;
	private imageKey: string | undefined;
	private mouseCaptureEnabled = false;
	private dragging = false;
	private lastMouse: { column: number; row: number } | undefined;
	private imageColumns = 1;
	private imageRows = 1;
	private readonly seenReadyDiagrams = new Set<string>();
	private unsubscribe: () => void;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly done: (result?: BtwOverlayAction) => void,
		private readonly source: BtwOverlaySource,
		startId?: string,
	) {
		installOverlayImageCompatibility(tui);
		this.selectedId = startId;
		this.unsubscribe = source.subscribe(() => {
			const selected = this.selection();
			const diagram = selected ? source.diagram(selected.thread) : undefined;
			if (diagram?.status === "ready" && !this.seenReadyDiagrams.has(diagram.key)) {
				this.seenReadyDiagrams.add(diagram.key);
				this.setView("diagram");
				this.scrollOffset = 0;
				this.followTail = true;
			}
			tui.requestRender();
		});
	}

	private setMouseCapture(enabled: boolean): void {
		if (enabled === this.mouseCaptureEnabled) return;
		this.mouseCaptureEnabled = enabled;
		this.dragging = false;
		this.lastMouse = undefined;
		this.tui.terminal.write(enabled ? MOUSE_CAPTURE_ENABLE : MOUSE_CAPTURE_DISABLE);
	}

	private setView(view: "answer" | "diagram"): void {
		this.view = view;
		this.setMouseCapture(view === "diagram");
	}

	private selection(): { threads: ForkThread[]; thread: ForkThread; index: number } | undefined {
		const threads = this.source.threads();
		if (threads.length === 0) return undefined;
		let index = this.selectedId ? threads.findIndex((thread) => thread.id === this.selectedId) : -1;
		if (index < 0) index = threads.length - 1;
		const thread = threads[index];
		if (!thread) return undefined;
		this.selectedId = thread.id;
		return { threads, thread, index };
	}

	private moveQuestion(delta: number): void {
		const selected = this.selection();
		if (!selected) return;
		const index = Math.max(0, Math.min(selected.threads.length - 1, selected.index + delta));
		this.selectedId = selected.threads[index]?.id;
		this.scrollOffset = 0;
		this.followTail = true;
		this.image = undefined;
		this.imageKey = undefined;
		const next = selected.threads[index];
		if (!next || !this.source.diagram(next)) this.setView("answer");
		this.tui.requestRender();
	}

	private handleMouse(data: string): boolean {
		if (this.view !== "diagram") return false;
		const event = parseSgrMouse(data);
		if (!event) return false;
		const selected = this.selection();
		if (!selected) return true;
		const diagram = this.source.diagram(selected.thread);
		if (!diagram || diagram.status !== "ready") return true;

		if ((event.button & 64) !== 0) {
			const wheelDirection = event.button & 3;
			if (wheelDirection === 0) this.source.transform(selected.thread, { type: "zoom", factor: 1.2 });
			else if (wheelDirection === 1) this.source.transform(selected.thread, { type: "zoom", factor: 1 / 1.2 });
			return true;
		}
		if (event.release) {
			this.dragging = false;
			this.lastMouse = undefined;
			return true;
		}

		const button = event.button & 3;
		const motion = (event.button & 32) !== 0;
		if (!motion && (button === 0 || button === 1)) {
			this.dragging = true;
			this.lastMouse = { column: event.column, row: event.row };
			return true;
		}
		if (motion && this.dragging && this.lastMouse && (button === 0 || button === 1)) {
			const deltaColumns = event.column - this.lastMouse.column;
			const deltaRows = event.row - this.lastMouse.row;
			this.lastMouse = { column: event.column, row: event.row };
			if (deltaColumns !== 0 || deltaRows !== 0) {
				this.source.transform(selected.thread, {
					type: "pan",
					deltaX: deltaColumns * (DIAGRAM_RENDER_WIDTH / this.imageColumns),
					deltaY: deltaRows * (DIAGRAM_RENDER_HEIGHT / this.imageRows),
				});
			}
			return true;
		}
		return true;
	}

	handleInput(data: string): void {
		if (this.handleMouse(data)) return;
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.ctrl("d")) || data === "q") {
			this.setMouseCapture(false);
			this.done();
			return;
		}
		if (matchesKey(data, Key.enter) || data === "f") {
			const selected = this.selection();
			if (selected) {
				this.setMouseCapture(false);
				this.done({ type: "follow-up", threadId: selected.thread.id });
			}
			return;
		}
		if (matchesKey(data, Key.tab) || data === "d") {
			const selected = this.selection();
			if (selected && this.source.diagram(selected.thread)) {
				this.setView(this.view === "answer" ? "diagram" : "answer");
				this.scrollOffset = 0;
				this.followTail = true;
				this.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, Key.left) || data === "p") {
			this.moveQuestion(-1);
			return;
		}
		if (matchesKey(data, Key.right) || data === "n") {
			this.moveQuestion(1);
			return;
		}
		if (this.view === "diagram") {
			const selected = this.selection();
			if (!selected) return;
			if (data === "+" || data === "=") this.source.transform(selected.thread, { type: "zoom", factor: 1.2 });
			else if (data === "-" || data === "_") this.source.transform(selected.thread, { type: "zoom", factor: 1 / 1.2 });
			else if (data === "0") this.source.transform(selected.thread, { type: "fit" });
			return;
		}
		if (matchesKey(data, Key.up) || data === "k") {
			this.followTail = false;
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
		} else if (matchesKey(data, Key.down) || data === "j") {
			this.followTail = false;
			this.scrollOffset += 1;
		} else if (matchesKey(data, Key.pageUp)) {
			this.followTail = false;
			this.scrollOffset = Math.max(0, this.scrollOffset - 10);
		} else if (matchesKey(data, Key.pageDown)) {
			this.followTail = false;
			this.scrollOffset += 10;
		} else if (matchesKey(data, Key.home)) {
			this.followTail = false;
			this.scrollOffset = 0;
		} else if (matchesKey(data, Key.end)) {
			this.followTail = true;
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const w = Math.max(2, width);
		const innerWidth = Math.max(0, w - 2);
		const contentWidth = Math.max(1, innerWidth - 2);
		const border = (text: string) => this.theme.fg("border", text);
		const row = (content = "") => {
			const clipped = truncateToWidth(content, innerWidth, "…");
			return border("│") + clipped + " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped))) + border("│");
		};
		const selected = this.selection();
		if (!selected) return [border(`╭${"─".repeat(innerWidth)}╮`), row(" No side questions yet"), border(`╰${"─".repeat(innerWidth)}╯`)];
		const { thread, threads, index } = selected;
		const diagram = this.source.diagram(thread);
		if (this.view === "diagram" && !diagram) this.setView("answer");
		const live = this.source.live(thread);
		const turns = this.source.turns(thread);
		if (turns.length === 0) turns.push({ question: thread.lastQuestion });
		const conversation: string[] = [];
		for (const [turnIndex, turn] of turns.entries()) {
			if (turnIndex > 0) conversation.push("", this.theme.fg("dim", "─".repeat(Math.max(1, contentWidth))), "");
			conversation.push(this.theme.fg("accent", this.theme.bold("You")));
			conversation.push(sanitizeTerminalText(turn.question), "");
			conversation.push(this.theme.fg("accent", this.theme.bold("BTW")));
			const answer = turn.state === "running" && live
				? live.text || (live.tool ? `Working with ${live.tool}…` : "Thinking…")
				: turn.answer
					? turn.answer
					: turn.state === "queued"
						? "Queued…"
						: thread.lastError && turnIndex === turns.length - 1 && thread.status !== "completed"
							? `Error: ${thread.lastError}`
							: "No answer yet.";
			conversation.push(sanitizeTerminalText(answer));
		}
		const statusColor = thread.status === "completed"
			? "success"
			: thread.status === "failed" || thread.status === "interrupted"
				? "error"
				: thread.status === "running" || thread.status === "queued"
					? "warning"
					: "muted";
		const statusText = truncateToWidth(thread.status, Math.max(0, innerWidth - 1), "");
		const status = statusText ? this.theme.fg(statusColor, statusText) : "";
		const statusWidth = statusText ? visibleWidth(statusText) + 1 : 0;
		const title = truncateToWidth(` BTW ${thread.id} · ${index + 1}/${threads.length} `, Math.max(0, innerWidth - statusWidth), "");
		const titleWidth = visibleWidth(title);
		const fill = Math.max(0, innerWidth - titleWidth - statusWidth);
		const lines: string[] = [
			border("╭") + this.theme.fg("accent", this.theme.bold(title)) + border("─".repeat(fill)) + (status ? ` ${status}` : "") + border("╮"),
		];
		const overlayRowBudget = Math.max(10, Math.floor(this.tui.terminal.rows * 0.85));
		const visibleConversationRows = Math.max(3, Math.min(28, overlayRowBudget - 5));
		const answerTab = this.view === "answer"
			? this.theme.fg("accent", this.theme.bold("[Answer]"))
			: this.theme.fg("dim", " Answer ");
		const diagramTab = diagram
			? this.view === "diagram"
				? this.theme.fg("accent", this.theme.bold("[Diagram]"))
				: this.theme.fg("dim", " Diagram ")
			: this.theme.fg("muted", " Diagram - ");
		lines.push(row(` ${answerTab}  ${diagramTab}`), row());

		if (this.view === "diagram" && diagram) {
			if (diagram.status === "ready" && diagram.pngBase64 && diagram.pngPath) {
				const imageSize = diagramImageCellSize(contentWidth, visibleConversationRows);
				this.imageColumns = imageSize.columns;
				this.imageRows = imageSize.rows;
				const nextImageKey = `${diagram.key}:${diagram.updatedAt}`;
				if (!this.image || this.imageKey !== nextImageKey) {
					this.image = new Image(
						diagram.pngBase64,
						"image/png",
						{ fallbackColor: (text) => this.theme.fg("dim", text) },
						{
							maxWidthCells: contentWidth,
							maxHeightCells: visibleConversationRows,
							filename: diagram.pngPath,
						},
					);
					this.imageKey = nextImageKey;
				}
				const imageLines = this.image.render(contentWidth + 2).slice(0, visibleConversationRows);
				for (const imageLine of imageLines) lines.push(row(` ${imageLine}`));
				for (let i = imageLines.length; i < visibleConversationRows; i++) lines.push(row());
			} else {
				this.image = undefined;
				this.imageKey = undefined;
				const detail = diagram.status === "error"
					? this.theme.fg("error", `Diagram error: ${sanitizeTerminalText(diagram.error ?? "unknown rendering error")}`)
					: this.theme.fg("warning", diagram.status === "requested" ? "The agent requested a diagram…" : "Rendering diagram…");
				const detailLines = wrapTextWithAnsi(detail, contentWidth);
				for (const detailLine of detailLines.slice(0, visibleConversationRows)) lines.push(row(` ${detailLine}`));
				for (let i = Math.min(detailLines.length, visibleConversationRows); i < visibleConversationRows; i++) lines.push(row());
			}
			lines.push(row());
			const zoom = Math.round((diagram.zoom ?? 1) * 100);
			const updating = diagram.transforming ? " · updating…" : "";
			const failed = diagram.error ? " · update failed" : "";
			lines.push(row(` ${this.theme.fg("dim", `${zoom}%${updating}${failed} · drag pan · wheel/+/- zoom · 0 fit · Tab/d answer · Esc/q close`)}`));
			lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
			return lines;
		}

		this.image = undefined;
		this.imageKey = undefined;
		const conversationLines = wrapTextWithAnsi(conversation.join("\n"), contentWidth);
		const maxScroll = Math.max(0, conversationLines.length - visibleConversationRows);
		if (!this.followTail && this.scrollOffset >= maxScroll) this.followTail = true;
		this.scrollOffset = this.followTail ? maxScroll : Math.max(0, Math.min(this.scrollOffset, maxScroll));
		const visible = conversationLines.slice(this.scrollOffset, this.scrollOffset + visibleConversationRows);
		for (const conversationLine of visible) lines.push(row(` ${conversationLine}`));
		for (let i = visible.length; i < visibleConversationRows; i++) lines.push(row());

		const scroll = maxScroll > 0 ? ` · ${this.scrollOffset + 1}-${Math.min(conversationLines.length, this.scrollOffset + visibleConversationRows)}/${conversationLines.length}` : "";
		lines.push(row());
		const diagramHint = diagram ? " · Tab/d diagram" : "";
		lines.push(row(` ${this.theme.fg("dim", `Enter/f follow-up${diagramHint} · ←→ threads · ↑↓ scroll${scroll} · Esc/q close`)}`));
		lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
		return lines;
	}

	invalidate(): void {
		this.image?.invalidate();
	}

	dispose(): void {
		this.setMouseCapture(false);
		this.unsubscribe();
	}
}

export default function sessionForksExtension(pi: ExtensionAPI) {
	if (IS_SIDE_THREAD_CHILD || IS_NESTED_SUBAGENT) return;

	let activeCtx: ExtensionContext | undefined;
	let registry = newRegistry("unbound");
	let registryPath: string | undefined;
	let runtimeLease: RuntimeLease | undefined;
	let disposed = false;
	let pumping = false;
	const running = new Map<string, RunningPrompt>();
	const answerCache = new Map<string, { mtimeMs: number; answer: string }>();
	const conversationCache = new Map<string, { mtimeMs: number; turns: SideConversationTurn[] }>();
	const diagramStates = new Map<string, BtwDiagramViewState>();
	const diagramRenderJobs = new Map<string, DiagramRenderJob>();
	const diagramViewportJobs = new Map<string, DiagramRenderJob>();
	const diagramViewportTimers = new Map<string, ReturnType<typeof setTimeout>>();
	const overlayListeners = new Set<() => void>();

	const save = () => {
		if (!runtimeLease) return;
		try {
			persistRegistry(registryPath, registry);
		} catch (error) {
			console.error(`[${EXTENSION_ID}] Could not persist state:`, error);
		}
	};
	const refreshOverlays = () => {
		for (const listener of overlayListeners) {
			try {
				listener();
			} catch {
				// The overlay may have been disposed between a child event and this callback.
			}
		}
	};
	const findThread = (id: string | undefined): ForkThread | undefined => {
		const target = id?.trim() || registry.lastThreadId;
		return target ? registry.threads.find((thread) => thread.id === target) : undefined;
	};
	const activeCount = () => registry.threads.filter((thread) => ["running", "queued", "stopping", "orphaned"].includes(thread.status)).length;
	const updateStatus = () => {
		if (!activeCtx) return;
		const count = activeCount();
		activeCtx.ui.setStatus(EXTENSION_ID, count > 0 ? `forks:${count}` : undefined);
	};
	const showEntry = (title: string, body: string, details?: string) => {
		const truncated = truncateForEntry(sanitizeTerminalText(body));
		pi.appendEntry<DisplayEntryData>(ENTRY_TYPE, {
			title: sanitizeTerminalText(title),
			body: truncated.text,
			...(details ? { details: sanitizeTerminalText(details) } : {}),
			timestamp: Date.now(),
		});
	};
	const answerFor = (thread: ForkThread): string | undefined => {
		try {
			if (!existsSync(thread.sessionFile)) return undefined;
			const mtimeMs = statSync(thread.sessionFile).mtimeMs;
			const cached = answerCache.get(thread.id);
			if (cached?.mtimeMs === mtimeMs) return cached.answer;
			const answer = latestAssistantText(thread.sessionFile, thread.markerEntryId);
			if (answer !== undefined) answerCache.set(thread.id, { mtimeMs, answer });
			return answer;
		} catch {
			return undefined;
		}
	};
	const turnsFor = (thread: ForkThread): SideConversationTurn[] => {
		let turns: SideConversationTurn[] = [];
		try {
			if (existsSync(thread.sessionFile)) {
				const mtimeMs = statSync(thread.sessionFile).mtimeMs;
				const cached = conversationCache.get(thread.id);
				if (cached?.mtimeMs === mtimeMs) turns = cached.turns.map((turn) => ({ ...turn }));
				else {
					turns = sideConversationTurns(thread.sessionFile, thread.markerEntryId);
					conversationCache.set(thread.id, { mtimeMs, turns: turns.map((turn) => ({ ...turn })) });
				}
			}
		} catch {
			turns = [];
		}
		if (thread.currentPrompt) {
			const expectedStartedTurns = Math.max(1, thread.promptCount - thread.queue.length);
			const last = turns[turns.length - 1];
			if (turns.length < expectedStartedTurns || !last || last.question !== thread.currentPrompt) {
				turns.push({ question: thread.currentPrompt, state: "running" });
			} else {
				last.state = "running";
			}
		}
		for (const queued of thread.queue) turns.push({ question: queued.prompt, state: "queued" });
		return turns;
	};

	const latestDiagramCall = (thread: ForkThread): BtwDiagramCall | undefined => {
		const live = running.get(thread.id)?.latestDiagramCall;
		if (live) return live;
		const turns = turnsFor(thread);
		for (let index = turns.length - 1; index >= 0; index--) {
			const diagram = turns[index]?.diagram;
			if (diagram) return diagram;
		}
		return undefined;
	};
	const diagramOutputDirectory = (thread: ForkThread) => join(
		getAgentDir(),
		"state",
		EXTENSION_ID,
		"diagrams",
		safeStateFileName(registry.parentSessionId),
		thread.id,
	);

	const cancelDiagramViewport = (threadId: string) => {
		let cancelled = false;
		const timer = diagramViewportTimers.get(threadId);
		if (timer) {
			clearTimeout(timer);
			diagramViewportTimers.delete(threadId);
			cancelled = true;
		}
		const job = diagramViewportJobs.get(threadId);
		if (job) {
			cancelled = true;
			diagramViewportJobs.delete(threadId);
			if (job.timeoutHandle) clearTimeout(job.timeoutHandle);
			if (job.killHandle) clearTimeout(job.killHandle);
			job.child.kill("SIGTERM");
			job.killHandle = setTimeout(() => job.child.kill("SIGKILL"), FORCE_KILL_AFTER_MS);
			job.killHandle.unref?.();
		}
		const current = diagramStates.get(threadId);
		if (cancelled && current?.transforming) diagramStates.set(threadId, { ...current, transforming: false });
	};

	const cancelDiagramRender = (threadId: string, clearState = false) => {
		cancelDiagramViewport(threadId);
		const job = diagramRenderJobs.get(threadId);
		if (job) {
			diagramRenderJobs.delete(threadId);
			if (job.timeoutHandle) clearTimeout(job.timeoutHandle);
			if (job.killHandle) clearTimeout(job.killHandle);
			job.child.kill("SIGTERM");
			job.killHandle = setTimeout(() => job.child.kill("SIGKILL"), FORCE_KILL_AFTER_MS);
			job.killHandle.unref?.();
		}
		if (clearState) diagramStates.delete(threadId);
	};

	const startDiagramRender = (thread: ForkThread, call: BtwDiagramCall) => {
		const existing = diagramStates.get(thread.id);
		if (existing?.key === call.key && (existing.status === "rendering" || existing.status === "ready" || existing.status === "error")) {
			return existing;
		}
		cancelDiagramRender(thread.id);

		const outputDirectory = diagramOutputDirectory(thread);
		mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
		const configuredTheme = activeCtx?.ui.theme.name?.toLowerCase() ?? "";
		const theme = call.request.options?.theme ?? (configuredTheme.includes("light") ? "light" : "dark");
		const state: BtwDiagramViewState = {
			key: call.key,
			request: call.request,
			status: "rendering",
			title: diagramTitle(call.request),
			updatedAt: Date.now(),
			theme,
		};
		diagramStates.set(thread.id, state);
		refreshOverlays();

		const timeoutMs = call.request.options?.timeout_ms ?? 8_000;
		const args = [
			"render",
			"--input",
			"-",
			"--output-dir",
			outputDirectory,
			"--width",
			String(DIAGRAM_RENDER_WIDTH),
			"--height",
			String(DIAGRAM_RENDER_HEIGHT),
			"--timeout-ms",
			String(timeoutMs),
			"--theme",
			theme,
			"--presenter",
			"file",
			"--json",
		];

		let stdout = "";
		let stderr = "";
		let spawnError: string | undefined;
		let child: ChildProcess;
		try {
			child = spawn(termdiagExecutable(), args, {
				cwd: thread.cwd,
				env: process.env,
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (error) {
			diagramStates.set(thread.id, {
				...state,
				status: "error",
				updatedAt: Date.now(),
				error: oneLine(errorMessage(error), 1_000),
			});
			refreshOverlays();
			return state;
		}
		const job: DiagramRenderJob = { key: call.key, child };
		diagramRenderJobs.set(thread.id, job);
		job.timeoutHandle = setTimeout(() => {
			spawnError = `Diagram rendering timed out after ${timeoutMs + DIAGRAM_RENDER_GRACE_MS} ms.`;
			child.kill("SIGTERM");
			job.killHandle = setTimeout(() => child.kill("SIGKILL"), FORCE_KILL_AFTER_MS);
			job.killHandle.unref?.();
		}, timeoutMs + DIAGRAM_RENDER_GRACE_MS);
		job.timeoutHandle.unref?.();

		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: Buffer | string) => {
			stdout = appendTail(stdout, chunk.toString(), 64 * 1024);
		});
		child.stderr?.on("data", (chunk: Buffer | string) => {
			stderr = appendTail(stderr, chunk.toString(), MAX_STDERR_BYTES);
		});
		child.on("error", (error) => {
			spawnError = error.message;
		});
		child.on("close", (code, signal) => {
			if (job.timeoutHandle) clearTimeout(job.timeoutHandle);
			if (job.killHandle) clearTimeout(job.killHandle);
			if (diagramRenderJobs.get(thread.id) === job) diagramRenderJobs.delete(thread.id);
			const current = diagramStates.get(thread.id);
			if (!current || current.key !== call.key) return;
			try {
				if (spawnError) throw new Error(spawnError);
				if (code !== 0) {
					throw new Error(oneLine(stderr, 1_000) || `termdiag exited with code ${String(code)}${signal ? ` (${signal})` : ""}.`);
				}
				const receipt = parseDiagramRenderReceipt(stdout);
				if (receipt.diagram_id !== call.request.spec.id) throw new Error("termdiag returned the wrong diagram artifact.");
				const svgPath = confinedRegularFile(outputDirectory, receipt.svg_path, MAX_INLINE_SVG_BYTES, "SVG");
				const png = readConfinedPng(outputDirectory, receipt.png_path);
				const { error: _error, ...readyState } = current;
				diagramStates.set(thread.id, {
					...readyState,
					status: "ready",
					updatedAt: Date.now(),
					svgPath,
					pngPath: png.path,
					pngBase64: png.base64,
					zoom: 1,
					panX: 0,
					panY: 0,
				});
				if (!disposed && activeCtx && overlayListeners.size === 0) {
					activeCtx.ui.notify(`BTW ${thread.id} diagram is ready. Run /btw to view it.`, "info");
				}
			} catch (error) {
				diagramStates.set(thread.id, {
					...current,
					status: "error",
					updatedAt: Date.now(),
					error: oneLine(errorMessage(error), 1_000),
				});
			}
			refreshOverlays();
		});

		try {
			child.stdin?.end(`${JSON.stringify(call.request.spec)}\n`);
		} catch (error) {
			spawnError = errorMessage(error);
			child.kill("SIGTERM");
		}
		return state;
	};

	const startDiagramViewport = (thread: ForkThread) => {
		diagramViewportTimers.delete(thread.id);
		const state = diagramStates.get(thread.id);
		if (!state || state.status !== "ready" || !state.svgPath) return;
		const outputDirectory = diagramOutputDirectory(thread);
		const outputPath = join(outputDirectory, `btw-viewport-${randomUUID()}.png`);
		const zoom = state.zoom ?? 1;
		const panX = state.panX ?? 0;
		const panY = state.panY ?? 0;
		const args = [
			"viewport",
			"--input",
			state.svgPath,
			"--output",
			outputPath,
			"--width",
			String(DIAGRAM_RENDER_WIDTH),
			"--height",
			String(DIAGRAM_RENDER_HEIGHT),
			"--zoom",
			String(zoom),
			"--pan-x",
			String(panX),
			"--pan-y",
			String(panY),
			"--background",
			state.theme === "light" ? "white" : "#111827",
			"--json",
		];

		let child: ChildProcess;
		try {
			child = spawn(termdiagExecutable(), args, {
				cwd: thread.cwd,
				env: process.env,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			diagramStates.set(thread.id, {
				...state,
				transforming: false,
				error: oneLine(errorMessage(error), 1_000),
			});
			refreshOverlays();
			return;
		}

		let stdout = "";
		let stderr = "";
		let spawnError: string | undefined;
		const job: DiagramRenderJob = { key: randomUUID(), child, outputPath };
		diagramViewportJobs.set(thread.id, job);
		job.timeoutHandle = setTimeout(() => {
			spawnError = `Diagram viewport update timed out after ${DIAGRAM_VIEWPORT_TIMEOUT_MS} ms.`;
			child.kill("SIGTERM");
			job.killHandle = setTimeout(() => child.kill("SIGKILL"), FORCE_KILL_AFTER_MS);
			job.killHandle.unref?.();
		}, DIAGRAM_VIEWPORT_TIMEOUT_MS);
		job.timeoutHandle.unref?.();

		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: Buffer | string) => {
			stdout = appendTail(stdout, chunk.toString(), 64 * 1024);
		});
		child.stderr?.on("data", (chunk: Buffer | string) => {
			stderr = appendTail(stderr, chunk.toString(), MAX_STDERR_BYTES);
		});
		child.on("error", (error) => {
			spawnError = error.message;
		});
		child.on("close", (code, signal) => {
			if (job.timeoutHandle) clearTimeout(job.timeoutHandle);
			if (job.killHandle) clearTimeout(job.killHandle);
			if (diagramViewportJobs.get(thread.id) !== job) {
				if (job.outputPath) {
					try {
						rmSync(job.outputPath, { force: true });
					} catch {
						// A cancelled viewport may already have been removed.
					}
				}
				return;
			}
			diagramViewportJobs.delete(thread.id);
			const current = diagramStates.get(thread.id);
			if (!current || current.key !== state.key || current.status !== "ready") {
				if (job.outputPath) {
					try {
						rmSync(job.outputPath, { force: true });
					} catch {
						// A stale viewport is only a cache artifact.
					}
				}
				return;
			}
			try {
				if (spawnError) throw new Error(spawnError);
				if (code !== 0) {
					throw new Error(oneLine(stderr, 1_000) || `termdiag viewport exited with code ${String(code)}${signal ? ` (${signal})` : ""}.`);
				}
				const receipt = parseDiagramViewportReceipt(stdout);
				const png = readConfinedPng(outputDirectory, receipt.png_path);
				const previousPngPath = current.pngPath;
				const { error: _error, ...updatedState } = current;
				diagramStates.set(thread.id, {
					...updatedState,
					updatedAt: Date.now(),
					pngPath: png.path,
					pngBase64: png.base64,
					transforming: false,
				});
				if (previousPngPath && previousPngPath !== png.path && basename(previousPngPath).startsWith("btw-viewport-")) {
					try {
						const previous = confinedRegularFile(outputDirectory, previousPngPath, MAX_INLINE_PNG_BYTES, "PNG");
						rmSync(previous, { force: true });
					} catch {
						// A superseded generated viewport is only a cache artifact.
					}
				}
			} catch (error) {
				if (job.outputPath) {
					try {
						rmSync(job.outputPath, { force: true });
					} catch {
						// Keep the previous good image even if cache cleanup fails.
					}
				}
				diagramStates.set(thread.id, {
					...current,
					transforming: false,
					error: oneLine(errorMessage(error), 1_000),
				});
			}
			refreshOverlays();
		});
	};

	const transformDiagram = (thread: ForkThread, transform: BtwDiagramTransform) => {
		const current = diagramStates.get(thread.id);
		if (!current || current.status !== "ready" || !current.svgPath || !current.pngBase64) return;
		let zoom = current.zoom ?? 1;
		let panX = current.panX ?? 0;
		let panY = current.panY ?? 0;
		if (transform.type === "fit") {
			zoom = 1;
			panX = 0;
			panY = 0;
		} else if (transform.type === "zoom") {
			if (!Number.isFinite(transform.factor) || transform.factor <= 0) return;
			zoom = Math.min(MAX_DIAGRAM_ZOOM, Math.max(MIN_DIAGRAM_ZOOM, zoom * transform.factor));
		} else {
			if (!Number.isFinite(transform.deltaX) || !Number.isFinite(transform.deltaY)) return;
			panX = Math.max(-DIAGRAM_RENDER_WIDTH * 4, Math.min(DIAGRAM_RENDER_WIDTH * 4, panX + transform.deltaX));
			panY = Math.max(-DIAGRAM_RENDER_HEIGHT * 4, Math.min(DIAGRAM_RENDER_HEIGHT * 4, panY + transform.deltaY));
		}
		zoom = Math.round(zoom * 1_000) / 1_000;
		panX = Math.round(panX * 100) / 100;
		panY = Math.round(panY * 100) / 100;
		if (zoom === (current.zoom ?? 1) && panX === (current.panX ?? 0) && panY === (current.panY ?? 0)) return;

		cancelDiagramViewport(thread.id);
		const { error: _error, ...nextState } = current;
		diagramStates.set(thread.id, {
			...nextState,
			zoom,
			panX,
			panY,
			transforming: true,
		});
		refreshOverlays();
		const timer = setTimeout(() => startDiagramViewport(thread), DIAGRAM_VIEWPORT_DEBOUNCE_MS);
		timer.unref?.();
		diagramViewportTimers.set(thread.id, timer);
	};

	const diagramFor = (thread: ForkThread): BtwDiagramViewState | undefined => {
		const call = latestDiagramCall(thread);
		if (!call) return undefined;
		const state = diagramStates.get(thread.id);
		return state?.key === call.key ? state : startDiagramRender(thread, call);
	};

	const openBtwOverlay = async (ctx: ExtensionCommandContext, startId?: string) => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("The /btw browser overlay requires interactive TUI mode.", "error");
			return;
		}
		let selectedId = startId;
		while (true) {
			const action = await ctx.ui.custom<BtwOverlayAction | undefined>(
				(tui, theme, _keybindings, done) => new BtwOverlay(tui, theme, done, {
					threads: () => registry.threads.slice(),
					turns: turnsFor,
					live: (thread) => {
						const record = running.get(thread.id);
						if (!record) return undefined;
						return {
							...(record.streamingAnswer !== undefined ? { text: record.streamingAnswer } : {}),
							...(record.currentTool ? { tool: record.currentTool } : {}),
						};
					},
					diagram: diagramFor,
					transform: transformDiagram,
					subscribe: (listener) => {
						overlayListeners.add(listener);
						return () => overlayListeners.delete(listener);
					},
				}, selectedId),
				{
					overlay: true,
					overlayOptions: { anchor: "center", width: "72%", minWidth: 54, maxHeight: "85%", margin: 1 },
				},
			);
			if (!action || action.type !== "follow-up") return;
			selectedId = action.threadId;
			const prompt = (await ctx.ui.input(`Follow up ${selectedId}`, "Continue this side conversation"))?.trim();
			if (!prompt) return;
			const thread = findThread(selectedId);
			if (!thread) {
				ctx.ui.notify(`Unknown side thread: ${selectedId}`, "error");
				return;
			}
			try {
				const queued = queueFollowUp(thread, prompt);
				ctx.ui.notify(queued ? `Queued a follow-up for ${thread.id}.` : `Continuing ${thread.id}.`, "info");
			} catch (error) {
				ctx.ui.notify(`Could not continue ${thread.id}: ${errorMessage(error)}`, "error");
			}
		}
	};

	const finalizeProcess = (record: RunningPrompt, code: number | null, signal: NodeJS.Signals | null) => {
		if (record.settled) return;
		record.settled = true;
		if (record.timeoutHandle) clearTimeout(record.timeoutHandle);
		if (record.killHandle) clearTimeout(record.killHandle);
		running.delete(record.threadId);
		try {
			rmSync(record.tempDir, { recursive: true, force: true });
			releaseThreadLock(record.lockFile, record.lockToken);
		} catch (error) {
			console.error(`[${EXTENSION_ID}] Could not clean child resources:`, error);
		}

		const thread = findThread(record.threadId);
		if (!thread) {
			record.resolveClose();
			return;
		}
		const answer = record.finalAnswer;
		thread.pid = undefined;
		thread.currentPrompt = undefined;
		thread.lastExitCode = code ?? undefined;
		thread.updatedAt = Date.now();

		if (record.stopReason === "shutdown") {
			thread.status = thread.queue.length > 0 ? "queued" : "interrupted";
			thread.lastError = "The in-flight side question was interrupted because the parent Pi session shut down or reloaded.";
		} else if (record.stopReason === "user") {
			thread.status = "stopped";
			thread.queue = [];
			thread.lastError = "Stopped by user.";
		} else if (record.stopReason === "timeout") {
			thread.status = "failed";
			thread.lastError = `Timed out after ${Math.round(RUN_TIMEOUT_MS / 60_000)} minutes.`;
		} else if (record.spawnError || code !== 0 || record.assistantStopReason === "error" || record.assistantStopReason === "aborted") {
			thread.status = "failed";
			const stderr = oneLine(record.stderr, 500);
			thread.lastError = record.spawnError
				?? record.assistantError
				?? (stderr || `Child exited with code ${String(code)}${signal ? ` (${signal})` : ""}.`);
		} else if (!answer) {
			thread.status = "failed";
			thread.lastError = "The child exited successfully but produced no assistant text.";
		} else {
			thread.status = thread.queue.length > 0 ? "queued" : "completed";
			thread.lastAnswerPreview = oneLine(answer, 300);
			thread.lastError = undefined;
			try {
				if (existsSync(thread.sessionFile)) {
					answerCache.set(thread.id, { mtimeMs: statSync(thread.sessionFile).mtimeMs, answer });
				}
			} catch {
				// The answer remains available in the child event even if its file vanished.
			}
		}

		save();
		updateStatus();
		refreshOverlays();
		record.resolveClose();
		if (!disposed && activeCtx) {
			if (thread.status === "completed") {
				activeCtx.ui.notify(`Side thread ${thread.id} finished. Use /fork-show ${thread.id}.`, "info");
			} else if (thread.status === "failed") {
				activeCtx.ui.notify(`Side thread ${thread.id} failed: ${oneLine(thread.lastError ?? "unknown error", 120)}`, "error");
			} else if (thread.status === "stopped") {
				activeCtx.ui.notify(`Side thread ${thread.id} stopped.`, "info");
			}
		}
		if (!disposed) queueMicrotask(() => void pump());
	};

	const terminateFailedRecord = (record: RunningPrompt) => {
		record.child.kill("SIGTERM");
		if (!record.killHandle) {
			record.killHandle = setTimeout(() => record.child.kill("SIGKILL"), FORCE_KILL_AFTER_MS);
			record.killHandle.unref?.();
		}
	};

	const processJsonLine = (record: RunningPrompt, line: string) => {
		if (!line.trim()) return;
		if (Buffer.byteLength(line, "utf8") > MAX_JSON_EVENT_BYTES) {
			record.spawnError = `Child emitted a JSON event larger than ${MAX_JSON_EVENT_BYTES} bytes.`;
			terminateFailedRecord(record);
			return;
		}
		let event: unknown;
		try {
			event = JSON.parse(line) as unknown;
		} catch {
			return;
		}
		if (!isRecord(event)) return;
		if (event.type === "message_start" && isRecord(event.message) && event.message.role === "assistant") {
			record.streamingAnswer = "";
		}
		if (event.type === "message_update" && isRecord(event.assistantMessageEvent)) {
			const update = event.assistantMessageEvent;
			if (update.type === "text_delta" && typeof update.delta === "string") {
				const next = (record.streamingAnswer ?? "") + update.delta;
				if (Buffer.byteLength(next, "utf8") <= MAX_LIVE_ANSWER_BYTES) record.streamingAnswer = next;
			}
		}
		if (event.type === "message_end" && isRecord(event.message) && event.message.role === "assistant") {
			const answer = textFromMessage(event.message);
			if (answer) {
				record.finalAnswer = answer;
				record.streamingAnswer = answer;
			}
			if (typeof event.message.stopReason === "string") record.assistantStopReason = event.message.stopReason;
			if (typeof event.message.errorMessage === "string") record.assistantError = event.message.errorMessage;
		}
		if (event.type === "tool_execution_start" && typeof event.toolName === "string") {
			record.currentTool = event.toolName;
			if (event.toolName === BTW_DIAGRAM_TOOL_NAME && typeof event.toolCallId === "string") {
				cancelDiagramRender(record.threadId);
				try {
					const request = parseBtwDiagramRequest(event.args);
					const call = { key: event.toolCallId, request };
					record.diagramCalls.set(event.toolCallId, request);
					record.latestDiagramCall = call;
					diagramStates.set(record.threadId, {
						key: call.key,
						request,
						status: "requested",
						title: diagramTitle(request),
						updatedAt: Date.now(),
					});
				} catch (error) {
					diagramStates.set(record.threadId, {
						key: event.toolCallId,
						request: { spec: { schema_version: 1, kind: "flow", id: "invalid-diagram" } },
						status: "error",
						title: "Diagram",
						updatedAt: Date.now(),
						error: oneLine(errorMessage(error), 1_000),
					});
				}
			}
		}
		if (event.type === "tool_execution_end") {
			record.currentTool = undefined;
			if (event.toolName === BTW_DIAGRAM_TOOL_NAME && typeof event.toolCallId === "string") {
				const request = record.diagramCalls.get(event.toolCallId);
				record.diagramCalls.delete(event.toolCallId);
				if (event.isError === true || !request) {
					if (record.latestDiagramCall?.key === event.toolCallId) record.latestDiagramCall = undefined;
					const current = diagramStates.get(record.threadId);
					if (current?.key === event.toolCallId) {
						diagramStates.set(record.threadId, {
							...current,
							status: "error",
							updatedAt: Date.now(),
							error: "The agent's diagram request was rejected.",
						});
					}
				} else {
					const call = { key: event.toolCallId, request };
					record.latestDiagramCall = call;
					const thread = findThread(record.threadId);
					if (thread) startDiagramRender(thread, call);
				}
			}
		}
		refreshOverlays();
	};

	const startPrompt = (thread: ForkThread, queued: QueuedPrompt) => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-session-fork-"));
		const promptFile = join(tempDir, "request.md");
		writeFileSync(promptFile, buildSideThreadPrompt(queued.prompt), { encoding: "utf8", mode: 0o600 });

		const args = [
			"--mode",
			"json",
			"--print",
			...(LOAD_CHILD_EXTENSIONS ? [] : ["--no-extensions"]),
			"--extension",
			BTW_DIAGRAM_TOOL_PATH,
			"--session",
			thread.sessionFile,
			"--tools",
			READ_ONLY_TOOLS.join(","),
			"--exclude-tools",
			"bash,edit,write",
			thread.projectTrusted ? "--approve" : "--no-approve",
			...(thread.projectTrusted ? [] : ["--no-context-files", "--no-skills", "--no-prompt-templates"]),
		];
		if (thread.model) args.push("--model", thread.model);
		if (THINKING_LEVELS.has(thread.thinkingLevel)) args.push("--thinking", thread.thinkingLevel);
		args.push(`@${promptFile}`, "Answer the side-thread request in the attached file.");

		const invocation = getPiInvocation(args);
		let resolveClose!: () => void;
		const closePromise = new Promise<void>((resolve) => {
			resolveClose = resolve;
		});
		let lockFile: string;
		let lockToken: string;
		try {
			({ lockFile, token: lockToken } = acquireThreadLock(thread));
		} catch (error) {
			rmSync(tempDir, { recursive: true, force: true });
			throw error;
		}
		let child: ChildProcess;
		try {
			child = spawn(invocation.command, invocation.args, {
				cwd: thread.cwd,
				env: childEnvironment(),
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			releaseThreadLock(lockFile, lockToken);
			rmSync(tempDir, { recursive: true, force: true });
			throw error;
		}
		const record: RunningPrompt = {
			child,
			threadId: thread.id,
			tempDir,
			lockFile,
			lockToken,
			stdoutBuffer: "",
			stderr: "",
			diagramCalls: new Map(),
			settled: false,
			closePromise,
			resolveClose,
		};
		record.timeoutHandle = setTimeout(() => {
			if (record.stopReason) return;
			record.stopReason = "timeout";
			child.kill("SIGTERM");
			record.killHandle = setTimeout(() => child.kill("SIGKILL"), FORCE_KILL_AFTER_MS);
			record.killHandle.unref?.();
		}, RUN_TIMEOUT_MS);
		record.timeoutHandle.unref?.();
		running.set(thread.id, record);

		thread.status = "running";
		thread.currentPrompt = queued.prompt;
		thread.pid = child.pid;
		thread.updatedAt = Date.now();
		thread.lastError = undefined;
		save();
		updateStatus();
		refreshOverlays();

		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: Buffer | string) => {
			record.stdoutBuffer += chunk.toString();
			const lines = record.stdoutBuffer.split("\n");
			record.stdoutBuffer = lines.pop() ?? "";
			for (const line of lines) processJsonLine(record, line);
			if (Buffer.byteLength(record.stdoutBuffer, "utf8") > MAX_JSON_EVENT_BYTES) {
				record.spawnError = `Child stdout contained an unterminated JSON event larger than ${MAX_JSON_EVENT_BYTES} bytes.`;
				terminateFailedRecord(record);
			}
		});
		child.stderr?.on("data", (chunk: Buffer | string) => {
			record.stderr = appendTail(record.stderr, chunk.toString(), MAX_STDERR_BYTES);
		});
		child.on("error", (error) => {
			record.spawnError = error.message;
		});
		child.on("close", (code, signal) => {
			if (record.stdoutBuffer.trim()) processJsonLine(record, record.stdoutBuffer);
			finalizeProcess(record, code, signal);
		});
		try {
			updateThreadLockChild(lockFile, lockToken, child.pid);
		} catch (error) {
			record.spawnError = errorMessage(error);
			terminateFailedRecord(record);
		}
	};

	async function pump(): Promise<void> {
		if (disposed || pumping) return;
		pumping = true;
		try {
			for (const thread of registry.threads) {
				if (running.size >= MAX_CONCURRENT_THREADS) break;
				if (running.has(thread.id) || thread.status !== "queued" || thread.queue.length === 0) continue;
				const queued = thread.queue.shift();
				if (!queued) continue;
				try {
					startPrompt(thread, queued);
				} catch (error) {
					thread.queue.unshift(queued);
					thread.status = "failed";
					thread.currentPrompt = undefined;
					thread.pid = undefined;
					thread.lastError = errorMessage(error);
					thread.updatedAt = Date.now();
					save();
					activeCtx?.ui.notify(`Could not start side thread ${thread.id}: ${oneLine(thread.lastError, 120)}`, "error");
				}
			}
		} finally {
			pumping = false;
			updateStatus();
			refreshOverlays();
		}
	}

	const enqueuePrompt = (thread: ForkThread, prompt: string) => {
		thread.queue.push({ prompt, enqueuedAt: Date.now() });
		thread.promptCount += 1;
		thread.lastQuestion = prompt;
		thread.updatedAt = Date.now();
		if (thread.status !== "running" && thread.status !== "stopping") thread.status = "queued";
		registry.lastThreadId = thread.id;
		save();
		updateStatus();
		refreshOverlays();
		void pump();
	};

	function queueFollowUp(thread: ForkThread, prompt: string): boolean {
		if (thread.status === "orphaned" && thread.pid && isPidAlive(thread.pid)) {
			throw new Error(`Side thread ${thread.id} still has an orphaned child process. Stop it before continuing.`);
		}
		if (thread.status === "orphaned") {
			thread.pid = undefined;
			thread.status = "interrupted";
		}
		if (!running.has(thread.id) && !clearStaleThreadLock(thread)) {
			throw new Error(`Side thread ${thread.id} is still protected by a live or unverified lock.`);
		}
		if (!existsSync(thread.sessionFile)) throw new Error(`Side-thread session file is missing: ${thread.sessionFile}`);
		const queued = running.has(thread.id) || thread.status === "running" || thread.status === "stopping" || thread.queue.length > 0;
		enqueuePrompt(thread, prompt);
		return queued;
	}

	const stopRecord = (record: RunningPrompt, reason: "user" | "shutdown") => {
		if (record.stopReason) return;
		record.stopReason = reason;
		cancelDiagramRender(record.threadId);
		if (record.timeoutHandle) {
			clearTimeout(record.timeoutHandle);
			record.timeoutHandle = undefined;
		}
		const thread = findThread(record.threadId);
		if (thread) {
			thread.status = "stopping";
			if (reason === "user") thread.queue = [];
			thread.updatedAt = Date.now();
			save();
		}
		refreshOverlays();
		record.child.kill("SIGTERM");
		record.killHandle = setTimeout(() => record.child.kill("SIGKILL"), FORCE_KILL_AFTER_MS);
		record.killHandle.unref?.();
	};

	const stopAll = async () => {
		const records = [...running.values()];
		for (const record of records) stopRecord(record, "shutdown");
		await Promise.all(records.map((record) => record.closePromise));
	};

	const createNewThread = async (question: string, ctx: ExtensionCommandContext): Promise<ForkThread> => {
		if (!ctx.isIdle()) ctx.ui.notify("The side question will start after the current main-thread work settles.", "info");
		await ctx.waitForIdle();
		if (disposed) throw new Error("The Pi session shut down before the fork could start.");

		const id = `f${registry.counter + 1}`;
		const snapshot = createForkSnapshot(ctx, id, question);
		registry.counter += 1;
		const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
		let thinkingLevel = ctx.thinkingLevel ?? "off";
		if (snapshot.removedUnsafeThinking && modelUsesAnthropicMessages(ctx)) thinkingLevel = "off";
		const now = Date.now();
		const thread: ForkThread = {
			id,
			sessionFile: snapshot.sessionFile,
			...(snapshot.childSessionId ? { childSessionId: snapshot.childSessionId } : {}),
			markerEntryId: snapshot.markerEntryId,
			parentSessionFile: ctx.sessionManager.getSessionFile()!,
			cwd: ctx.cwd,
			createdAt: now,
			updatedAt: now,
			status: "queued",
			...(model ? { model } : {}),
			thinkingLevel,
			projectTrusted: ctx.isProjectTrusted(),
			promptCount: 0,
			queue: [],
			lastQuestion: question,
		};
		registry.threads.push(thread);
		registry.lastThreadId = id;
		answerCache.delete(id);
		conversationCache.delete(id);
		enqueuePrompt(thread, question);
		return thread;
	};

	pi.registerEntryRenderer<DisplayEntryData>(ENTRY_TYPE, (entry, { expanded }, theme) => {
		const data = entry.data ?? { title: "Side thread", body: "", timestamp: Date.now() };
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(theme.fg("accent", theme.bold(data.title)), 0, 0));
		box.addChild(new Text(data.body, 0, 0));
		if (expanded && data.details) box.addChild(new Text(theme.fg("dim", data.details), 0, 0));
		return box;
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") {
			disposed = true;
			activeCtx = undefined;
			return;
		}
		disposed = false;
		activeCtx = ctx;
		const parentSessionId = ctx.sessionManager.getSessionId();
		const parentSessionFile = ctx.sessionManager.getSessionFile();
		registryPath = statePathFor(parentSessionId);
		try {
			runtimeLease = acquireRuntimeLease(registryPath);
			registry = loadRegistry(registryPath, parentSessionId, parentSessionFile);
		} catch (error) {
			releaseRuntimeLease(runtimeLease);
			runtimeLease = undefined;
			disposed = true;
			registryPath = undefined;
			ctx.ui.notify(errorMessage(error), "error");
			return;
		}
		answerCache.clear();
		conversationCache.clear();
		diagramStates.clear();
		for (const threadId of [...diagramRenderJobs.keys()]) cancelDiagramRender(threadId);
		for (const threadId of new Set([...diagramViewportJobs.keys(), ...diagramViewportTimers.keys()])) cancelDiagramViewport(threadId);
		reconcileLoadedThreads(registry);
		save();
		updateStatus();
		void pump();
	});

	pi.on("session_shutdown", async () => {
		disposed = true;
		for (const threadId of [...diagramRenderJobs.keys()]) cancelDiagramRender(threadId);
		for (const threadId of new Set([...diagramViewportJobs.keys(), ...diagramViewportTimers.keys()])) cancelDiagramViewport(threadId);
		await stopAll();
		activeCtx?.ui.setStatus(EXTENSION_ID, undefined);
		activeCtx = undefined;
		overlayListeners.clear();
		diagramStates.clear();
		save();
		releaseRuntimeLease(runtimeLease);
		runtimeLease = undefined;
	});

	pi.registerCommand("btw", {
		description: "Ask a side question without adding it to the main conversation; omit text to browse answers",
		handler: async (args, ctx) => {
			let question = args.trim();
			if (!question && registry.threads.length > 0) {
				await openBtwOverlay(ctx, registry.lastThreadId);
				return;
			}
			if (!question && ctx.mode === "tui") {
				question = (await ctx.ui.input("Ask a side question", "This will not enter the main conversation"))?.trim() ?? "";
			}
			if (!question) {
				ctx.ui.notify("Usage: /btw <question>", "error");
				return;
			}
			try {
				const thread = await createNewThread(question, ctx);
				ctx.ui.notify(`Started BTW ${thread.id}. Press Esc to leave its overlay while it keeps running.`, "info");
				if (ctx.mode === "tui") await openBtwOverlay(ctx, thread.id);
			} catch (error) {
				ctx.ui.notify(`Could not start the side question: ${errorMessage(error)}`, "error");
			}
		},
	});

	pi.registerCommand("fork-ask", {
		description: "Fork this session and ask a read-only question in the background",
		handler: async (args, ctx) => {
			let question = args.trim();
			if (!question && ctx.hasUI) question = (await ctx.ui.input("Ask a side thread", "Question about this session"))?.trim() ?? "";
			if (!question) {
				ctx.ui.notify("Usage: /fork-ask <question>", "error");
				return;
			}
			try {
				const thread = await createNewThread(question, ctx);
				ctx.ui.notify(`Started side thread ${thread.id}. The main conversation is unchanged.`, "info");
			} catch (error) {
				ctx.ui.notify(`Could not fork the session: ${errorMessage(error)}`, "error");
			}
		},
	});

	pi.registerCommand("fork-continue", {
		description: "Ask a follow-up in an existing background side thread",
		getArgumentCompletions: (prefix) => threadCompletions(registry, prefix),
		handler: async (args, ctx) => {
			const match = args.trim().match(/^(\S+)\s+([\s\S]+)$/);
			if (!match) {
				ctx.ui.notify("Usage: /fork-continue <id> <follow-up>", "error");
				return;
			}
			const [, id, prompt] = match;
			const thread = findThread(id);
			if (!thread) {
				ctx.ui.notify(`Unknown side thread: ${id}`, "error");
				return;
			}
			try {
				const queued = queueFollowUp(thread, prompt.trim());
				ctx.ui.notify(queued ? `Queued a follow-up for ${id}.` : `Continuing side thread ${id} in the background.`, "info");
			} catch (error) {
				ctx.ui.notify(`Could not continue ${id}: ${errorMessage(error)}`, "error");
			}
		},
	});

	pi.registerCommand("forks", {
		description: "List background side threads for this session",
		handler: async (_args, ctx) => {
			if (registry.threads.length === 0) {
				showEntry("Side threads", "No side threads yet. Start one with /fork-ask <question>.");
				return;
			}
			const body = registry.threads
				.slice()
				.reverse()
				.map((thread) => {
					const queue = thread.queue.length ? ` · ${thread.queue.length} queued` : "";
					const model = thread.model ? ` · ${thread.model}` : "";
					return `${thread.id.padEnd(4)} ${thread.status}${queue}${model}\n     ${oneLine(thread.lastQuestion, 100)}`;
				})
				.join("\n\n");
			showEntry("Side threads", body, "Use /fork-show <id>, /fork-continue <id> <question>, or /fork-stop <id>.");
			ctx.ui.notify(`${registry.threads.length} side thread${registry.threads.length === 1 ? "" : "s"}.`, "info");
		},
	});

	pi.registerCommand("fork-show", {
		description: "Show the latest answer from a background side thread",
		getArgumentCompletions: (prefix) => threadCompletions(registry, prefix),
		handler: async (args, ctx) => {
			const id = args.trim() || registry.lastThreadId;
			const thread = findThread(id);
			if (!thread) {
				ctx.ui.notify(id ? `Unknown side thread: ${id}` : "No side thread selected.", "error");
				return;
			}
			const answer = answerFor(thread);
			const body = answer
				? answer
				: thread.lastError
					? `No answer is available.\n\nError: ${thread.lastError}`
					: `No completed answer yet. Current status: ${thread.status}.`;
			showEntry(
				`Side thread ${thread.id} · ${thread.status}`,
				body,
				`Question: ${thread.lastQuestion}\nSession file: ${thread.sessionFile}\nTerminal: pi --session ${shellQuote(thread.sessionFile)} ${READ_ONLY_CLI_FLAGS}`,
			);
		},
	});

	pi.registerCommand("fork-terminal", {
		description: "Show a terminal command to create a new fork or open an existing side thread",
		getArgumentCompletions: (prefix) => threadCompletions(registry, prefix),
		handler: async (args, ctx) => {
			const id = args.trim();
			if (id) {
				const thread = findThread(id);
				if (!thread) {
					ctx.ui.notify(`Unknown side thread: ${id}`, "error");
					return;
				}
				if (["running", "queued", "stopping", "orphaned"].includes(thread.status)) {
					ctx.ui.notify(`Stop side thread ${thread.id} before opening its session in another terminal.`, "error");
					return;
				}
				showEntry(
					`Open side thread ${thread.id} in another terminal`,
					`pi --session ${shellQuote(thread.sessionFile)} ${READ_ONLY_CLI_FLAGS}`,
					"Read-only by default. Remove the tool flags only if you intentionally want this terminal fork to modify files.",
				);
				return;
			}
			if (!ctx.isIdle()) ctx.ui.notify("Waiting for the current turn to settle before showing a fork command.", "info");
			await ctx.waitForIdle();
			const parentSessionFile = ctx.sessionManager.getSessionFile();
			if (!parentSessionFile) {
				ctx.ui.notify("The current session is not persisted yet.", "error");
				return;
			}
			showEntry(
				"Fork the current session in another terminal",
				`pi --fork ${shellQuote(parentSessionFile)} ${READ_ONLY_CLI_FLAGS}`,
				"Read-only by default. Remove the tool flags only if you intentionally want this terminal fork to modify files.",
			);
		},
	});

	pi.registerCommand("fork-stop", {
		description: "Stop a running background side thread and discard queued follow-ups",
		getArgumentCompletions: (prefix) => threadCompletions(registry, prefix),
		handler: async (args, ctx) => {
			const id = args.trim() || registry.lastThreadId;
			const thread = findThread(id);
			if (!thread) {
				ctx.ui.notify(id ? `Unknown side thread: ${id}` : "No side thread selected.", "error");
				return;
			}
			const record = running.get(thread.id);
			if (record) {
				stopRecord(record, "user");
				ctx.ui.notify(`Stopping side thread ${thread.id}…`, "info");
				return;
			}
			if (thread.status === "orphaned" && thread.pid) {
				const pid = thread.pid;
				if (!isPidAlive(pid)) {
					thread.status = "stopped";
					thread.queue = [];
					thread.pid = undefined;
					clearStaleThreadLock(thread);
					thread.lastError = "The orphaned child had already exited.";
					thread.updatedAt = Date.now();
					save();
					refreshOverlays();
					ctx.ui.notify(`Side thread ${thread.id} was already stopped.`, "info");
					return;
				}
				if (process.platform === "win32") {
					ctx.ui.notify(`Cannot safely verify orphan PID ${pid} on Windows. End that process manually, then run /fork-stop ${thread.id} again.`, "error");
					return;
				}
				if (!looksLikeOurChild(pid, thread.sessionFile)) {
					ctx.ui.notify(`Refusing to kill PID ${pid}: it no longer looks like the side-thread child.`, "error");
					return;
				}
				try {
					thread.status = "stopping";
					thread.queue = [];
					thread.updatedAt = Date.now();
					save();
					refreshOverlays();
					process.kill(pid, "SIGTERM");
					let exited = await waitForPidExit(pid, FORCE_KILL_AFTER_MS);
					if (!exited) {
						process.kill(pid, "SIGKILL");
						exited = await waitForPidExit(pid, 2_000);
					}
					if (!exited) {
						thread.status = "orphaned";
						thread.lastError = `PID ${pid} did not exit; continuation remains blocked.`;
						ctx.ui.notify(`Could not confirm that side thread ${thread.id} stopped.`, "error");
					} else {
						thread.status = "stopped";
						thread.pid = undefined;
						clearStaleThreadLock(thread);
						thread.lastError = "Stopped orphaned child process by user request.";
						ctx.ui.notify(`Stopped orphaned side thread ${thread.id}.`, "info");
					}
					thread.updatedAt = Date.now();
					save();
					updateStatus();
					refreshOverlays();
				} catch (error) {
					thread.status = "orphaned";
					thread.lastError = `Could not stop PID ${pid}: ${errorMessage(error)}`;
					thread.updatedAt = Date.now();
					save();
					refreshOverlays();
					ctx.ui.notify(`Could not stop ${thread.id}: ${errorMessage(error)}`, "error");
				}
				return;
			}
			if (thread.status === "queued") {
				thread.queue = [];
				thread.status = "stopped";
				thread.updatedAt = Date.now();
				save();
				updateStatus();
				ctx.ui.notify(`Stopped queued side thread ${thread.id}.`, "info");
				return;
			}
			if (["interrupted", "failed", "stopped"].includes(thread.status) && existsSync(threadLockPath(thread.sessionFile))) {
				if (!clearStaleThreadLock(thread)) {
					ctx.ui.notify(`The lock for side thread ${thread.id} is still live or cannot be verified.`, "error");
					return;
				}
				thread.queue = [];
				thread.status = "stopped";
				thread.updatedAt = Date.now();
				save();
				updateStatus();
				ctx.ui.notify(`Cleared the stale lock for side thread ${thread.id}.`, "info");
				return;
			}
			ctx.ui.notify(`Side thread ${thread.id} is ${thread.status}; nothing is running.`, "info");
		},
	});
}
