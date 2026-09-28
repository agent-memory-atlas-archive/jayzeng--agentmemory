#!/usr/bin/env node
/**
 * agent-memory CLI
 *
 * Subcommands:
 *   version    — Print binary version
 *   install-skills — Install (or --uninstall) SKILL.md files into local agent directories
 *   context    — Build & print context injection string to stdout
 *   write      — Write to memory files
 *   read       — Read memory files
 *   scratchpad — Manage checklist
 *   search     — Search via qmd
 *   init       — Create dirs, detect qmd, setup collection
 *   status     — Show config, qmd status, file counts
 *
 * Global flags:
 *   --dir <path>   Override memory directory
 *   --json         Machine-readable JSON output
 */

import * as fs from "node:fs";

import { type CaptureCheck, checkCaptureTranscript } from "./capture-check.js";
import {
	_setBaseDir,
	buildMemoryContext,
	checkCollection,
	dailyPath,
	detectQmd,
	distilMemories,
	ensureDirs,
	ensureQmdAvailableForSync,
	ensureQmdAvailableForUpdate,
	getCollectionName,
	getDailyDir,
	getMemoryDir,
	getMemoryFile,
	getQmdEmbedMode,
	getQmdHealth,
	getQmdResultPath,
	getQmdResultText,
	getScratchpadFile,
	getTopicsDir,
	type HookMode,
	installSkills,
	memoryWrite,
	nowTimestamp,
	parseScratchpad,
	probeEmbeddings,
	readFileSafe,
	readHookMode,
	redactSecrets,
	runQmdEmbedDetached,
	runQmdSearch,
	runQmdSync,
	runQmdUpdateNow,
	scheduleQmdUpdate,
	searchRelevantMemories,
	serializeScratchpad,
	setupQmdCollection,
	slugifyTopic,
	todayStr,
	topicPath,
	uninstallSkills,
} from "./core.js";
import { handleCursorCaptureEvent } from "./cursor-capture.js";
import {
	detectHookAgents,
	type HookAgentKey,
	type InstallHooksReport,
	installHooks,
	isHookInstalled,
	isStopHookInstalled,
	isUserPromptSubmitInstalled,
	uninstallHooks,
} from "./hooks.js";

declare const __VERSION__: string;

function readPackageVersion(): string {
	try {
		const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as {
			version?: unknown;
		};
		return typeof packageJson.version === "string" ? packageJson.version : "dev";
	} catch {
		return "dev";
	}
}

const VERSION = typeof __VERSION__ !== "undefined" ? __VERSION__ : readPackageVersion();

// ---------------------------------------------------------------------------
// Arg parsing (no external deps)
// ---------------------------------------------------------------------------

interface ParsedArgs {
	command: string;
	flags: Record<string, string | boolean>;
	positional: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
	const flags: Record<string, string | boolean> = {};
	const positional: string[] = [];
	let command = "";

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];

		if (!command && !arg.startsWith("-")) {
			command = arg;
			continue;
		}

		if (arg.startsWith("--")) {
			const key = arg.slice(2);
			const next = argv[i + 1];
			if (next && !next.startsWith("--")) {
				flags[key] = next;
				i++;
			} else {
				flags[key] = true;
			}
		} else if (!arg.startsWith("-")) {
			positional.push(arg);
		}
	}

	return { command, flags, positional };
}

function getFlag(flags: Record<string, string | boolean>, key: string): string | undefined {
	const val = flags[key];
	return typeof val === "string" ? val : undefined;
}

