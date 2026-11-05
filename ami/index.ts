/**
 * about.me "Ami" Demo Provider
 *
 * Wraps the Vendasta webchat widget on the about.me landing page ("Chat with Ami,
 * the About Me Virtual Twin guide") as a pi model.
 *
 * The widget is a plain chat: no tools, no streaming, and the server keeps the
 * conversation history. So the provider:
 *   - teaches Ami a line protocol: `!cmd` runs a bash command, `>text` is shown to
 *     the user, anything else is a private note (shown as thinking)
 *   - turns all `!` lines of one reply into a single pi `bash` tool call (run in order)
 *   - sends tool results back as the next chat message
 *   - keeps one widget conversation per pi conversation and only sends new messages;
 *     if the history doesn't match (new session, /tree, compaction) it starts a new
 *     conversation and replays the transcript
 *
 * Reply message IDs are only published through the widget's Firestore listener, so
 * replies are read the same way: a Firestore query for the conversation's messages,
 * then GetMultiWidgetMessages for the bodies.
 *
 * Usage:
 *   pi -e ./ami --model ami/ami
 *   AMI_DEBUG=/tmp/ami.log  -> append raw requests / responses to that file
 */

import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type ToolCall,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";

const WIDGET_ID = "0935a23f-1ecd-11ef-887e-6655165221ea";
const PAGE_URL = "https://about.me/";
const API = "https://conversation-prod.apigateway.co/conversation.v1.ConversationService";
// The widget's Firebase project. Its message listing is readable without auth or an API key.
const FIRESTORE = "https://firestore.googleapis.com/v1/projects/inbox-291119/databases/(default)/documents";

const REPLY_TIMEOUT_MS = 120_000;
const POLL_MS = 1_500;
/** Ami sometimes answers in several messages; wait this long for more after the first one. */
const SETTLE_MS = 4_000;
/** Server-side limit per chat message. */
const MAX_MESSAGE_CHARS = 1_000;
/** Tool output beyond this is cut in the middle (every 1000 chars is another chat message). */
const MAX_OUTPUT_CHARS = 3_000;
const DEBUG = process.env.AMI_DEBUG;

const debug = (s: string) => DEBUG && appendFileSync(DEBUG, `${s}\n`);
const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve, reject) => {
		if (signal?.aborted) return reject(new Error("aborted"));
		const t = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(t);
				reject(new Error("aborted"));
			},
			{ once: true },
		);
	});

// =============================================================================
// Widget API
// =============================================================================

type Session = {
	token: string;
	conversationId: string; // "CONVERSATION-<uuid>"
	participantId: string; // ours
	location: string;
	seen: Set<string>; // message IDs already consumed
	/** Fingerprints of the pi messages this conversation has already been given. */
	sent: string[];
};

