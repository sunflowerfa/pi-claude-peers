/**
 * Claude Code's local session registry.
 *
 * Claude Code publishes one `<pid>.json` per live session in
 * `~/.claude/sessions/`, plus a `<pid>.<sha256(socketPath)>.key` holding the
 * `peerToken` a peer must present on that session's socket. Publishing the same
 * pair is all it takes for another process to appear in Claude Code's session
 * list and be addressable by it.
 *
 * The field names here are Claude Code's, not ours.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, join } from "node:path";

export const SESSIONS_DIR = join(
	process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude"),
	"sessions",
);

/** Matches Claude Code's own choice, overridable the way it allows. */
export const SOCKET_DIR = join(process.env.CLAUDE_CODE_TMPDIR?.trim() || "/tmp", "cc-socks");

/** A Unix socket path cannot exceed roughly this, and Claude Code refuses longer. */
const MAX_SOCKET_PATH_BYTES = 104;

export interface SessionRecord {
	pid: number;
	sessionId: string;
	cwd: string;
	name: string;
	status: string;
	messagingSocketPath: string;
	startedAt?: number;
	kind?: string;
	/** Reported to peers for display; peerProtocol is the actual contract. */
	version?: string;
}

/**
 * Key file name. Hashing the socket path keeps a stale key from a recycled pid
 * from authenticating against a different socket.
 */
export function keyFileName(pid: number, socketPath: string): string {
	return `${pid}.${createHash("sha256").update(socketPath).digest("hex")}.key`;
}

/**
 * Process start time in the textual form Claude Code stores, e.g.
 * "Mon Sep  7 13:34:03 2026". It is the guard against pid reuse: a registration
 * whose recorded start time no longer matches the live process is stale.
 *
 * `ps` renders this in the ambient timezone while Claude Code records UTC, and
 * the two are compared as strings — so the timezone has to be pinned or every
 * peer outside UTC looks dead.
 */
export function procStart(pid: number): string | undefined {
	try {
		return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
			encoding: "utf8",
			// Claude Code reads this the same way, as `LC_ALL=C TZ=UTC ps -o lstart=`.
			// Both are needed: the timezone shifts the clock, the locale renames the
			// month and weekday, and the result is compared as a string.
			env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
		}).trim();
	} catch {
		return undefined;
	}
}

/**
 * Identifies the pid namespace a registration's `pid` belongs to, so peers do
 * not compare pids across machines or containers. Claude Code derives it per
 * platform, and a value it does not recognise makes it treat our pid as
 * belonging to a foreign domain — so this mirrors its derivation rather than
 * reporting `process.platform`.
 *
 * The "darwin:" prefix on every non-macOS branch is Claude Code's own spelling,
 * not a mistake here.
 */
export function pidDomain(): string {
	if (process.platform === "win32") {
		return `darwin:${hostname().toLowerCase()}`;
	}
	if (process.platform !== "linux") {
		return "darwin";
	}
	let machineId = "";
	try {
		machineId = readFileSync("/etc/machine-id", "utf8").trim();
	} catch {
		// Absent on some distributions; Claude Code also falls back to empty.
	}
	let pidNamespace = "";
	try {
		pidNamespace = readlinkSync("/proc/self/ns/pid");
	} catch {
		// Unreadable inside some sandboxes.
	}
	return `darwin:${machineId}:${pidNamespace}`;
}

function isAlive(pid: number, recordedStart: string | undefined): boolean {
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	if (!recordedStart) return true;
	const current = procStart(pid);
	return current === undefined || current === recordedStart;
}

/**
 * A stable, collision-free display name: the working directory's basename plus
 * a short digest of the pid, so two sessions in one directory stay distinct and
 * a name never changes under a running session.
 */
export function deriveName(cwd: string, pid: number, prefix = "pi"): string {
	const slug = basename(cwd).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 24) || "session";
	const suffix = createHash("sha256").update(String(pid)).digest("hex").slice(0, 2);
	return `${prefix}-${slug}-${suffix}`;
}

/** Registers this process as a peer session. Returns the paths it now owns. */
export function register(record: SessionRecord & { peerToken: string }): { jsonPath: string; keyPath: string } {
	mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
	const now = Date.now();
	const startedAt = record.startedAt ?? now;
	const jsonPath = join(SESSIONS_DIR, `${record.pid}.json`);
	const keyPath = join(SESSIONS_DIR, keyFileName(record.pid, record.messagingSocketPath));
	const start = procStart(record.pid);

	writeFileSync(
		jsonPath,
		JSON.stringify(
			{
				pid: record.pid,
				sessionId: record.sessionId,
				cwd: record.cwd,
				startedAt,
				procStart: start,
				version: record.version ?? "pi",
				peerProtocol: 1,
				peerFeatures: [],
				kind: record.kind ?? "interactive",
				entrypoint: "cli",
				pidDomain: pidDomain(),
				messagingSocketPath: record.messagingSocketPath,
				name: record.name,
				nameSource: "derived",
				nameSince: startedAt,
				status: record.status,
				updatedAt: now,
				statusUpdatedAt: now,
			},
			null,
			2,
		),
		{ mode: 0o644 },
	);

	writeFileSync(
		keyPath,
		JSON.stringify({ peerToken: record.peerToken, procStart: start, pidDomain: pidDomain() }),
		{ mode: 0o600 },
	);
	chmodSync(keyPath, 0o600);

	return { jsonPath, keyPath };
}