function hasFlag(flags: Record<string, string | boolean>, key: string): boolean {
	return key in flags;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function output(data: unknown, json: boolean) {
	if (json) {
		console.log(JSON.stringify(data, null, 2));
	} else if (typeof data === "string") {
		console.log(data);
	} else {
		console.log(JSON.stringify(data, null, 2));
	}
}

function exitError(message: string, json: boolean): never {
	if (json) {
		console.error(JSON.stringify({ error: message }));
	} else {
		console.error(`Error: ${message}`);
	}
	process.exit(1);
}

const USE_COLOR = process.stdout.isTTY && process.env.NO_COLOR === undefined && process.env.TERM !== "dumb";
const COLORS = {
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	red: "\x1b[31m",
	cyan: "\x1b[36m",
	reset: "\x1b[0m",
} as const;
function colorize(text: string, color: keyof typeof COLORS): string {
	if (!USE_COLOR) return text;
	return `${COLORS[color]}${text}${COLORS.reset}`;
}
const MARK_OK = colorize("\u2713", "green");
const MARK_FAIL = colorize("\u2717", "red");

async function promptYesNo(question: string, defaultYes: boolean): Promise<boolean> {
	const readline = await import("node:readline/promises");
	const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
	try {
		const answer = (await rl.question(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
		if (!answer) return defaultYes;
		return answer === "y" || answer === "yes";
	} finally {
		rl.close();
	}
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdContext(flags: Record<string, string | boolean>) {
	const json = hasFlag(flags, "json");
	const noSearch = hasFlag(flags, "no-search");
	const query = getFlag(flags, "query") ?? "";

	ensureDirs();
	if (!noSearch && query) await ensureQmdAvailableForSync();
	const searchResults = noSearch ? "" : await searchRelevantMemories(query);
	const context = buildMemoryContext(searchResults);

	if (json) {
		output({ context, directory: getMemoryDir() }, true);
	} else {
		if (context) {
			process.stdout.write(context);
		}
	}
}

// ---------------------------------------------------------------------------
// Hook runtime handlers (invoked by installed SessionStart/UserPromptSubmit/
// Stop hooks — see hooks.ts for the installers that wire these commands into
// each agent's config).
// ---------------------------------------------------------------------------

/**
 * Read stdin (up to 1 MB) as JSON. Returns null on non-TTY stdin, oversized
 * payload, or JSON parse errors — the caller emits empty stdout in those
 * cases so a malformed harness hook payload never poisons the conversation.
 */
async function readStdinJson<T = Record<string, unknown>>(): Promise<T | null> {
	if (process.stdin.isTTY) return null;
	const chunks: Buffer[] = [];
	let total = 0;
	try {
		for await (const chunk of process.stdin) {
			const buffer = chunk instanceof Buffer ? chunk : Buffer.from(chunk as string);
			total += buffer.length;
			if (total > 1_000_000) return null;
			chunks.push(buffer);
		}
		const text = Buffer.concat(chunks).toString("utf-8").trim();
		if (!text) return null;
		return JSON.parse(text) as T;
	} catch {
		return null;
	}
}

/**
 * Sanitize a user prompt into a search query. Mirrors the discipline in
 * `searchRelevantMemories`: strip control chars, cap length. Never throws.
 */
function sanitizePromptQuery(prompt: unknown): string {
	if (typeof prompt !== "string") return "";
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally stripping control chars.
	const stripped = prompt.replace(/[\x00-\x1f\x7f]/g, " ");
	return stripped.trim().slice(0, 200);
}

/**
 * UserPromptSubmit hook handler — fires on every user prompt in per-turn mode.
 * Reads the harness's JSON payload from stdin and emits fresh context (daily
 * logs + qmd search against the prompt text). Silently degrades to empty
 * stdout on any failure or timeout so a broken install never blocks the user.
 */
async function cmdUserPromptSubmit(_flags: Record<string, string | boolean>): Promise<void> {
	const TIMEOUT_MS = 3_000;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, TIMEOUT_MS);
	});

	const work = (async () => {
		const payload = await readStdinJson<{ user_input?: unknown; prompt?: unknown }>();
		if (!payload) return;
		const query = sanitizePromptQuery(payload.user_input ?? payload.prompt);
		ensureDirs();
		if (query) await ensureQmdAvailableForSync();
		const searchResults = query ? await searchRelevantMemories(query) : "";
		const context = buildMemoryContext(searchResults);
		if (context) process.stdout.write(context);
	})().catch(() => {
		// Any failure in the per-turn hook must be swallowed — never emit an
		// error message that would leak into the harness's context.
	});

	await Promise.race([work, timeout]);
	if (timer) clearTimeout(timer);
}

// How many Stop events must elapse (per session_id) before the periodic
// memory-write nudge fires again. Balances "long sessions get checked
// repeatedly" against "don't block every single turn".
const STOP_NAG_INTERVAL: Record<"claude" | "codex" | "qoder", number> = { claude: 6, codex: 6, qoder: 6 };
function nagKey(agent: string): "claude" | "codex" | "qoder" {
	return agent === "codex" || agent === "qoder" ? agent : "claude";
}
function nagInterval(agent: string): number {
	return STOP_NAG_INTERVAL[nagKey(agent)];
}
// Bound state/stop-hook.json so it can't grow unboundedly across many sessions.
const STOP_HOOK_MAX_SESSIONS = 50;

interface StopHookSessionState {
	lastCaptureSignal?: string;
	count: number;
	lastNagCount: number;
	lastSeenAt: number;
}

interface StopHookState {
	sessions: Record<string, StopHookSessionState>;
}

function stopHookStatePath(): string {
	return `${getMemoryDir()}/state/stop-hook.json`;
}

function readStopHookState(): StopHookState {
	try {
		const raw = fs.readFileSync(stopHookStatePath(), "utf-8");
		const parsed = JSON.parse(raw) as Partial<StopHookState>;
		return { sessions: parsed.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {} };
	} catch {
		return { sessions: {} };
	}
}

function writeStopHookState(state: StopHookState): void {
	const entries = Object.entries(state.sessions).sort((a, b) => b[1].lastSeenAt - a[1].lastSeenAt);
	const pruned = Object.fromEntries(entries.slice(0, STOP_HOOK_MAX_SESSIONS));
	const stateDir = `${getMemoryDir()}/state`;
	fs.mkdirSync(stateDir, { recursive: true });
	fs.writeFileSync(stopHookStatePath(), `${JSON.stringify({ sessions: pruned }, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Bump the Stop-event counter for `sessionId` and report whether the
 * periodic memory-write nudge should fire this time. Never throws — a
 * corrupt or unwritable state file just means the nudge falls back to
 * "never fires" rather than breaking the Stop hook.
 */
function shouldNagOnStop(agent: string, sessionId: string, now: number, capture: CaptureCheck | null): boolean {
	try {
		const state = readStopHookState();
		// Namespaced by agent: session_id is a per-host random UUID, but sharing one
		// bounded LRU across both hosts unnamespaced would let one host's writes
		// evict or collide with the other's nag/capture state.
		const key = `${nagKey(agent)}:${sessionId}`;
		const interval = nagInterval(agent);
		const existing = state.sessions[key] ?? { count: 0, lastNagCount: 0, lastSeenAt: now };
		const count = existing.count + 1;
		const shouldNag = capture
			? !!capture.pendingSignal &&
				(capture.pendingSignal !== existing.lastCaptureSignal || count - existing.lastNagCount >= interval)
			: count - existing.lastNagCount >= interval;
		state.sessions[key] = {
			lastCaptureSignal: capture?.pendingSignal,
			count,
			lastNagCount: shouldNag ? count : existing.lastNagCount,
			lastSeenAt: now,
		};
		writeStopHookState(state);
		return shouldNag;
	} catch {
		return false;
	}
}

const STOP_NAG_REASON =
	"Before stopping: if this session produced a durable fact, bug fix, or decision worth remembering, " +
	'capture it now — `agent-memory write --content "..."` for a daily note, or `--target long_term` for a ' +
	"durable fact — and update the scratchpad with any open follow-ups. If there's nothing worth recording, " +
	"ignore this and stop normally.";

/** Cursor's documented event hooks provide enough structured evidence to avoid transcript parsing. */
async function cmdCursorEvent(): Promise<void> {
	const TIMEOUT_MS = 3_000;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, TIMEOUT_MS);
	});

	const work = (async () => {
		const payload = await readStdinJson<Record<string, unknown>>();
		const result = handleCursorCaptureEvent(payload);
		if (payload?.hook_event_name === "stop" && result.shouldFollowup) {
			// This write can land after the caller has already timed out on us (see
			// the Promise.race below) and stopped reading — swallow a resulting
			// EPIPE instead of letting it surface as an uncaught stream error, same
			// as cmdStop's stdout write.
			process.stdout.once("error", () => {});
			process.stdout.write(JSON.stringify({ followup_message: STOP_NAG_REASON }));
		}
	})().catch(() => {
		// Any failure in the Cursor event hook must be swallowed — never trap the
		// user in a stuck session or emit a message that would corrupt the
		// harness's stdout contract.
	});

	await Promise.race([work, timeout]);
	if (timer) clearTimeout(timer);
}

/**
 * Stop hook handler — fires at the end of every assistant turn (not once per
 * session). Checks explicit remember requests and completed edits immediately
 * when transcript evidence is available. A completed memory write clears the
 * pending check; unchanged work is retried only every STOP_NAG_INTERVAL turns.
 * Claude emits `hookSpecificOutput.additionalContext`; Codex emits its native
 * `decision: "block"` plus a non-empty `reason`; Qoder blocks with exit code 2
 * and writes the reason to stderr. All honor `stop_hook_active` re-entry
 * protection and fail open on errors.
 */
async function cmdStop(flags: Record<string, string | boolean>): Promise<void> {
	const TIMEOUT_MS = 3_000;
	const agent = getFlag(flags, "agent");
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, TIMEOUT_MS);
	});

	const work = (async () => {
		const payload = await readStdinJson<{
			session_id?: unknown;
			stop_hook_active?: unknown;
			transcript_path?: unknown;
		}>();
		const sessionId = typeof payload?.session_id === "string" ? payload.session_id : "";
		if (!sessionId || payload?.stop_hook_active === true) return;
		const capture = checkCaptureTranscript(payload?.transcript_path, sessionId);
		if (shouldNagOnStop(agent ?? "claude", sessionId, Date.now(), capture)) {
			if (agent === "qoder") {
				// This write can land after the caller has already timed out on us (see
				// the Promise.race below) and stopped reading — swallow a resulting
				// EPIPE instead of letting it surface as an uncaught stream error, same
				// as the stdout write below for Claude/Codex.
				process.stderr.once("error", () => {});
				process.stderr.write(`${STOP_NAG_REASON}\n`);
				process.exitCode = 2;
				return;
			}
			const response =
				agent === "codex"
					? { decision: "block", reason: STOP_NAG_REASON }
					: { hookSpecificOutput: { hookEventName: "Stop", additionalContext: STOP_NAG_REASON } };
			// This write can land after the caller has already timed out on us (see
			// the Promise.race below) and stopped reading — swallow a resulting
			// EPIPE instead of letting it surface as an uncaught stream error.
			process.stdout.once("error", () => {});
			process.stdout.write(JSON.stringify(response));
		}
	})().catch(() => {
		// Any failure in the Stop hook must be swallowed — never trap the user
		// in a stuck session over a broken memory-write nudge.
	});

	await Promise.race([work, timeout]);
	if (timer) clearTimeout(timer);
}

async function cmdWrite(flags: Record<string, string | boolean>) {
	const json = hasFlag(flags, "json");
	const target = getFlag(flags, "target") ?? "daily";
	const content = getFlag(flags, "content");
	const mode = getFlag(flags, "mode") ?? "append";
	const topic = getFlag(flags, "topic");
	const date = getFlag(flags, "date");
	const sourceUri = getFlag(flags, "source-uri");

	if (!["long_term", "daily", "topic"].includes(target)) {
		exitError("--target must be 'long_term', 'daily', or 'topic' (default: daily)", json);
	}
	if (!["append", "overwrite"].includes(mode)) {
		exitError("--mode must be 'append' or 'overwrite'", json);
	}
	if (!content) {
		exitError("--content is required", json);
	}

	const result = await memoryWrite({
		target: target as "long_term" | "daily" | "topic",
		content,
		mode: mode as "append" | "overwrite",
		sessionId: "cli",
		topic,
		date,
		sourceUri,
	});
	if (result.isError) exitError(result.text.replace(/^Error:\s*/, ""), json);
	output(json ? { ok: true, ...result.details } : result.text.split("\n\n", 1)[0], json);
}

async function cmdRead(flags: Record<string, string | boolean>) {
	const json = hasFlag(flags, "json");
	const target = getFlag(flags, "target");
	const date = getFlag(flags, "date");
	const topic = getFlag(flags, "topic");

	if (!target || !["long_term", "scratchpad", "daily", "list", "topic", "topics"].includes(target)) {
		exitError("--target must be 'long_term', 'scratchpad', 'daily', 'list', 'topic', or 'topics'", json);
	}

	ensureDirs();

	if (target === "list") {
		try {
			const files = fs
				.readdirSync(getDailyDir())
				.filter((f) => f.endsWith(".md"))
				.sort()
				.reverse();
			if (json) {
				output({ files }, true);
			} else if (files.length === 0) {
				console.log("No daily logs found.");
			} else {
				console.log(`Daily logs:\n${files.map((f) => `- ${f}`).join("\n")}`);
			}
		} catch {
			output(json ? { files: [] } : "No daily logs directory.", json);
		}
		return;
	}

	if (target === "daily") {
		const d = date ?? todayStr();
		const filePath = dailyPath(d);
		const content = readFileSafe(filePath);
		if (!content) {
			output(json ? { content: null, date: d } : `No daily log for ${d}.`, json);
			return;
		}
		output(json ? { content, date: d, path: filePath } : content, json);
		return;
	}

	if (target === "topics") {
		try {
			const files = fs
				.readdirSync(getTopicsDir())
				.filter((f) => f.endsWith(".md"))
				.sort()
				.reverse();
			if (json) {
				output({ files }, true);
			} else if (files.length === 0) {
				console.log("No topics found.");
			} else {
				console.log(`Topics:\n${files.map((f) => `- ${f}`).join("\n")}`);
			}
		} catch {
			output(json ? { files: [] } : "No topics directory.", json);
		}
		return;
	}

	if (target === "topic") {
		if (!topic) {
			exitError("--topic is required when --target is 'topic'", json);
		}
		const slug = slugifyTopic(topic);
		const filePath = topicPath(slug);
		const content = readFileSafe(filePath);
		if (!content) {
			output(json ? { content: null, topic } : `No topic file found for ${topic}.`, json);
			return;
		}
		output(json ? { content, topic, slug, path: filePath } : content, json);
		return;
	}

	if (target === "scratchpad") {
		const content = readFileSafe(getScratchpadFile());
		if (!content?.trim()) {
			output(json ? { content: null } : "SCRATCHPAD.md is empty or does not exist.", json);
			return;
		}
		output(json ? { content, path: getScratchpadFile() } : content, json);
		return;
	}

	// long_term
	const content = readFileSafe(getMemoryFile());
	if (!content) {
		output(json ? { content: null } : "MEMORY.md is empty or does not exist.", json);
		return;
	}
	output(json ? { content, path: getMemoryFile() } : content, json);
}

async function cmdScratchpad(flags: Record<string, string | boolean>, positional: string[]) {
	const json = hasFlag(flags, "json");
	const action = positional[0];
	const text = getFlag(flags, "text");

	if (!action || !["add", "done", "undo", "clear_done", "list"].includes(action)) {
		exitError("Usage: agent-memory scratchpad <add|done|undo|clear_done|list> [--text <text>]", json);
	}

	ensureDirs();
	const spFile = getScratchpadFile();
	const existing = readFileSafe(spFile) ?? "";
	let items = parseScratchpad(existing).map((item) => ({
		...item,
		text: redactSecrets(item.text).content,
		meta: redactSecrets(item.meta).content,
	}));

	if (action === "list") {
		if (items.length === 0) {
			output(json ? { items: [], count: 0, open: 0 } : "Scratchpad is empty.", json);
			return;
		}
		if (json) {
			output(
				{
					items: items.map((i) => ({ done: i.done, text: i.text })),
					count: items.length,
					open: items.filter((i) => !i.done).length,
				},
				true,
			);
		} else {
			console.log(serializeScratchpad(items));
		}
		return;
	}

	if (action === "add") {
		if (!text) exitError("--text is required for add", json);
		const ts = nowTimestamp();
		const safeText = redactSecrets(text!).content;
		items.push({ done: false, text: safeText, meta: `<!-- ${ts} [cli] -->` });
		fs.writeFileSync(spFile, serializeScratchpad(items), "utf-8");
		await ensureQmdAvailableForUpdate();
		scheduleQmdUpdate();
		output(json ? { ok: true, action, text: safeText } : `Added: - [ ] ${safeText}`, json);
		return;
	}

	if (action === "done" || action === "undo") {
		if (!text) exitError(`--text is required for ${action}`, json);
		const needle = text!.toLowerCase();
		const targetDone = action === "done";
		let matched = false;
		for (const item of items) {
			if (item.done !== targetDone && item.text.toLowerCase().includes(needle)) {
				item.done = targetDone;
				matched = true;
				break;
			}
		}
		if (!matched) {
			exitError(`No matching ${targetDone ? "open" : "done"} item found for: "${text}"`, json);
		}
		fs.writeFileSync(spFile, serializeScratchpad(items), "utf-8");
		await ensureQmdAvailableForUpdate();
		scheduleQmdUpdate();
		output(json ? { ok: true, action, text } : "Updated.", json);
		return;
	}

	if (action === "clear_done") {
		const before = items.length;
		items = items.filter((i) => !i.done);
		const removed = before - items.length;
		fs.writeFileSync(spFile, serializeScratchpad(items), "utf-8");
		await ensureQmdAvailableForUpdate();
		scheduleQmdUpdate();
		output(json ? { ok: true, action, removed } : `Cleared ${removed} done item(s).`, json);
	}
}

async function cmdSearch(flags: Record<string, string | boolean>) {
	const json = hasFlag(flags, "json");
	const query = getFlag(flags, "query");
	const mode = (getFlag(flags, "mode") ?? "keyword") as "keyword" | "semantic" | "deep";
	const limit = Number.parseInt(getFlag(flags, "limit") ?? "5", 10);

	if (!query) exitError("--query is required", json);
	if (!["keyword", "semantic", "deep"].includes(mode)) {
		exitError("--mode must be 'keyword', 'semantic', or 'deep'", json);
	}

	const qmdFound = await detectQmd();
	if (!qmdFound) {
		exitError("qmd is not installed. Install: bun install -g https://github.com/tobi/qmd", json);
	}

	const collName = getCollectionName();
	const hasCollection = await checkCollection(collName);
	if (!hasCollection) {
		exitError(`qmd collection '${collName}' not found. Run: agent-memory init`, json);
	}

	try {
		const { results, stderr } = await runQmdSearch(mode, query!, limit);

		if (json) {
			output({ mode, query, count: results.length, results }, true);
			return;
		}

		if (results.length === 0) {
			const needsEmbed = /need embeddings/i.test(stderr ?? "");
			if (needsEmbed && (mode === "semantic" || mode === "deep")) {
				console.log(`No results found. qmd reports missing embeddings — run: qmd embed`);
			} else {
				console.log(`No results found for "${query}" (mode: ${mode}).`);
			}
			return;
		}

		for (let i = 0; i < results.length; i++) {
			const r = results[i];
			const filePath = getQmdResultPath(r);
			const text = getQmdResultText(r);
			console.log(`--- Result ${i + 1} ---`);
			if (filePath) console.log(`File: ${filePath}`);
			if (r.score != null) console.log(`Score: ${r.score}`);
			if (text) console.log(text);
			console.log("");
		}
	} catch (err) {
		exitError(`Search failed: ${err instanceof Error ? err.message : String(err)}`, json);
	}
}

function cmdInstallSkills(flags: Record<string, string | boolean>) {
	const json = hasFlag(flags, "json");
	const uninstall = hasFlag(flags, "uninstall");

	if (uninstall) {
		const report = uninstallSkills();

		if (!report.ok) {
			exitError(report.error ?? "Failed to uninstall skills.", json);
		}

		if (json) {
			output(report, true);
			return;
		}

		for (const item of report.removed) {
			console.log(`Uninstalled ${item.label}: ${item.path}`);
		}
		for (const item of report.skipped) {
			console.log(`Skipping ${item.label} (${item.reason})`);
		}
		if (report.removed.length === 0) {
			console.log("No skills were installed.");
		}
		return;
	}

	const report = installSkills();

	if (!report.ok) {
		exitError(report.error ?? "Failed to install skills.", json);
	}

	if (json) {
		output(report, true);
		return;
	}

	if (report.checked.length > 0) {
		for (const item of report.checked) {
			if (item.status === "detected") {
				console.log(`Detecting ${item.label}... found`);
			} else {
				console.log(`Detecting ${item.label}... not found (${item.reason ?? "unknown"})`);
			}
		}
	} else if (report.detected.length === 0) {
		console.log("No supported agent installations detected.");
	} else {
		const detectedLabels = report.detected.map((item) => item.label).join(", ");
		console.log(`Detected: ${detectedLabels}`);
	}

	if (report.installed.length === 0) {
		console.log("No skills installed.");
	} else {
		for (const item of report.installed) {
			console.log(`Installed ${item.label}: ${item.path}`);
		}
	}

	if (report.skipped.length > 0) {
		for (const item of report.skipped) {
			console.log(`Skipped ${item.label} (${item.reason})`);
		}
	}
}

/**
 * Install the SessionStart (and, in `per-turn` mode, UserPromptSubmit + Stop)
 * hooks that make context injection automatic for every detected agent
 * (Claude Code, Codex, Cursor, opencode, Qoder, and pi via the pi-memory
 * extension). Idempotent — already-installed agents are reported and left
 * untouched. `--only claude,codex` restricts which agents are touched;
 * `--mode stable|per-turn` controls whether UserPromptSubmit is installed;
 * `--yes` (or a non-interactive stdin) skips the confirmation prompt.
 */
async function cmdInstallHooks(flags: Record<string, string | boolean>): Promise<InstallHooksReport | undefined> {
	const json = hasFlag(flags, "json");
	const requested = getFlag(flags, "only");
	const requestedKeys = requested ? new Set(requested.split(",").map((value) => value.trim())) : null;
	// Internal-only signal from cmdSetup: pi's action is a real network package
	// install (`pi install npm:pi-memory`), not a local config-file edit like
	// every other agent here — so setup's internally-manufactured `yes: true`
	// must not cover it. Not a public flag; never documented in usage.
	const deferPi = hasFlag(flags, "_setup-defer-pi");
	const modeFlag = getFlag(flags, "mode");
	if (modeFlag !== undefined && modeFlag !== "stable" && modeFlag !== "per-turn") {
		exitError(`--mode must be 'stable' or 'per-turn' (got ${modeFlag})`, json);
	}
	const mode: HookMode = (modeFlag as HookMode | undefined) ?? readHookMode();
	const { homeDir, targets } = detectHookAgents();
	if (!homeDir) exitError("Home directory not found.", json);
	const eligible = targets.filter((target) => {
		if (!(target.supported && target.detected)) return false;
		if (requestedKeys && !requestedKeys.has(target.key)) return false;
		if (target.key === "pi" && deferPi) return false;
		return true;
	});
	if (!eligible.length) {
		const report: InstallHooksReport = { ok: true, homeDir, results: [] };
		output(json ? report : "No eligible agents. Nothing to install.", json);
		return report;
	}
	// Consider an agent "already installed" only when the wiring matches the requested mode.
	// per-turn requires BOTH SessionStart and UserPromptSubmit; stable requires SessionStart AND
	// no UserPromptSubmit (so a downgrade correctly removes the per-turn hook).
	const isFullyInstalled = (target: (typeof eligible)[number]): boolean => {
		if (!homeDir) return false;
		const session = isHookInstalled(homeDir, target.key);
		if (!session) return false;
		if (target.key !== "claude" && target.key !== "codex") return true; // cursor/opencode/qoder/pi: static only
		const prompt = isUserPromptSubmitInstalled(homeDir, target.key);
		if (mode === "per-turn" ? !prompt : prompt) return false;
		if (target.key === "claude") {
			if (!isStopHookInstalled(homeDir, target.key)) return false;
		}
		return true;
	};
	const alreadyInstalled = eligible.filter(isFullyInstalled);
	const pending = eligible.filter((target) => !alreadyInstalled.includes(target));
	if (!json && alreadyInstalled.length) {
		const labels = alreadyInstalled.map((target) => target.label).join(", ");
		console.log(`Automatic context already active for: ${labels}.`);
	}
	if (!pending.length) {
		const report: InstallHooksReport = {
			ok: true,
			homeDir,
			results: alreadyInstalled.map((target) => ({
				key: target.key,
				label: target.label,
				installed: false,
				reason: "already installed",
				mode,
			})),
		};
		output(json ? report : "Nothing to install.", json);
		return report;
	}
	const selected = new Set<HookAgentKey>();
	const applyAll = hasFlag(flags, "yes") || hasFlag(flags, "all") || !process.stdin.isTTY;
	const hookLabel = mode === "per-turn" ? "SessionStart + UserPromptSubmit hooks" : "SessionStart hook";
	for (const target of pending) {
		// pi gets a real package install (`pi install npm:pi-memory`), not a config-file hook edit —
		// word the prompt accordingly so the confirmation matches what actually happens.
		const question =
			target.key === "pi"
				? `Install pi-memory (native pi extension) for ${target.label}?`
				: `Install ${hookLabel} for ${target.label}?`;
		if (applyAll || (await promptYesNo(question, true))) selected.add(target.key);
	}
	if (!selected.size) {
		const report: InstallHooksReport = { ok: true, homeDir, results: [] };
		output(json ? report : "Nothing selected. Skipped.", json);
		return report;
	}
	const report = installHooks(selected, mode);
	if (!report.ok) exitError(report.error ?? "install failed", json);
	if (json) {
		output(report, true);
		return report;
	}
	for (const result of report.results) {
		console.log(
			result.installed
				? `Installed ${result.label} hook (${result.mode ?? mode}): ${result.path}`
				: `Skipped ${result.label} (${result.reason ?? "unknown"})`,
		);
	}
	return report;
}

/**
 * Remove every SessionStart/UserPromptSubmit/Stop hook agent-memory installed.
 * `--only claude,codex` restricts which agents are touched. Never removes
 * pi-memory itself (that's owned by `pi`'s own package manager) — it just
 * reports whether it's still present so `uninstall` can surface that honestly.
 */
function cmdUninstallHooks(flags: Record<string, string | boolean>): void {
	const json = hasFlag(flags, "json");
	const only = getFlag(flags, "only");
	const agents = only ? (new Set(only.split(",").map((value) => value.trim())) as Set<HookAgentKey>) : undefined;
	const report = uninstallHooks(agents);
	if (!report.ok) exitError(report.error ?? "uninstall failed", json);
	if (json) {
		output(report, true);
		return;
	}
	for (const result of report.results) {
		console.log(
			result.installed
				? `Uninstalled ${result.label}: ${result.path}`
				: `Skipped ${result.label} (${result.reason ?? "unknown"})`,
		);
	}
}

/**
 * One-shot idempotent installer: memory dir + qmd collection, skills for
 * every detected agent, and hooks for every detected agent. Each step is a
 * no-op when the target is already good, so `setup` is safe to re-run after
 * upgrades. `init`, `install-skills`, and `install-hooks` still exist for
 * scripts and finer control, but no one needs them for the happy path.
 */
async function cmdSetup(flags: Record<string, string | boolean>) {
	const json = hasFlag(flags, "json");
	const skipSkills = hasFlag(flags, "skip-skills");
	const skipHooks = hasFlag(flags, "skip-hooks");

	// setup's sub-steps get their console output captured in --json mode so the
	// whole command emits exactly one JSON envelope.
	const subFlags = { yes: true } as Record<string, string | boolean>;
	const steps: Array<{ name: string; ok: boolean; detail?: string }> = [];

	const runQuiet = async <T>(fn: () => Promise<T> | T): Promise<T> => {
		if (!json) return await fn();
		const originalLog = console.log;
		const originalInfo = console.info;
		console.log = () => {};
		console.info = () => {};
		try {
			return await fn();
		} finally {
			console.log = originalLog;
			console.info = originalInfo;
		}
	};

	// Step 1: memory dir + qmd
	try {
		await runQuiet(() => cmdInit(subFlags));
		steps.push({ name: "memory", ok: true, detail: getMemoryDir() });
	} catch (error) {
		steps.push({ name: "memory", ok: false, detail: (error as Error).message });
	}

	// Step 2: skills for detected agents
	if (!skipSkills) {
		try {
			await runQuiet(() => cmdInstallSkills(subFlags));
			steps.push({ name: "skills", ok: true });
		} catch (error) {
			steps.push({ name: "skills", ok: false, detail: (error as Error).message });
		}
	} else {
		steps.push({ name: "skills", ok: true, detail: "skipped" });
	}

	// Step 3: hooks (silent when everything is already installed)
	if (!skipHooks) {
		try {
			const userSuppliedYes = hasFlag(flags, "yes");
			// pi's install is a real network package fetch (`pi install npm:pi-memory`),
			// unlike every other agent here (local config-file edits) — setup's
			// manufactured `yes: true` above must not silently cover that unless the
			// user actually asked for --yes themselves.
			const { homeDir: detectedHomeDir, targets: detectedTargets } = detectHookAgents();
			const piTarget = detectedTargets.find((target) => target.key === "pi");
			const piDetected = Boolean(piTarget?.supported && piTarget?.detected);
			const piAlreadyActive = piDetected && detectedHomeDir ? isHookInstalled(detectedHomeDir, "pi") : false;
			const hooksFlags = userSuppliedYes ? subFlags : { ...subFlags, "_setup-defer-pi": true };
			const report = await runQuiet(() => cmdInstallHooks(hooksFlags));
			const piFailure = report?.results.find(
				(result) =>
					result.key === "pi" && !result.installed && result.reason && result.reason !== "already installed",
			);
			if (piFailure) {
				steps.push({ name: "hooks", ok: false, detail: `pi-memory install failed: ${piFailure.reason}` });
			} else if (piDetected && !piAlreadyActive && !userSuppliedYes) {
				steps.push({
					name: "hooks",
					ok: true,
					detail: "pi-memory deferred — re-run with --yes, or agent-memory install-hooks --only pi",
				});
			} else {
				steps.push({ name: "hooks", ok: true });
			}
		} catch (error) {
			steps.push({ name: "hooks", ok: false, detail: (error as Error).message });
		}
	} else {
		steps.push({ name: "hooks", ok: true, detail: "skipped" });
	}

	if (json) {
		output({ ok: steps.every((step) => step.ok), directory: getMemoryDir(), steps }, true);
		return;
	}

	console.log("");
	console.log(colorize("agent-memory setup", "bold"));
	for (const step of steps) {
		const mark = step.ok ? MARK_OK : MARK_FAIL;
		const detail = step.detail ? colorize(` ${step.detail}`, "dim") : "";
		console.log(`  ${mark} ${step.name}${detail}`);
	}
	console.log("");
	console.log(colorize("Setup complete. Your agents will discover memory automatically next session.", "green"));
	console.log(colorize("Your notes stay in plain Markdown on this device — no account, no upload.", "dim"));
	console.log(colorize('Open your agent and ask: "What do you remember about me?"', "cyan"));
	console.log("");
	console.log("Try it now:");
	console.log(`  ${colorize('agent-memory write --content "your first note"', "cyan")}   — save a note you own`);
	console.log(
		`  ${colorize("agent-memory status", "cyan")}                             — verify everything is healthy`,
	);
	console.log("");
}

/**
 * Reverse of {@link cmdSetup}: removes every install artifact agent-memory
 * creates outside of this package — hooks and skills. Memory data under
 * `getMemoryDir()` (MEMORY.md, daily logs, scratchpad, topics, qmd index) is
 * left untouched unless `--data` is passed, since that's the one step a user
 * can't undo. Destructive by nature, so it always requires either an
 * interactive confirmation or `--yes`.
 */
async function cmdUninstall(flags: Record<string, string | boolean>): Promise<void> {
	const json = hasFlag(flags, "json");
	const yes = hasFlag(flags, "yes");
	const wipeData = hasFlag(flags, "data");
	const interactive = !json && Boolean(process.stdin.isTTY && process.stdout.isTTY);

	if (!yes) {
		const message = wipeData
			? "Re-run with --yes to remove agent-memory's hooks and skills, and permanently delete ~/.agent-memory (MEMORY.md, daily logs, scratchpad, topics, qmd index)."
			: "Re-run with --yes to remove agent-memory's hooks and skills. Your memory data is left untouched.";
		if (interactive) {
			const question = wipeData
				? "This will also permanently delete your memory data (MEMORY.md, daily logs, scratchpad). Continue?"
				: "Remove agent-memory's hooks and skills?";
			if (!(await promptYesNo(question, false))) {
				console.log("Aborted. Nothing was removed.");
				return;
			}
		} else {
			if (json) output({ ok: false, error: { code: "confirmation_required", message } }, true);
			else console.error(`Error: ${message}`);
			process.exitCode = 1;
			return;
		}
	}

	const steps: Array<{ name: string; ok: boolean; detail?: string }> = [];

	try {
		const report = uninstallSkills();
		if (!report.ok) throw new Error(report.error ?? "failed to remove skills");
		steps.push({
			name: "skills",
			ok: true,
			detail: report.removed.length ? `removed ${report.removed.length}` : "not installed",
		});
	} catch (error) {
		steps.push({ name: "skills", ok: false, detail: (error as Error).message });
	}

	try {
		const report = uninstallHooks();
		if (!report.ok) throw new Error(report.error ?? "failed to remove hooks");
		const removed = report.results.filter((r) => r.installed).length;
		// agent-memory never removes pi-memory itself (see hooks.ts's uninstallPiMemoryDelegate)
		// — make that explicit here rather than letting a generic "removed N" detail imply
		// everything is gone.
		const piResult = report.results.find((r) => r.key === "pi");
		const piNote = piResult?.reason?.startsWith("pi-memory left installed") ? `; ${piResult.reason}` : "";
		steps.push({
			name: "hooks",
			ok: true,
			detail: (removed ? `removed ${removed}` : "not installed") + piNote,
		});
	} catch (error) {
		steps.push({ name: "hooks", ok: false, detail: (error as Error).message });
	}

	if (wipeData) {
		try {
			const memoryDir = getMemoryDir();
			if (fs.existsSync(memoryDir)) fs.rmSync(memoryDir, { recursive: true, force: true });
			steps.push({ name: "data", ok: true, detail: memoryDir });
		} catch (error) {
			steps.push({ name: "data", ok: false, detail: (error as Error).message });
		}
	}

	const allOk = steps.every((step) => step.ok);
	if (!allOk) process.exitCode = 1;

	if (json) {
		output({ ok: allOk, data: wipeData, steps }, true);
		return;
	}

	console.log("");
	console.log(colorize("agent-memory uninstall", "bold"));
	for (const step of steps) {
		const mark = step.ok ? MARK_OK : MARK_FAIL;
		const detail = step.detail ? colorize(` ${step.detail}`, "dim") : "";
		console.log(`  ${mark} ${step.name}${detail}`);
	}
	console.log("");
	if (!allOk) {
		console.log(colorize("Some steps failed — see details above.", "yellow"));
	} else if (wipeData) {
		console.log(colorize("agent-memory has been fully removed, including your memory data.", "green"));
	} else {
		console.log(colorize("agent-memory's install artifacts have been removed.", "green"));
		console.log(
			colorize(`Your notes are untouched at ${getMemoryDir()}. Re-run with --data to remove them too.`, "dim"),
		);
	}
}

async function cmdSync(flags: Record<string, string | boolean>) {
	const json = hasFlag(flags, "json");

	ensureDirs();

	const qmdFound = await ensureQmdAvailableForSync();
	if (!qmdFound) {
		exitError("qmd is not installed. Install: bun install -g https://github.com/tobi/qmd", json);
	}

	const collName = getCollectionName();
	const hasCollection = await checkCollection(collName);
	if (!hasCollection) {
		exitError(`qmd collection '${collName}' not found. Run: agent-memory init`, json);
	}

	const result = await runQmdSync();

	if (json) {
		output({ ok: result.updateOk && result.embedOk, updateOk: result.updateOk, embedOk: result.embedOk }, true);
	} else {
		if (result.updateOk) {
			console.log("qmd update: ok");
		} else {
			console.log("qmd update: failed");
		}
		if (result.embedOk) {
			console.log("qmd embed: ok");
		} else {
			console.log("qmd embed: failed");
		}
		if (result.updateOk && result.embedOk) {
			console.log("\nIndex fully synced.");
		}
	}
}

async function cmdInit(flags: Record<string, string | boolean>) {
	const json = hasFlag(flags, "json");

	ensureDirs();
	const dir = getMemoryDir();

	const qmdFound = await detectQmd();
	let collectionCreated = false;
	let indexUpdated = false;
	let embedStarted = false;

	if (qmdFound) {
		const collName = getCollectionName();
		const hasCollection = await checkCollection(collName);
		if (!hasCollection) {
			collectionCreated = await setupQmdCollection();
		}

		// Run initial index update + start background embed
		await ensureQmdAvailableForUpdate();
		await runQmdUpdateNow();
		indexUpdated = true;
		const child = runQmdEmbedDetached();
		embedStarted = child !== null;
	}

	if (json) {
		output(
			{
				ok: true,
				directory: dir,
				qmd: qmdFound,
				collectionCreated,
				indexUpdated,
				embedStarted,
			},
			true,
		);
	} else {
		console.log(`Memory directory: ${dir}`);
		console.log(`  MEMORY.md, SCRATCHPAD.md, daily/, topics/ created.`);
		if (qmdFound) {
			if (collectionCreated) {
				console.log(`  qmd collection '${getCollectionName()}' created.`);
			} else {
				console.log(`  qmd collection '${getCollectionName()}' already exists.`);
			}
			if (indexUpdated) {
				console.log(`  Index updated.`);
			}
			if (embedStarted) {
				console.log(`  Embedding started in background.`);
			}
		} else {
			console.log(`  qmd not found — search features unavailable.`);
			console.log(`  Install: bun install -g https://github.com/tobi/qmd`);
		}
	}
}

