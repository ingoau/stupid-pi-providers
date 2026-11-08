/**
 * CS50 Duck Debugger (ddb) Provider
 *
 * Wraps the chat at https://cs50.ai/chat (CS50's "duck debugger") as a pi model.
 *
 * The endpoint (`POST /api/v1/chat`) takes an OpenAI-style message list and streams
 * back plain text. It needs a logged-in cs50.ai session (GitHub OAuth). Things the
 * provider works around:
 *   - Sessions live on one backend behind an AWS load balancer; other backends answer
 *     403. So we retry without the sticky `AWSALB` cookies until a request lands on a
 *     backend that knows the session, then keep that backend's cookies.
 *   - Requests without a browser User-Agent are treated as logged out.
 *   - System messages are ignored, so the instructions go in the first user message.
 *   - Each message is limited to 10,000 characters (the history isn't), so longer
 *     ones are split into several consecutive user messages.
 *   - No tool calling. The duck refuses to "run commands", but it gladly tells a student
 *     which command to type. So it's told that the user runs whatever single command it
 *     puts in a ```bash block, and that block becomes a pi `bash` tool call.
 *
 * Usage:
 *   CS50_SESSION=<cs50.ai `session` cookie> pi -e ./cs50 --model cs50/ddb
 *   CS50_SESSION_FILE=~/.cs50-session        -> read the cookie from a file instead
 *   CS50_DEBUG=/tmp/cs50.log                 -> append raw requests / responses to that file
 */

import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type ToolCall,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

const ORIGIN = "https://cs50.ai";
const ENDPOINT = `${ORIGIN}/api/v1/chat`;
const CONFIG = process.env.CS50_CONFIG || "chat_cs50";
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0";
/** Server-side limit per message. */
const MAX_MESSAGE_CHARS = 10_000;
/** Tool output beyond this is cut in the middle. */
const MAX_OUTPUT_CHARS = 8_000;
/** Attempts to land on a load-balancer backend that knows the session. */
const MAX_ROUTING_ATTEMPTS = 25;
const DEBUG = process.env.CS50_DEBUG;

const debug = (s: string) => DEBUG && appendFileSync(DEBUG, `${s}\n`);

// =============================================================================
// Auth / routing
// =============================================================================

function sessionCookie(): string {
	let value = process.env.CS50_SESSION;
	const file = process.env.CS50_SESSION_FILE;
	if (!value && file) value = readFileSync(file.replace(/^~(?=\/|$)/, homedir()), "utf8");
	value = value?.trim().replace(/^session=/, "");
	if (!value) {
		throw new Error(
			"CS50: set CS50_SESSION (or CS50_SESSION_FILE) to the `session` cookie of a logged-in https://cs50.ai/chat tab",
		);
	}
	return value;
}

/** Sticky load-balancer cookies of a backend that accepted our session. */
let sticky: Record<string, string> = {};

function readSticky(res: Response): Record<string, string> {
	const out: Record<string, string> = {};
	for (const c of res.headers.getSetCookie?.() ?? []) {
		const m = /^(AWSALB(?:CORS)?)=([^;]*)/.exec(c);
		if (m) out[m[1]] = m[2];
	}
	return out;
}

type ChatMessage = { role: "user" | "assistant"; content: string };

