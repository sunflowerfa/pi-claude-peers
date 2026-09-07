/**
 * pi-claude-peers — two-way messaging between pi and Claude Code.
 *
 * Claude Code sessions find each other through a registry of
 * `~/.claude/sessions/<pid>.json` files and talk over per-session Unix sockets.
 * This extension makes a pi session a participant: it publishes the same
 * registration, serves the same socket protocol, and gives pi two tools for
 * listing and messaging the other agents on the machine.
 *
 * Configuration is documented in README.md.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "node:net";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	deriveName,
	ensureSocketDir,
	listPeers,
	peerTokenFor,
	peerTokenForSocket,
	register,
	SOCKET_DIR,
	unregister,
	updateStatus,
	type SessionRecord,
} from "./registry.ts";
import {
	FROM_MODES,
	frameText,
	parseEnvelope,
	sendFrames,
	startInbox,
	statusFrame,
	udsAddress,
	udsSocketPath,
	userMessageFrame,
	type DeliveryStatus,
	type FromMode,
	type IncomingFrame,
} from "./wire.ts";

/**
 * The permission-mode class we assert. Claiming "bypass" tells a recipient our
 * side already runs without prompts, which switches off its review of our
 * messages — not a choice to make on someone else's behalf, so the honest
 * default is the conservative one.
 */
const DEFAULT_FROM_MODE: FromMode = "prompting";

/** Refuse an inbound message larger than this rather than injecting it. */
const MAX_MESSAGE_CHARS = 100_000;