/** Rewrites only the status fields, leaving the rest of the registration intact. */
export function updateStatus(pid: number, status: string): void {
	const jsonPath = join(SESSIONS_DIR, `${pid}.json`);
	try {
		const doc = JSON.parse(readFileSync(jsonPath, "utf8")) as Record<string, unknown>;
		if (doc.status === status) return;
		const now = Date.now();
		writeFileSync(jsonPath, JSON.stringify({ ...doc, status, updatedAt: now, statusUpdatedAt: now }, null, 2));
	} catch {
		// A missing registration means we are shutting down; nothing to update.
	}
}

export function unregister(pid: number, socketPath: string): void {
	for (const path of [
		join(SESSIONS_DIR, `${pid}.json`),
		join(SESSIONS_DIR, keyFileName(pid, socketPath)),
		socketPath,
	]) {
		try {
			rmSync(path, { force: true });
		} catch {
			// Best effort: a leftover entry is ignored once the pid is seen dead.
		}
	}
}

/** Live sessions other than `selfPid`, newest registration first. */
export function listPeers(selfPid: number): SessionRecord[] {
	let entries: string[];
	try {
		entries = readdirSync(SESSIONS_DIR);
	} catch {
		return [];
	}

	const peers: SessionRecord[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".json")) continue;
		let doc: Record<string, unknown>;
		try {
			doc = JSON.parse(readFileSync(join(SESSIONS_DIR, entry), "utf8")) as Record<string, unknown>;
		} catch {
			continue;
		}
		const pid = typeof doc.pid === "number" ? doc.pid : Number.NaN;
		const socketPath = typeof doc.messagingSocketPath === "string" ? doc.messagingSocketPath : "";
		if (!Number.isInteger(pid) || pid === selfPid || socketPath === "") continue;
		if (!isAlive(pid, typeof doc.procStart === "string" ? doc.procStart : undefined)) continue;
		if (!existsSync(socketPath)) continue;

		peers.push({
			pid,
			sessionId: String(doc.sessionId ?? ""),
			cwd: String(doc.cwd ?? ""),
			name: String(doc.name ?? `pid-${pid}`),
			status: String(doc.status ?? "unknown"),
			messagingSocketPath: socketPath,
			startedAt: typeof doc.startedAt === "number" ? doc.startedAt : undefined,
			kind: typeof doc.kind === "string" ? doc.kind : undefined,
			version: typeof doc.version === "string" ? doc.version : undefined,
		});
	}
	peers.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
	return peers;
}

/** The token a peer requires as the first line on its socket. */
export function peerTokenFor(peer: SessionRecord): string | undefined {
	return readPeerToken(peer.pid, peer.messagingSocketPath);
}

/**
 * Token for whoever listens at `socketPath`. Used when reporting a delivery
 * verdict, where the frame names its sender by socket rather than by registry
 * entry.
 */
export function peerTokenForSocket(socketPath: string): string | undefined {
	const pid = Number.parseInt(basename(socketPath).replace(/\.sock$/, ""), 10);
	return Number.isInteger(pid) ? readPeerToken(pid, socketPath) : undefined;
}

function readPeerToken(pid: number, socketPath: string): string | undefined {
	try {
		const raw = readFileSync(join(SESSIONS_DIR, keyFileName(pid, socketPath)), "utf8");
		const token = (JSON.parse(raw) as { peerToken?: unknown }).peerToken;
		return typeof token === "string" && token !== "" ? token : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Prepares the socket directory and validates the path. Claude Code refuses a
 * sockets directory that is a symlink or owned by someone else, so a shared
 * directory has to satisfy the stricter of the two policies.
 */
export function ensureSocketDir(socketPath: string): void {
	if (Buffer.byteLength(socketPath, "utf8") > MAX_SOCKET_PATH_BYTES) {
		throw new Error(
			`socket path is too long for a Unix socket (${socketPath.length} > ${MAX_SOCKET_PATH_BYTES} bytes): ` +
				`${socketPath}. Set CLAUDE_CODE_TMPDIR to a shorter directory.`,
		);
	}
	mkdirSync(SOCKET_DIR, { recursive: true, mode: 0o700 });
	if (!statSync(SOCKET_DIR).isDirectory()) {
		throw new Error(`${SOCKET_DIR} exists but is not a directory`);
	}
}