async function postChat(messages: ChatMessage[], signal?: AbortSignal): Promise<Response> {
	const session = sessionCookie();
	const body = JSON.stringify({ messages, stream: true, config: CONFIG });
	debug(`\n=== REQUEST ===\n${body}`);

	for (let attempt = 0; attempt < MAX_ROUTING_ATTEMPTS; attempt++) {
		const cookies = { ...sticky, session };
		const res = await fetch(ENDPOINT, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "*/*",
				"User-Agent": USER_AGENT,
				Origin: ORIGIN,
				Referer: `${ORIGIN}/chat`,
				Cookie: Object.entries(cookies)
					.map(([k, v]) => `${k}=${v}`)
					.join("; "),
			},
			body,
			redirect: "manual",
			signal,
		});
		debug(`<<< HTTP ${res.status} (attempt ${attempt})`);
		if (res.ok && res.body) {
			const s = readSticky(res);
			if (Object.keys(s).length) sticky = s;
			return res;
		}
		const text = await res.text().catch(() => "");
		if (res.status === 403 || (res.status >= 300 && res.status < 400)) {
			// Wrong backend (or this backend forgot the session): let the balancer pick again.
			sticky = {};
			continue;
		}
		const msg = /<p>([\s\S]*?)<\/p>/.exec(text)?.[1] ?? text.slice(0, 300);
		throw new Error(`CS50 HTTP ${res.status}: ${msg.trim()}`);
	}
	throw new Error(
		`CS50: no backend accepted the session after ${MAX_ROUTING_ATTEMPTS} tries. The cookie is probably expired: log in at ${ORIGIN}/chat again and copy a fresh one.`,
	);
}

// =============================================================================
// Prompt construction
// =============================================================================

/**
 * Whether pi offers a `bash` tool. Older pi passes `context.tools`; newer pi declares
 * tools in system messages (`toolsAdded` / `toolsRemoved`) inside `context.messages`.
 */
function hasBash(context: Context): boolean {
	const legacy = (context as { tools?: { name: string }[] }).tools;
	if (legacy?.length) return legacy.some((t) => t.name === "bash");
	let has = false;
	for (const m of context.messages as any[]) {
		if (m.role !== "system") continue;
		if (m.toolsAdded?.some((t: { name: string }) => t.name === "bash")) has = true;
		if (m.toolsRemoved?.some((t: { name?: string } | string) => (typeof t === "string" ? t : t.name) === "bash")) has = false;
	}
	return has;
}

function intro(canRun: boolean): string {
	const lines = [
		"I'm a CS50 student working at my terminal.",
		`My current directory is ${process.cwd()}.`,
	];
	if (canRun) {
		lines.push(
			"I'm new to the command line, so please guide me step by step: whenever you want me to run a terminal command, put exactly one command in a ```bash code block at the end of your message. I'll type it and paste back the output. If you don't need me to run anything, don't include a bash block.",
			"Please don't ask me to copy or paste something (an error, a file's contents): give me the command that shows it instead.",
			"I can't use editors or interactive programs (no code, nano, vim, less, python REPL). I can only run commands that finish on their own and print their output; to create or change a file I have to use a command (for example a heredoc).",
		);
	}
	return lines.join("\n");
}

function textOf(content: string | { type: string; text?: string }[]): string {
	if (typeof content === "string") return content;
	return content
		.map((c) => (c.type === "text" ? (c.text ?? "") : c.type === "image" ? "[image omitted]" : ""))
		.join("\n");
}

function clip(s: string, max: number): string {
	if (s.length <= max) return s;
	const half = Math.floor((max - 40) / 2);
	return `${s.slice(0, half)}\n... [${s.length - 2 * half} characters cut] ...\n${s.slice(-half)}`;
}

/** Split text into pieces of at most `max` chars, preferring line boundaries. */
function splitText(text: string, max: number): string[] {
	const out: string[] = [];
	let rest = text;
	while (rest.length > max) {
		let cut = rest.lastIndexOf("\n", max);
		if (cut < max / 2) cut = max;
		out.push(rest.slice(0, cut));
		rest = rest.slice(cut).replace(/^\n/, "");
	}
	if (rest) out.push(rest);
	return out;
}

function bashBlock(call: ToolCall): string {
	return `\`\`\`bash\n${String(call.arguments?.command ?? "")}\n\`\`\``;
}