export default function (pi: ExtensionAPI) {
	const pid = process.pid;
	const socketPath = join(SOCKET_DIR, `${pid}.sock`);
	const selfAddress = udsAddress(socketPath);
	const peerToken = randomBytes(16).toString("hex");
	const fromMode = readFromMode();

	let inbox: Server | undefined;
	let uiContext: ExtensionContext | undefined;
	let registered = false;
	let selfName = "pi";

	function readFromMode(): FromMode {
		const configured = process.env.PI_CLAUDE_PEERS_FROM_MODE?.trim();
		return (FROM_MODES as readonly string[]).includes(configured ?? "")
			? (configured as FromMode)
			: DEFAULT_FROM_MODE;
	}

	function autoAccept(): boolean {
		return process.env.PI_CLAUDE_PEERS_AUTO_ACCEPT?.trim() === "1";
	}

	const trace = (line: string) => {
		const path = process.env.PI_CLAUDE_PEERS_DEBUG?.trim();
		if (!path) return;
		try {
			appendFileSync(path, `${new Date().toISOString()} ${line}\n`);
		} catch {
			// Tracing must never break delivery.
		}
	};

	// ------------------------------------------------------------- lifecycle

	pi.on("session_start", async (_event, ctx) => {
		uiContext = ctx;
		if (registered) return;

		if (process.platform === "win32") {
			// Claude Code uses named pipes there; this bridge only speaks AF_UNIX.
			ctx.ui.notify("pi-claude-peers: Windows is not supported yet; the bridge is inactive", "warning");
			return;
		}

		try {
			ensureSocketDir(socketPath);
			selfName = deriveName(ctx.cwd, pid);
			inbox = startInbox({ socketPath, peerToken, onFrame: handleFrame, trace });
			register({
				pid,
				peerToken,
				sessionId: ctx.sessionManager.getSessionId(),
				cwd: ctx.cwd,
				name: selfName,
				status: "idle",
				messagingSocketPath: socketPath,
			});
			registered = true;
		} catch (error) {
			ctx.ui.notify(`pi-claude-peers: inbox unavailable (${describe(error)})`, "warning");
			teardown();
		}
	});

	pi.on("turn_start", () => registered && updateStatus(pid, "busy"));
	pi.on("turn_end", () => registered && updateStatus(pid, "idle"));
	pi.on("session_shutdown", () => teardown());

	// The registry is a set of files on disk; a process that dies without
	// cleaning up leaves entries that peers discard only once the pid is dead.
	for (const signal of ["exit", "SIGINT", "SIGTERM"] as const) {
		process.once(signal, () => teardown());
	}

	function teardown(): void {
		if (inbox) {
			try {
				inbox.close();
			} catch {
				// Already closed.
			}
			inbox = undefined;
		}
		if (registered) {
			unregister(pid, socketPath);
			registered = false;
		}
	}

	// -------------------------------------------------------------- incoming

	function handleFrame(frame: IncomingFrame): void {
		if (frame.type === "control") {
			// Idle notifications, artifact hand-offs and the rest of the control
			// surface are not implemented; a verdict keeps the sender from waiting.
			if (frame.action !== "peer_message_status") void report(frame, "dropped", "unsupported_action");
			return;
		}
		if (frame.type !== "user") {
			void report(frame, "dropped", "unsupported_type");
			return;
		}

		const raw = frameText(frame);
		if (raw === undefined) {
			void report(frame, "dropped", "malformed_frame");
			return;
		}
		if (raw.length > MAX_MESSAGE_CHARS) {
			void report(frame, "dropped", "message_too_large");
			return;
		}

		const envelope = parseEnvelope(raw);
		const from = envelope?.fromName ?? String(frame.from ?? "an unidentified session");
		void deliver(frame, from, envelope?.body ?? raw);
	}

	async function deliver(frame: IncomingFrame, from: string, text: string): Promise<void> {
		if (autoAccept()) {
			inject(from, text);
			await report(frame, "delivered");
			return;
		}

		await report(frame, "held");
		if (await accept(from, text)) {
			inject(from, text);
			await report(frame, "delivered");
		} else {
			await report(frame, "denied");
		}
	}

	function inject(from: string, text: string): void {
		pi.sendUserMessage(`[message from ${from}]\n\n${text}`, { deliverAs: "followUp" });
	}

	/**
	 * Confirmation gate. A delivered message always starts a turn, so the
	 * default is to ask. A session with no dialog-capable UI (print mode) cannot
	 * ask, and blocking there would hang the sender, so it declines instead —
	 * `PI_CLAUDE_PEERS_AUTO_ACCEPT=1` is the switch for unattended use.
	 */
	async function accept(from: string, text: string): Promise<boolean> {
		const ctx = uiContext;
		if (!ctx?.hasUI) {
			trace(`declined message from ${from}: no UI to confirm and auto-accept is off`);
			return false;
		}
		const preview = text.length > 300 ? `${text.slice(0, 300)}…` : text;
		try {
			return await ctx.ui.confirm(`Message from ${from}`, `${preview}\n\nDeliver to this session?`);
		} catch {
			return false;
		}
	}

	/** Reports a verdict on the sender's own inbox, as the protocol requires. */
	async function report(frame: IncomingFrame, status: DeliveryStatus, dropReason?: string): Promise<void> {
		const replyPath = udsSocketPath(frame.from);
		if (replyPath === undefined || replyPath === socketPath) return;
		const token = peerTokenForSocket(replyPath);
		if (!token) return;
		try {
			await sendFrames(replyPath, token, [
				statusFrame({
					status,
					from: selfAddress,
					origMsgId: typeof frame.msg_id === "string" ? frame.msg_id : undefined,
					dropReason,
				}),
			]);
		} catch (error) {
			trace(`status ${status} to ${replyPath} failed: ${describe(error)}`);
		}
	}

	// --------------------------------------------------------------- outgoing

	pi.registerTool({
		name: "list_agents",
		label: "list_agents",
		description:
			"List the other coding-agent sessions running on this machine (Claude Code and pi) that can be messaged, " +
			"with their name, working directory and whether they are idle or busy. Use the returned name with send_message.",
		parameters: { type: "object", properties: {}, additionalProperties: false } as never,
		async execute() {
			const peers = listPeers(pid);
			if (peers.length === 0) {
				return { content: [{ type: "text", text: "No other agent sessions are running." }], details: {} };
			}
			const lines = peers.map((peer) => `${peer.name} · ${peer.status} · ${peer.cwd}`);
			return { content: [{ type: "text", text: lines.join("\n") }], details: { peers } };
		},
	});

	pi.registerTool({
		name: "send_message",
		label: "send_message",
		description:
			"Send a message to another agent session on this machine by name (from list_agents). It arrives there as a " +
			"user turn, so state the request in full: the other agent cannot see this conversation. The recipient may " +
			"hold the message for its user's approval before acting on it.",
		parameters: {
			type: "object",
			properties: {
				to: { type: "string", description: "Target session name, exactly as list_agents reported it." },
				message: { type: "string", description: "The message text." },
			},
			required: ["to", "message"],
			additionalProperties: false,
		} as never,
		async execute(_toolCallId, params) {
			const { to, message } = params as { to: string; message: string };
			if (!registered) {
				throw new Error("pi-claude-peers is not active in this session; messages cannot be sent or answered.");
			}

			const peers = listPeers(pid);
			const target = resolvePeer(peers, to);
			if (!target) {
				const known = peers.map((peer) => peer.name).join(", ") || "none";
				throw new Error(`No live agent session named "${to}". Known sessions: ${known}`);
			}

			const token = peerTokenFor(target);
			if (!token) {
				throw new Error(`Session "${target.name}" published no auth key; it cannot be messaged.`);
			}

			const msgId = randomUUID();
			await sendFrames(target.messagingSocketPath, token, [
				userMessageFrame({ content: message, msgId, from: selfAddress, fromName: selfName, fromMode }),
			]);
			trace(`sent ${msgId} to ${target.name}`);

			return {
				content: [
					{
						type: "text",
						text:
							`Delivered to ${target.name}'s inbox. It may be held for that user's approval before their ` +
							`agent sees it, so do not wait for a reply.`,
					},
				],
				details: { msgId, to: target.name },
			};
		},
	});

	/** Exact name first, then a unique prefix, so short forms stay usable. */
	function resolvePeer(peers: SessionRecord[], name: string): SessionRecord | undefined {
		const wanted = name.trim();
		const exact = peers.find((peer) => peer.name === wanted);
		if (exact) return exact;
		const prefixed = peers.filter((peer) => peer.name.startsWith(wanted));
		return prefixed.length === 1 ? prefixed[0] : undefined;
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