async function cmdStatus(flags: Record<string, string | boolean>) {
	const json = hasFlag(flags, "json");

	ensureDirs();
	const dir = getMemoryDir();
	const memFile = getMemoryFile();
	const spFile = getScratchpadFile();
	const dailyDir = getDailyDir();
	const topicsDir = getTopicsDir();

	const memContent = readFileSafe(memFile);
	const spContent = readFileSafe(spFile);

	let dailyCount = 0;
	try {
		dailyCount = fs.readdirSync(dailyDir).filter((f) => f.endsWith(".md")).length;
	} catch {
		// directory may not exist
	}
	let topicCount = 0;
	try {
		topicCount = fs.readdirSync(topicsDir).filter((f) => f.endsWith(".md")).length;
	} catch {
		// directory may not exist
	}

	const qmdFound = await detectQmd();
	let hasCollection = false;
	let health = null;
	let embeddings: "ready" | "missing" | "unknown" | "n/a" = "n/a";
	if (qmdFound) {
		hasCollection = await checkCollection();
		if (hasCollection) {
			await ensureQmdAvailableForSync();
			health = await getQmdHealth();
			// A live semantic probe confirms embeddings are actually usable, but
			// it costs a real qmd query (and a possible model load), so it's
			// opt-in — the cheap pending-embed count below covers the common case.
			if (hasFlag(flags, "probe")) {
				embeddings = await probeEmbeddings();
			}
		}
	}

	const embedMode = getQmdEmbedMode();

	if (json) {
		output(
			{
				directory: dir,
				memoryFile: {
					exists: memContent !== null,
					chars: memContent?.length ?? 0,
					lines: memContent ? memContent.split("\n").length : 0,
				},
				scratchpadFile: {
					exists: spContent !== null,
					items: spContent ? parseScratchpad(spContent).length : 0,
					openItems: spContent ? parseScratchpad(spContent).filter((i) => !i.done).length : 0,
				},
				dailyLogs: dailyCount,
				topics: topicCount,
				qmd: {
					available: qmdFound,
					collection: hasCollection ? getCollectionName() : null,
					health,
					embeddings,
				},
				embedMode,
			},
			true,
		);
	} else {
		console.log(`Memory directory: ${dir}`);
		console.log("");
		if (memContent !== null) {
			const lines = memContent.split("\n").length;
			console.log(`MEMORY.md: ${memContent.length} chars, ${lines} lines`);
		} else {
			console.log("MEMORY.md: not created yet");
		}
		if (spContent !== null) {
			const items = parseScratchpad(spContent);
			const open = items.filter((i) => !i.done).length;
			console.log(`SCRATCHPAD.md: ${items.length} items (${open} open)`);
		} else {
			console.log("SCRATCHPAD.md: not created yet");
		}
		console.log(`Daily logs: ${dailyCount} file(s)`);
		console.log(`Topics: ${topicCount} file(s)`);
		console.log("");
		if (qmdFound) {
			console.log(`qmd: available`);
			console.log(
				`Collection '${getCollectionName()}': ${hasCollection ? "configured" : "not configured — run: agent-memory init"}`,
			);
			console.log(`Embed mode: ${embedMode}`);
			if (hasCollection && embeddings !== "n/a") {
				const embLabel =
					embeddings === "ready"
						? "ready"
						: embeddings === "missing"
							? "missing — run: agent-memory sync"
							: "unknown (could not verify within probe timeout)";
				console.log(`Embeddings (semantic/deep search): ${embLabel}`);
			}
			if (health) {
				if (health.totalFiles !== null) console.log(`Files indexed: ${health.totalFiles}`);
				if (health.vectorsEmbedded !== null) console.log(`Vectors embedded: ${health.vectorsEmbedded}`);
				if (health.pendingEmbed !== null && health.pendingEmbed > 0) {
					console.log(`Pending embeds: ${health.pendingEmbed}`);
					console.log(`  run: agent-memory sync`);
				}
				if (health.lastUpdated) console.log(`Last updated: ${health.lastUpdated}`);
			}
		} else {
			console.log("qmd: not installed");
		}
	}
}