function buildMessages(context: Context): ChatMessage[] {
	const canRun = hasBash(context);
	const out: ChatMessage[] = [];
	const push = (role: "user" | "assistant", content: string) => {
		if (!content.trim()) return;
		const max = role === "user" ? MAX_MESSAGE_CHARS : MAX_MESSAGE_CHARS - 100;
		for (const part of splitText(content, max)) out.push({ role, content: part });
	};

	let first = true;
	for (const m of context.messages) {
		if (m.role === "user") {
			const text = textOf(m.content);
			push("user", first ? `${intro(canRun)}\n\n${text}` : text);
			first = false;
		} else if (m.role === "assistant") {
			const parts: string[] = [];
			let text = "";
			for (const c of m.content) {
				if (c.type === "text") text += c.text;
				// The command is normally already in the text; only add it back if it isn't
				else if (c.type === "toolCall" && !text.includes(String(c.arguments?.command ?? "\0"))) {
					parts.push(bashBlock(c));
				}
			}
			push("assistant", [text, ...parts].filter(Boolean).join("\n\n"));
		} else if (m.role === "toolResult") {
			const output = clip(textOf(m.content).trimEnd() || "(no output)", MAX_OUTPUT_CHARS);
			push("user", `${m.isError ? "It failed" : "Here's the output"}:\n\`\`\`\n${output}\n\`\`\``);
		}
	}
	return out;
}

// =============================================================================
// Reply parsing
// =============================================================================

/** All ```bash / ```sh / ```shell / ```console blocks, joined so they run in order. */
function extractCommand(text: string): string | undefined {
	const cmds: string[] = [];
	for (const m of text.matchAll(/```(?:bash|sh|shell|zsh|console)[^\n]*\n([\s\S]*?)```/g)) {
		const cmd = m[1]
			.split("\n")
			.map((l) => l.replace(/^\$ /, ""))
			.join("\n")
			.trim();
		if (cmd) cmds.push(cmd);
	}
	return cmds.length ? cmds.join("\n") : undefined;
}

// =============================================================================
// Stream
// =============================================================================

function streamCs50(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		try {
			stream.push({ type: "start", partial: output });

			const res = await postChat(buildMessages(context), options?.signal);

			output.content.push({ type: "text", text: "" });
			const textIdx = output.content.length - 1;
			const block = output.content[textIdx] as { type: "text"; text: string };
			stream.push({ type: "text_start", contentIndex: textIdx, partial: output });

			const reader = res.body!.getReader();
			const decoder = new TextDecoder();
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				const chunk = decoder.decode(value, { stream: true });
				// The web client drops these metadata chunks too
				if (!chunk || chunk.includes("event_thread_ts")) continue;
				block.text += chunk;
				stream.push({ type: "text_delta", contentIndex: textIdx, delta: chunk, partial: output });
			}
			debug(`=== REPLY ===\n${block.text}`);
			block.text = block.text.trim();
			stream.push({ type: "text_end", contentIndex: textIdx, content: block.text, partial: output });

			const command = extractCommand(block.text);
			if (command && hasBash(context)) {
				const call: ToolCall = {
					type: "toolCall",
					id: `ddb_${Math.random().toString(36).slice(2, 14)}`,
					name: "bash",
					arguments: { command },
				};
				output.content.push(call);
				const idx = output.content.length - 1;
				stream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
				stream.push({ type: "toolcall_delta", contentIndex: idx, delta: JSON.stringify(call.arguments), partial: output });
				stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: call, partial: output });
				output.stopReason = "toolUse";
			}

			stream.push({ type: "done", reason: output.stopReason as "stop" | "toolUse", message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}

// =============================================================================
// Extension entry point
// =============================================================================

export default function (pi: ExtensionAPI) {
	pi.registerProvider("cs50", {
		name: "CS50 Duck Debugger",
		baseUrl: ENDPOINT,
		apiKey: "none",
		api: "cs50-ddb",
		models: [
			{
				id: "ddb",
				name: "CS50 Duck Debugger (ddb)",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
			},
		],
		streamSimple: streamCs50,
	});
}
