# pi-claude-peers

*[中文](README.zh-CN.md)*

[![npm](https://img.shields.io/npm/v/pi-claude-peers)](https://www.npmjs.com/package/pi-claude-peers)
[![license](https://img.shields.io/npm/l/pi-claude-peers)](./LICENSE)
[![pi package](https://img.shields.io/badge/pi-package-5b5bd6)](https://pi.dev/packages)

Two-way messaging between [pi](https://pi.dev) and [Claude Code](https://claude.com/claude-code) sessions running on the same machine.

Claude Code sessions already find and message each other through a local registry and per-session Unix sockets — that is what its `ListAgents` and `SendMessage` tools use. This extension makes a pi session a participant in the same system: pi shows up in Claude Code's session list, receives messages sent to it, and gets two tools of its own for listing and messaging the other agents.

No patched builds, no forks, no wrapper process. Claude Code documents the socket contract itself — run it with `--verbose` and it prints the frame format.

```
Claude Code ──SendMessage──▶ pi        (arrives as a user turn, optionally gated)
pi          ──send_message─▶ Claude Code
```

## Requirements

- pi with extensions enabled (default)
- Claude Code 2.1.x on the same machine and the same user account
- macOS or Linux — Windows uses named pipes, which this bridge does not speak yet

## Install

```bash
pi install npm:pi-claude-peers
```

Or from git, or for one run only:

```bash
pi install git:github.com/sunflowerfa/pi-claude-peers
pi -e npm:pi-claude-peers
```

Nothing else is required. The extension registers itself when a session starts and removes its registration when the session ends.

> Pi packages run with full system access. This one lets other local processes deliver messages that start a turn in your session — read [Security](#security) before installing.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PI_CLAUDE_PEERS_AUTO_ACCEPT` | unset | `1` delivers incoming messages without asking |
| `PI_CLAUDE_PEERS_FROM_MODE` | `prompting` | Permission-mode class advertised to recipients: `prompting` or `bypass` |
| `PI_CLAUDE_PEERS_DEBUG` | unset | File path for a trace of every frame (auth tokens redacted) |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code config root, honoured the same way Claude Code honours it |
| `CLAUDE_CODE_TMPDIR` | `/tmp` | Parent of the sockets directory |

Environment variables are read from the process pi was launched with. Adding one to your shell profile only affects **newly opened** terminals — an already-running shell keeps the environment it started with.

## Tools

| Tool | Behaviour |
|---|---|
| `list_agents` | Live peer sessions with name, status and working directory |
| `send_message` | Sends to a peer by name (exact, or an unambiguous prefix) |

A message arrives in the other session as a user turn. The recipient does not see your conversation, so the message has to carry its own context.

## Security

Everything here is confined to one user account on one machine. The socket is `0600` inside a `0700` directory, and the auth key is `0600`, so only your own uid can reach an inbox — the same trust boundary as your shell.

Within that boundary, two gates decide whether a message reaches an agent:

**Inbound to pi.** A delivered message always starts a turn, so the default is to ask before delivering. A session with no dialog-capable UI (`pi -p`) cannot ask; it declines rather than hanging the sender. `PI_CLAUDE_PEERS_AUTO_ACCEPT=1` removes the gate for unattended use — with it set, any process running as you can drive that pi session.

**Inbound to Claude Code.** Claude Code decides for itself, from its own `crossSessionInbound` setting and from the `from-mode` this extension advertises. Because pi is not a Claude Code session and has no Claude Code permission mode, the default advertised class is `prompting`, the conservative one: a Claude Code session running without prompts will hold a pi message for its user's review instead of acting on it unseen. Setting `PI_CLAUDE_PEERS_FROM_MODE=bypass` suppresses that review in *someone else's* session — only do it when both sides are yours and you want them unattended.

The two gates are independent. Turning one off does not turn off the other.

## Protocol

Newline-delimited JSON over `AF_UNIX`. Three artifacts make a session addressable:

| Artifact | Path | Contents |
|---|---|---|
| Registration | `~/.claude/sessions/<pid>.json` | `pid`, `sessionId`, `cwd`, `name`, `status`, `messagingSocketPath`, `peerProtocol: 1`, `procStart` |
| Auth key | `~/.claude/sessions/<pid>.<sha256(socketPath)>.key` | `peerToken`, `procStart`, `pidDomain` |
| Inbox | `<CLAUDE_CODE_TMPDIR>/cc-socks/<pid>.sock` | The listening socket |

A connection carries an auth line first, then frames:

```json
{"type":"auth","token":"<the recipient's peerToken>"}
{"msgV":1,"msg_id":"<uuid>","type":"user","message":{"role":"user","content":"…"},"priority":"next","from":"uds:/tmp/cc-socks/<sender pid>.sock"}
```

Four details are load-bearing, and each one fails *silently* when you get it wrong. They are the reason this extension exists as more than a dozen lines of socket code.

### 1. `procStart` is recorded in UTC

It is the guard against pid reuse: a registration whose recorded start time no longer matches the live process belongs to a recycled pid. But `ps -o lstart=` prints the ambient timezone while Claude Code stores UTC, and the two are compared as strings. Read the registry without pinning `TZ=UTC` and, outside UTC, every peer looks like a dead pid — the registry appears empty and nothing is reachable.

### 2. Delivery status is a callback, not a reply

The verdict does not come back on the inbound connection. The recipient opens a **new** connection to the sender's own inbox — the address in the message's `from` — and sends a control frame there:

```json
{"type":"control","action":"peer_message_status","status":"delivered","reason":"…","from":"uds:…","orig_msg_id":"<the sender's msg_id>"}
```

Statuses are `delivered`, `held`, `denied`, `expired`, `refused` and `dropped`. Answering on the inbound connection instead looks to the sender like no answer at all: it reports the send as failed even though the message arrived.

Claude Code reports a status only when it holds, refuses or drops a message; one it delivers straight through produces no frame at all.

### 3. The envelope is mandatory and byte-exact

The message body is wrapped in an envelope naming the sender:

```
<cross-session-message from="uds:…" from-name="pi-demo-a1" from-mode="prompting">
…
</cross-session-message>
```

The receiver parses it, **re-serializes what it parsed, and keeps the origin only if the result is byte-identical to what arrived**. Attribute order is fixed — `from`, `from-session`, `hop-chain`, `from-name`, `from-mode` — and a mismatch is not rejected but silently downgraded: the message still arrives, just unattributed, with no verified pid, no peer name and no review hold. Sending a bare string instead of an envelope produces exactly that.

Three things break the round-trip and are handled in `wire.ts`:

- `from-mode` is validated against a closed set — only `bypass` and `prompting`.
- `from-name` is normalized and capped at 64 characters by the receiver, so a longer or unnormalized name has to be shortened before sending.
- Envelope tags occurring inside the body are rewritten by the receiver, so they are escaped before sending.

A correctly enveloped message shows up in Claude Code as:

```
Held peer message — from uds:/tmp/cc-socks/<pid>.sock [verified pid <pid>]
(peer claims name: pi-…); preview: «…» — not delivered to Claude (1 held).
```

and, once approved, is attributed to its sender: `@ pi-… ❯ <body>`.

### 4. The rendered view is not what the model receives

Claude Code renders the attributed line above but hands the raw envelope to the model. Seeing the tags in a transcript is not evidence that parsing failed — check the rendered line instead.

## Tests

The envelope check is reproduced in `wire.ts` and exercised against the builder, since that is where silent breakage lives:

```bash
npm test    # node --test --experimental-strip-types
```

The package layout follows pi's conventions:

```
extensions/pi-claude-peers/   index.ts, registry.ts, wire.ts
test/                      wire.test.ts
```

## Limitations

- **Windows is unsupported.** Claude Code uses named pipes there; this bridge speaks `AF_UNIX` only. Contributions welcome.
- **Control frames beyond delivery status are not implemented** — idle notifications (`notify_when_idle`), file attachments and artifact hand-off are answered with `dropped` so the sender is not left waiting.
- **This is not a published API.** Claude Code prints the socket contract in verbose output and the registry format is stable in practice, but it can change between releases. Verified against Claude Code 2.1.261.

## License

MIT
