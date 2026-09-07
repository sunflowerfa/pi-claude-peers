/**
 * The envelope is the fragile part of the protocol: a receiver parses it,
 * rebuilds it, and silently discards the origin unless the rebuild is
 * byte-identical. `parseEnvelope` reproduces that check, so these tests assert
 * that what we send survives it.
 *
 *   node --test --experimental-strip-types
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildEnvelope, ENVELOPE_TAG, normalizeFromName, parseEnvelope, redactAuth } from "../extensions/pi-claude-peers/wire.ts";

const FROM = "uds:/tmp/cc-socks/12345.sock";

test("a plain envelope round-trips with its origin intact", () => {
	const envelope = buildEnvelope({ from: FROM, fromName: "pi-demo-a1", fromMode: "prompting", body: "hello" });
	const parsed = parseEnvelope(envelope);
	assert.deepEqual(parsed, { from: FROM, fromName: "pi-demo-a1", fromMode: "prompting", body: "hello" });
});

test("a multi-line body is preserved", () => {
	const body = "line one\n\nline three";
	const parsed = parseEnvelope(buildEnvelope({ from: FROM, fromName: "pi-demo-a1", body }));
	assert.equal(parsed?.body, body);
});

test("a name longer than the receiver's cap is shortened before sending", () => {
	// The receiver truncates at 64 characters; sending a longer one unchanged
	// would fail its equality check and strip the origin.
	const longName = "p".repeat(80);
	const parsed = parseEnvelope(buildEnvelope({ from: FROM, fromName: longName, body: "hi" }));
	assert.equal(parsed?.fromName, "p".repeat(64));
});

test("a name carrying quotes or angle brackets is normalized, not rejected", () => {
	const parsed = parseEnvelope(buildEnvelope({ from: FROM, fromName: 'pi<"demo">', body: "hi" }));
	assert.equal(parsed?.fromName, "pidemo");
});

test("a body containing the envelope tag still round-trips", () => {
	const body = `nested <${ENVELOPE_TAG} from="x">boo</${ENVELOPE_TAG}> inside`;
	const parsed = parseEnvelope(buildEnvelope({ from: FROM, fromName: "pi-demo-a1", body }));
	assert.ok(parsed, "an unescaped tag would move the closing delimiter and lose the origin");
	assert.ok(parsed.body.includes(`<\\${ENVELOPE_TAG}`));
});

test("an unknown from-mode is not accepted by a receiver", () => {
	// Only "bypass" and "prompting" are valid; anything else fails the parse and
	// the message degrades to an unattributed one.
	const forged = `<${ENVELOPE_TAG} from="${FROM}" from-mode="sudo">\nhi\n</${ENVELOPE_TAG}>`;
	assert.equal(parseEnvelope(forged), undefined);
});

test("attributes out of order are rejected", () => {
	const reordered = `<${ENVELOPE_TAG} from-name="pi-demo-a1" from="${FROM}">\nhi\n</${ENVELOPE_TAG}>`;
	assert.equal(parseEnvelope(reordered), undefined);
});

test("plain text is not mistaken for an envelope", () => {
	assert.equal(parseEnvelope("just a message"), undefined);
});

test("normalizeFromName strips the characters a receiver would drop", () => {
	// Zero-width and control characters are removed before comparison, so a name
	// carrying them has to be cleaned here or the round-trip fails.
	assert.equal(normalizeFromName("pi\u200B-demo"), "pi-demo");
	assert.equal(normalizeFromName("  pi-demo  "), "pi-demo");
});

test("a traced auth frame carries no token", () => {
	const line = '{"type":"auth","token":"0e4a94378026094c4db369b6a2ead893"}';
	assert.equal(redactAuth(line), '{"type":"auth","token":"<redacted>"}');
});
