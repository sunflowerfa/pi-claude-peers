/**
 * The Unix-socket message protocol Claude Code speaks between local sessions.
 *
 * Newline-delimited JSON. The first line on a connection is
 * `{"type":"auth","token":"<the recipient's peerToken>"}`; every later line is
 * one frame dispatched on its `type`. Claude Code prints this contract itself
 * when run with `--verbose`:
 *
 *   { echo '{"type":"auth","token":"'"$CLAUDE_CODE_MESSAGING_TOKEN"'"}';
 *     echo '{"type":"user","message":{"role":"user","content":"hello"}}'; } \
 *   | socat - UNIX-CONNECT:$CLAUDE_CODE_MESSAGING_SOCKET
 *
 * A connection that sends no complete line within a few seconds is closed by
 * the other side, so frames are written immediately on connect.
 */

import { connect, createServer, type Server, type Socket } from "node:net";
import { chmodSync, rmSync } from "node:fs";

export const ENVELOPE_TAG = "cross-session-message";

/**
 * The sender's permission-mode class. Claude Code validates this against a
 * closed set, and an unrecognised value fails the envelope round-trip below.
 */
export const FROM_MODES = ["bypass", "prompting"] as const;
export type FromMode = (typeof FROM_MODES)[number];

/** Claude Code truncates a longer peer name, which would break the round-trip. */
const MAX_FROM_NAME_CHARS = 64;

export interface IncomingFrame {
	type: string;
	[key: string]: unknown;
}

// ---------------------------------------------------------------- addressing

/** Address form peers use to name each other's inbox: `uds:<socket path>`. */
export function udsAddress(socketPath: string): string {
	return `uds:${socketPath}`;
}

/** Socket path from a `uds:` address, or undefined if it is not one. */
export function udsSocketPath(address: unknown): string | undefined {
	if (typeof address !== "string" || !address.startsWith("uds:")) return undefined;
	const path = address.slice(4);
	return path === "" ? undefined : path;
}

// ----------------------------------------------------------------- envelope

/**
 * Strips the characters Claude Code removes before comparing a peer name, and
 * caps the length it would otherwise truncate. Both steps have to happen here:
 * the receiver normalises the name, re-serializes the envelope, and discards
 * the origin unless the result is byte-identical to what arrived.
 */