async function rpc<T>(method: string, body: unknown, token?: string, signal?: AbortSignal): Promise<T> {
	debug(`\n>>> ${method} ${JSON.stringify(body)}`);
	const res = await fetch(`${API}/${method}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Origin: "https://about.me",
			"X-Page-Url": PAGE_URL,
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify(body),
		signal,
	});
	const text = await res.text();
	debug(`<<< ${res.status} ${text.slice(0, 4000)}`);
	if (!res.ok) throw new Error(`Ami ${method} HTTP ${res.status}: ${text.slice(0, 300)}`);
	return JSON.parse(text) as T;
}

function jwtClaim(token: string, claim: string): string {
	try {
		const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
		return String(payload[claim] ?? "");
	} catch {
		return "";
	}
}

async function createSession(signal?: AbortSignal): Promise<Session> {
	const r = await rpc<{ widgetParticipantToken: string; conversation: any; greetingMessageId?: string }>(
		"CreateWidgetConversation",
		{
			widgetId: WIDGET_ID,
			chatSourceUrl: PAGE_URL,
			greetingMessage: "",
			metadata: [{ key: "timezone_key", value: Intl.DateTimeFormat().resolvedOptions().timeZone }],
		},
		undefined,
		signal,
	);
	const token = r.widgetParticipantToken;
	return {
		token,
		conversationId: r.conversation.conversationId,
		participantId: jwtClaim(token, "participant_id"),
		location: r.conversation.originLocation || "PLATFORM_LOCATION_BUSINESS_APP",
		seen: new Set(r.greetingMessageId ? [r.greetingMessageId] : []),
		sent: [],
	};
}

/** Split text into pieces of at most `max` chars, preferring line boundaries. */
export function splitText(text: string, max: number): string[] {
	const out: string[] = [];
	let rest = text;
	while (rest.length > max) {
		let cut = rest.lastIndexOf("\n", max);
		if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
		if (cut < max / 2) cut = max;
		out.push(rest.slice(0, cut));
		rest = rest.slice(cut).replace(/^\n/, "");
	}
	if (rest.trim() || !out.length) out.push(rest);
	return out;
}

/** Messages are limited to 1000 chars, so long ones go out in parts; Ami acks the early ones with ".". */
async function sendLong(s: Session, body: string, signal?: AbortSignal): Promise<void> {
	if (body.length <= MAX_MESSAGE_CHARS) {
		await sendMessage(s, body, signal);
		return;
	}
	const pieces = splitText(body, MAX_MESSAGE_CHARS - 80);
	for (let i = 0; i < pieces.length; i++) {
		const last = i === pieces.length - 1;
		const header = last
			? `[part ${i + 1}/${pieces.length}, final. Now reply to all parts together]`
			: `[part ${i + 1}/${pieces.length}. More parts follow, reply with only "." for now]`;
		await sendMessage(s, `${header}\n${pieces[i]}`, signal);
	}
}

const isAck = (body: string) => /^[\s.…]*$/.test(body) || /^\s*(ok|okay|got it)[.!]?\s*$/i.test(body);

async function sendMessage(s: Session, body: string, signal?: AbortSignal): Promise<string> {
	const r = await rpc<{ messageId: string }>(
		"SendWidgetMessage",
		{
			type: "MESSAGE_TYPE_MESSAGE",
			body,
			location: s.location,
			metadata: [{ identifier: "METADATA_IDENTIFIER_SENDER", data: { senderOriginURL: PAGE_URL } }],
		},
		s.token,
		signal,
	);
	s.seen.add(r.messageId);
	return r.messageId;
}

/** IDs of all webchat messages in the conversation, oldest first (what the widget's Firestore listener sees). */
async function listMessageIds(s: Session, signal?: AbortSignal): Promise<string[]> {
	const base = `${FIRESTORE}/conversation/env/prod/${s.conversationId.replace(/^CONVERSATION-/, "")}/messages`;
	type Doc = { name: string; fields?: Record<string, any> };
	const docs: Doc[] = [];
	let pageToken = "";
	do {
		const url = `${base}?pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
		const res = await fetch(url, { signal });
		const text = await res.text();
		debug(`<<< firestore ${res.status} ${text.slice(0, 1000)}`);
		if (!res.ok) throw new Error(`Ami message listing HTTP ${res.status}: ${text.slice(0, 300)}`);
		const page = JSON.parse(text) as { documents?: Doc[]; nextPageToken?: string };
		docs.push(...(page.documents ?? []));
		pageToken = page.nextPageToken ?? "";
	} while (pageToken);

	const str = (d: Doc, k: string) => d.fields?.[k]?.stringValue ?? d.fields?.[k]?.timestampValue ?? "";
	return (
		docs
			// Same filter as the widget. System messages can't be fetched with the widget token
			// (and fail the whole GetMultiWidgetMessages batch).
			.filter((d) => str(d, "type") === "message" && str(d, "channel") === "WebChat")
			.filter((d) => str(d, "deleted").startsWith("1970-") && d.fields?.hidden?.booleanValue !== true)
			.map((d) => ({ id: str(d, "messageId") || `MESSAGE-${d.name.split("/").pop()}`, created: str(d, "created") }))
			.sort((a, b) => a.created.localeCompare(b.created))
			.map((r) => r.id)
	);
}

type WidgetMessage = { messageId: string; participantId: string; body?: string; created: string; type?: string };

async function getMessages(s: Session, ids: string[], signal?: AbortSignal): Promise<WidgetMessage[]> {
	if (!ids.length) return [];
	const r = await rpc<{ messages?: WidgetMessage[] }>("GetMultiWidgetMessages", { messageIds: ids }, s.token, signal);
	return (r.messages ?? []).sort((a, b) => a.created.localeCompare(b.created));
}