async function cmdDistil(flags: Record<string, string | boolean>) {
	const json = hasFlag(flags, "json");
	const dryRun = hasFlag(flags, "dry-run");

	const result = await distilMemories({ dryRun });

	if (json) {
		output(result, true);
	} else {
		if (result.totalEntries === 0) {
			console.log(result.output.trim());
			return;
		}
		if (dryRun) {
			console.log("--- Dry run (MEMORY.md not modified) ---\n");
		}
		console.log(result.output.trim());
		console.log("");
		console.log(
			`Distilled ${result.totalEntries} entries from ${result.totalDailyFiles} daily file(s) and ${result.totalTopicFiles} topic file(s), ${result.totalTags} tag(s).`,
		);
		if (!dryRun) {
			console.log("MEMORY.md updated.");
		}
	}
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function printUsage() {
	console.log(`agent-memory — persistent memory for coding agents

Usage:
  agent-memory <command> [options]

Commands:
  version     Show binary version
  setup       One-shot install: memory dir + qmd, skills, and hooks for every detected agent
  uninstall   Reverse of setup; remove hooks + skills (--data also deletes memory files)
  install-skills  Install (or --uninstall) bundled skills
  uninstall-skills  Uninstall bundled skills
  install-hooks   Install SessionStart/UserPromptSubmit/Stop hooks for detected agents
  uninstall-hooks Remove hooks installed by install-hooks/setup
  hook        Internal: runtime handler invoked by an installed hook (session-start,
              user-prompt-submit, stop, cursor-event)
  context     Build context; optionally retrieve memories with --query
  write       Write to memory files (default: daily; optional --source-uri)
  read        Read memory files
  scratchpad  Manage checklist items
  search      Search across memory files (requires qmd)
  distil      Generate compact MEMORY.md index from daily logs + topics
  sync        Re-index and embed all files (requires qmd)
  init        Initialize memory directory and qmd collection
  status      Show configuration and status (--probe for a live embeddings check)
  serve --mcp Run a Model Context Protocol server over stdio (tools: memory_context,
              memory_search, memory_read, memory_write, memory_scratchpad)

Global flags:
  --dir <path>   Override memory directory
  --json         Machine-readable JSON output

Examples:
  agent-memory setup
  agent-memory install-hooks --mode per-turn
  agent-memory install-hooks --only claude,codex --yes
  agent-memory uninstall-hooks --only cursor
  agent-memory uninstall --yes
  agent-memory uninstall --yes --data
  agent-memory init
  agent-memory write --content "Fixed auth bug in login flow"
  agent-memory write --target long_term --content "User prefers dark mode" --source-uri "session://agent/turn/12"
  agent-memory write --target topic --topic "auth" --content "Rolled JWT refresh to edge"
  agent-memory read --target long_term
  agent-memory read --target daily --date 2026-02-15
  agent-memory read --target list
  agent-memory read --target topic --topic "auth"
  agent-memory read --target topics
  agent-memory scratchpad add --text "Review PR #42"
  agent-memory scratchpad list
  agent-memory scratchpad done --text "PR #42"
  agent-memory search --query "database choice" --mode keyword
  agent-memory distil --dry-run
  agent-memory context --query "database choice"
  agent-memory sync
  agent-memory status --json
  agent-memory serve --mcp`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	const { command, flags, positional } = parseArgs(process.argv.slice(2));
	const json = hasFlag(flags, "json");

	// Apply --dir override
	const dir = getFlag(flags, "dir");
	if (dir) {
		_setBaseDir(dir);
	}

	if (command === "version" || hasFlag(flags, "version")) {
		output(json ? { version: VERSION } : VERSION, json);
		return;
	}

	if (!command || command === "help" || hasFlag(flags, "help")) {
		printUsage();
		return;
	}

	switch (command) {
		case "context":
			await cmdContext(flags);
			break;
		case "write":
			await cmdWrite(flags);
			break;
		case "read":
			await cmdRead(flags);
			break;
		case "scratchpad":
			await cmdScratchpad(flags, positional);
			break;
		case "search":
			await cmdSearch(flags);
			break;
		case "install-skills":
			cmdInstallSkills(flags);
			break;
		case "uninstall-skills":
			cmdInstallSkills({ ...flags, uninstall: true });
			break;
		case "install-hooks":
			await cmdInstallHooks(flags);
			break;
		case "uninstall-hooks":
			cmdUninstallHooks(flags);
			break;
		case "setup":
			await cmdSetup(flags);
			break;
		case "uninstall":
			await cmdUninstall(flags);
			break;
		case "hook": {
			const event = positional[0];
			if (event === "session-start") {
				await cmdContext(flags);
			} else if (event === "user-prompt-submit") {
				await cmdUserPromptSubmit(flags);
			} else if (event === "stop") {
				await cmdStop(flags);
			} else if (event === "cursor-event") {
				await cmdCursorEvent();
			} else {
				exitError(
					"Usage: agent-memory hook <session-start|user-prompt-submit|stop|cursor-event> [--agent <agent>]",
					json,
				);
			}
			break;
		}
		case "distil":
		case "distill":
			await cmdDistil(flags);
			break;
		case "sync":
			await cmdSync(flags);
			break;
		case "init":
			await cmdInit(flags);
			break;
		case "status":
			await cmdStatus(flags);
			break;
		case "serve":
			if (!hasFlag(flags, "mcp")) {
				exitError("Usage: agent-memory serve --mcp", json);
				return;
			}
			(await import("./mcp-server.js")).runMcpServer();
			return; // keep process alive on stdin; do not fall through to exit
		default:
			exitError(`Unknown command: ${command}. Run 'agent-memory help' for usage.`, json);
	}
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