export function normalizeFromName(name: string): string {
	const stripped = name.replace(/[\p{Cf}\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/gu, "").replace(/["<>]/g, "").trim();
	const chars = [...stripped];
	return chars.length > MAX_FROM_NAME_CHARS ? chars.slice(0, MAX_FROM_NAME_CHARS).join("") : stripped;
}

/**
 * Neutralises envelope tags inside the body. The receiver rewrites any tag it
 * finds there before re-serializing, so a body carrying one verbatim would not
 * survive the equality check. Escaping it here makes that rewrite a no-op.
 */
export function escapeEnvelopeBody(body: string): string {
	return body.replaceAll(`</${ENVELOPE_TAG}`, `<\\/${ENVELOPE_TAG}`).replaceAll(`<${ENVELOPE_TAG}`, `<\\${ENVELOPE_TAG}`);
}

/**
 * Builds the envelope that marks a message as coming from a peer session.
 *
 * Attribute order is fixed by the receiver's re-serialization — from,
 * from-session, hop-chain, from-name, from-mode — and only the two this
 * extension sets are supported here.
 *
 * Getting any of this wrong is not an error the sender hears about: the message
 * is still delivered, just stripped of its origin, with no verified pid, no
 * peer name and no review hold.
 */
export function buildEnvelope(options: { from: string; fromName?: string; fromMode?: FromMode; body: string }): string {
	const attributes = [`from="${options.from}"`];
	const name = options.fromName === undefined ? undefined : normalizeFromName(options.fromName);
	if (name) attributes.push(`from-name="${name}"`);
	if (options.fromMode) attributes.push(`from-mode="${options.fromMode}"`);
	return `<${ENVELOPE_TAG} ${attributes.join(" ")}>\n${escapeEnvelopeBody(options.body)}\n</${ENVELOPE_TAG}>`;
}

export interface ParsedEnvelope {
	from?: string;
	fromSession?: string;
	hopChain?: string[];
	fromName?: string;
	fromMode?: string;
	body: string;
}

const ADDRESS_CHARS = "A-Za-z0-9%:_/.\\\\-";
const SESSION_PATTERN = "[A-Za-z0-9_-]{1,80}";
const HOP_PATTERN = "[0-9a-f]{24}(?:,[0-9a-f]{24}){0,31}";

const ENVELOPE_PATTERN = new RegExp(
	`^<${ENVELOPE_TAG}(?: from="([${ADDRESS_CHARS}]+)")?(?: from-session="(${SESSION_PATTERN})")?` +
		`(?: hop-chain="(${HOP_PATTERN})")?(?: from-name="([^"<>\\n\\r]+)")?` +
		`(?: from-mode="(${FROM_MODES.join("|")})")?>\\n([\\s\\S]*)\\n</${ENVELOPE_TAG}>$`,
);

/**
 * Parses an envelope the way the receiver does, including the round-trip
 * equality check that silently discards a malformed one. Exposed so the tests
 * can assert that what we build is what a receiver would accept.
 */
export function parseEnvelope(content: string): ParsedEnvelope | undefined {
	if (typeof content !== "string") return undefined;
	const match = ENVELOPE_PATTERN.exec(content);
	if (!match) return undefined;

	const [, from, fromSession, hopChain, fromName, fromMode, body = ""] = match;
	// The receiver rebuilds the envelope from what it parsed and keeps the
	// origin only when the rebuild matches the input exactly.
	const rebuilt = rebuildEnvelope({ from, fromSession, hopChain, fromName, fromMode, body });
	if (rebuilt !== content) return undefined;

	return {
		...(from !== undefined ? { from } : {}),
		...(fromSession !== undefined ? { fromSession } : {}),
		...(hopChain !== undefined ? { hopChain: hopChain.split(",") } : {}),
		...(fromName !== undefined ? { fromName } : {}),
		...(fromMode !== undefined ? { fromMode } : {}),
		body,
	};
}

function rebuildEnvelope(parts: {
	from?: string;
	fromSession?: string;
	hopChain?: string;
	fromName?: string;
	fromMode?: string;
	body: string;
}): string {
	const attributes: string[] = [];
	if (parts.from) attributes.push(`from="${parts.from}"`);
	if (parts.fromSession) attributes.push(`from-session="${parts.fromSession}"`);
	if (parts.hopChain) attributes.push(`hop-chain="${parts.hopChain}"`);
	const name = parts.fromName === undefined ? undefined : normalizeFromName(parts.fromName);
	if (name) attributes.push(`from-name="${name}"`);
	if (parts.fromMode) attributes.push(`from-mode="${parts.fromMode}"`);
	const prefix = attributes.length > 0 ? ` ${attributes.join(" ")}` : "";
	return `<${ENVELOPE_TAG}${prefix}>\n${escapeEnvelopeBody(parts.body)}\n</${ENVELOPE_TAG}>`;
}

// ------------------------------------------------------------------- frames

/** The frame that injects a turn-triggering user message into a session. */
export function userMessageFrame(options: {
	content: string;
	msgId: string;
	from: string;
	fromName?: string;
	fromMode?: FromMode;
	priority?: "next" | "queue";
}): unknown {
	return {
		msgV: 1,
		msg_id: options.msgId,
		type: "user",
		message: {
			role: "user",
			content: buildEnvelope({
				from: options.from,
				fromName: options.fromName,
				fromMode: options.fromMode,
				body: options.content,
			}),
		},
		priority: options.priority ?? "next",
		from: options.from,
	};
}

/** Delivery verdicts a recipient reports back to the sender's own inbox. */
export type DeliveryStatus = "delivered" | "held" | "denied" | "expired" | "refused" | "dropped";

const STATUS_REASONS: Record<DeliveryStatus, string> = {
	delivered: "Your message was delivered to the recipient's session.",
	held: "Your message is held for the recipient user's approval before it reaches their session.",
	denied: "The recipient user declined your message; it was not delivered to their session.",
	expired: "Your held message expired without approval and was not delivered to the recipient's session.",
	refused: "The recipient session is not accepting cross-session messages.",
	dropped: "The recipient's session dropped your message at its inbox; it was not delivered.",
};

/**
 * Status is not a reply on the inbound connection: the recipient opens a fresh
 * connection to the sender's own inbox and sends this control frame there.
 */
export function statusFrame(options: {
	status: DeliveryStatus;
	from: string;
	origMsgId?: string;
	dropReason?: string;
}): unknown {
	return {
		type: "control",
		action: "peer_message_status",
		status: options.status,
		reason: STATUS_REASONS[options.status],
		from: options.from,
		...(options.origMsgId !== undefined ? { orig_msg_id: options.origMsgId } : {}),
		...(options.dropReason !== undefined ? { drop_reason: options.dropReason } : {}),
	};
}

/**
 * Best-effort text extraction. A plain user message carries `message.content`;
 * other frame shapes put the text under one of a few neighbouring keys.
 */
export function frameText(frame: IncomingFrame): string | undefined {
	const candidates: unknown[] = [
		(frame.message as { content?: unknown } | undefined)?.content,
		frame.content,
		frame.text,
		frame.body,
	];
	for (const candidate of candidates) {
		if (typeof candidate === "string" && candidate.trim() !== "") return candidate;
		if (Array.isArray(candidate)) {
			const text = candidate
				.map((part) => (typeof part === "string" ? part : ((part as { text?: unknown })?.text ?? "")))
				.filter((part): part is string => typeof part === "string" && part !== "")
				.join("\n");
			if (text.trim() !== "") return text;
		}
	}
	return undefined;
}

// ------------------------------------------------------------------- socket

export interface InboxOptions {
	socketPath: string;
	/** Token a connecting peer must present on its first line. */
	peerToken: string;
	onFrame: (frame: IncomingFrame) => void;
	/** Connections that send no complete line within this window are dropped. */
	silentTimeoutMs?: number;
	/** Reject a single frame larger than this, rather than buffering it. */
	maxFrameBytes?: number;
	/** Optional trace of received frames. Auth tokens are redacted first. */
	trace?: (line: string) => void;
}

/** Replaces the token in an auth frame so a trace never records a credential. */
export function redactAuth(line: string): string {
	return line.replace(/("token"\s*:\s*")[^"]*(")/g, "$1<redacted>$2");
}

/**
 * Binds the inbox socket, chmod 0600 so only this uid can reach it — matching
 * what Claude Code creates.
 */
export function startInbox(options: InboxOptions): Server {
	const silentTimeoutMs = options.silentTimeoutMs ?? 10_000;
	const maxFrameBytes = options.maxFrameBytes ?? 1_000_000;

	try {
		rmSync(options.socketPath, { force: true });
	} catch {
		// A live socket here fails the listen below with EADDRINUSE, which is the
		// error worth surfacing rather than masking.
	}

	const server = createServer((socket: Socket) => {
		let buffer = "";
		let authenticated = false;
		const timer = setTimeout(() => socket.destroy(), silentTimeoutMs);

		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			if (buffer.length > maxFrameBytes) {
				socket.destroy();
				return;
			}

			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
				if (line === "") continue;
				clearTimeout(timer);
				options.trace?.(redactAuth(line));

				let frame: IncomingFrame;
				try {
					frame = JSON.parse(line) as IncomingFrame;
				} catch {
					socket.destroy();
					return;
				}
				if (typeof frame?.type !== "string") continue;

				if (!authenticated) {
					// Auth is positional: the first frame or nothing.
					if (frame.type !== "auth" || frame.token !== options.peerToken) {
						socket.destroy();
						return;
					}
					authenticated = true;
					continue;
				}
				options.onFrame(frame);
			}
		});

		socket.on("error", () => socket.destroy());
		socket.on("close", () => clearTimeout(timer));
	});

	server.listen(options.socketPath, () => {
		try {
			chmodSync(options.socketPath, 0o600);
		} catch {
			// Filesystems without socket permissions leave the default mode; the
			// containing directory is 0700, which already keeps other uids out.
		}
	});

	return server;
}

/**
 * Opens a connection, authenticates, writes the frames and closes. Delivery
 * status does not come back here — the recipient reports it by connecting to
 * the sender's own inbox.
 */
export function sendFrames(
	socketPath: string,
	token: string,
	frames: unknown[],
	options?: { timeoutMs?: number },
): Promise<void> {
	const timeoutMs = options?.timeoutMs ?? 5_000;

	return new Promise((resolve, reject) => {
		const socket = connect(socketPath);
		let settled = false;

		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			if (error) reject(error);
			else resolve();
		};

		const timer = setTimeout(() => finish(new Error(`timed out writing to ${socketPath}`)), timeoutMs);

		socket.on("connect", () => {
			const lines = [{ type: "auth", token }, ...frames].map((frame) => `${JSON.stringify(frame)}\n`).join("");
			socket.write(lines, () => finish());
		});
		socket.on("error", (error) => finish(error));
		socket.on("close", () => finish());
	});
}