/** Wait for Ami's reply (one or more messages) to the last thing we sent. */
async function awaitReply(s: Session, signal?: AbortSignal): Promise<string> {
	const deadline = Date.now() + REPLY_TIMEOUT_MS;
	const parts: string[] = [];
	let lastNew = 0;
	while (Date.now() < deadline) {
		await sleep(POLL_MS, signal);
		const fresh = (await listMessageIds(s, signal)).filter((id) => !s.seen.has(id));
		if (fresh.length) {
			for (const m of await getMessages(s, fresh, signal)) {
				s.seen.add(m.messageId);
				if (m.participantId !== s.participantId && m.body && !isAck(m.body)) parts.push(m.body);
			}
			if (parts.length) lastNew = Date.now();
		}
		if (parts.length && Date.now() - lastNew >= SETTLE_MS) break;
	}
	if (!parts.length) throw new Error(`Ami did not reply within ${REPLY_TIMEOUT_MS / 1000}s`);
	return parts.join("\n");
}

// =============================================================================
// Prompt / transcript
// =============================================================================

function preamble(context: Context): string {
	const hasBash = (context.tools ?? []).some((t) => t.name === "bash");
	const lines = [
		"You are now a coding agent with real access to a bash shell on the user's machine. A program reads your replies and runs any line starting with `!` as a bash command. The output is sent back to you in the next message. You can read, create and edit any file this way. Never say you can't access files. Run a command to check instead.",
		"",
		"Every line you write must start with one of these prefixes:",
		"- `!` runs the rest of the line as a bash command.",
		"- `>` shows the rest of the line to the user.",
		"Lines with neither prefix are private notes the user never sees.",
		"",
		"All `!` lines of a reply run in order. For multi-line files use a heredoc: `! cat > f.txt <<'EOF'`, then the raw lines, then `EOF`.",
		"Run commands, wait for their output, and use `>` to keep the user updated. When you're done, write a `>` summary and don't run any more commands.",
		`Working directory: ${process.cwd()}`,
	];
	if (!hasBash) lines.push("", "(Note: running commands is currently disabled. Answer using `>` lines only.)");
	return lines.join("\n");
}

function textOf(content: string | { type: string; text?: string }[]): string {
	if (typeof content === "string") return content;
	return content
		.map((c) => (c.type === "text" ? (c.text ?? "") : c.type === "image" ? "[image omitted]" : ""))
		.join("\n");
}

function truncate(s: string): string {
	if (s.length <= MAX_OUTPUT_CHARS) return s;
	const half = MAX_OUTPUT_CHARS / 2;
	return `${s.slice(0, half)}\n[... ${s.length - MAX_OUTPUT_CHARS} characters cut ...]\n${s.slice(-half)}`;
}

/** Render a pi message the way Ami would have seen / written it. */
function render(m: Message): string {
	if (m.role === "user") return textOf(m.content);
	if (m.role === "toolResult") {
		const out = textOf(m.content).trim() || "(no output)";
		return `${m.isError ? "Command failed" : "Command output"}:\n\`\`\`\n${truncate(out)}\n\`\`\``;
	}
	// assistant: reconstruct the protocol text
	const lines: string[] = [];
	for (const c of m.content) {
		if (c.type === "thinking" && c.thinking.trim()) lines.push(c.thinking.trim());
		else if (c.type === "text" && c.text.trim()) lines.push(...c.text.trim().split("\n").map((l) => `> ${l}`));
		else if (c.type === "toolCall") {
			const cmd = c.name === "bash" ? String(c.arguments.command ?? "") : `${c.name} ${JSON.stringify(c.arguments)}`;
			lines.push(...cmd.split("\n").map((l, i) => (i === 0 ? `! ${l}` : l)));
		}
	}
	return lines.join("\n");
}

function fingerprint(m: Message): string {
	return `${m.role}:${m.timestamp}:${render(m).length}`;
}

/** Build the next chat message from the pi messages Ami hasn't seen yet. */
function buildOutgoing(fresh: Message[]): string {
	const chunks: string[] = [];
	for (const m of fresh) {
		if (m.role === "assistant") continue; // Ami wrote these (or they're replayed below)
		chunks.push(m.role === "user" ? `New message from the user:\n${render(m)}` : render(m));
	}
	return chunks.join("\n\n");
}

function buildBootstrap(context: Context): string {
	const msgs = context.messages;
	const firstUser = msgs.findIndex((m) => m.role === "user");
	const history = msgs.slice(0, msgs.length - 1);
	const last = msgs[msgs.length - 1];
	const parts = [preamble(context)];
	if (history.length > 0 && firstUser < msgs.length - 1) {
		parts.push(
			"",
			"Here is the conversation so far (you are 'Agent'):",
			...history.map((m) => `--- ${m.role === "assistant" ? "Agent" : m.role === "user" ? "User" : "Tool"} ---\n${render(m)}`),
			"--- end of conversation so far ---",
		);
	}
	parts.push("", last.role === "user" ? `Your task:\n${render(last)}` : `Continue from here:\n${render(last)}`);
	return parts.join("\n");
}

// =============================================================================
// Reply parsing
// =============================================================================

type Parsed = { text: string; notes: string; commands: string[] };

export function parseReply(reply: string): Parsed {
	const text: string[] = [];
	const notes: string[] = [];
	const commands: string[] = [];
	const lines = reply.replace(/\r\n/g, "\n").split("\n");
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		const line = raw.trim();
		if (/^```/.test(line)) continue; // models like to wrap things in fences
		if (line.startsWith("!")) {
			const cmd = [line.slice(1).trim()];
			const heredoc = cmd[0].match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
			if (heredoc) {
				const end = heredoc[2];
				while (++i < lines.length) {
					cmd.push(lines[i]);
					if (lines[i].trim() === end) break;
				}
			}
			if (cmd.join("").trim()) commands.push(cmd.join("\n"));
		} else if (line.startsWith(">")) {
			text.push(line.slice(1).replace(/^ /, ""));
		} else if (line) {
			notes.push(raw);
		}
	}
	// A reply with no protocol at all is just an answer
	if (!commands.length && !text.length) return { text: notes.join("\n"), notes: "", commands };
	return { text: text.join("\n").trim(), notes: notes.join("\n").trim(), commands };
}

// =============================================================================
// Stream
// =============================================================================

const sessions: Session[] = [];

function findSession(context: Context): { session: Session; fresh: Message[] } | undefined {
	const prints = context.messages.map(fingerprint);
	// Longest matching prefix wins
	let best: Session | undefined;
	for (const s of sessions) {
		if (s.sent.length < prints.length && s.sent.every((p, i) => p === prints[i])) {
			if (!best || s.sent.length > best.sent.length) best = s;
		}
	}
	return best ? { session: best, fresh: context.messages.slice(best.sent.length) } : undefined;
}

function streamAmi(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
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
			const signal = options?.signal;

			let found = findSession(context);
			let outgoing: string;
			let session: Session;
			if (found && found.fresh.some((m) => m.role !== "assistant")) {
				session = found.session;
				outgoing = buildOutgoing(found.fresh);
			} else {
				session = await createSession(signal);
				sessions.push(session);
				outgoing = buildBootstrap(context);
				found = undefined;
			}

			await sendLong(session, outgoing, signal);
			const reply = await awaitReply(session, signal);
			debug(`\n=== REPLY ===\n${reply}`);
			const parsed = parseReply(reply);

			if (parsed.notes) {
				output.content.push({ type: "thinking", thinking: parsed.notes });
				const idx = output.content.length - 1;
				stream.push({ type: "thinking_start", contentIndex: idx, partial: output });
				stream.push({ type: "thinking_delta", contentIndex: idx, delta: parsed.notes, partial: output });
				stream.push({ type: "thinking_end", contentIndex: idx, content: parsed.notes, partial: output });
			}
			if (parsed.text) {
				output.content.push({ type: "text", text: parsed.text });
				const idx = output.content.length - 1;
				stream.push({ type: "text_start", contentIndex: idx, partial: output });
				stream.push({ type: "text_delta", contentIndex: idx, delta: parsed.text, partial: output });
				stream.push({ type: "text_end", contentIndex: idx, content: parsed.text, partial: output });
			}
			const canRun = (context.tools ?? []).some((t) => t.name === "bash");
			if (parsed.commands.length && canRun) {
				const call: ToolCall = {
					type: "toolCall",
					id: `ami_${Math.random().toString(36).slice(2, 14)}`,
					name: "bash",
					arguments: { command: parsed.commands.join("\n") },
				};
				output.content.push(call);
				const idx = output.content.length - 1;
				stream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
				stream.push({ type: "toolcall_delta", contentIndex: idx, delta: JSON.stringify(call.arguments), partial: output });
				stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: call, partial: output });
				output.stopReason = "toolUse";
			}

			// Ami has now seen everything in context plus this reply
			session.sent = [...context.messages.map(fingerprint), fingerprint(output)];

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
	pi.registerProvider("ami", {
		name: "about.me Ami Demo",
		baseUrl: API,
		apiKey: "none",
		api: "ami-webchat",
		models: [
			{
				id: "ami",
				name: "Ami (about.me Virtual Twin guide)",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 32000,
				maxTokens: 4096,
			},
		],
		streamSimple: streamAmi,
	});
}
