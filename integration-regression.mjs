/**
 * End-to-end regression check: drive the REAL plugin (apply → provider →
 * fetch) against a REAL harness Session, then run the harness's own
 * persistence validation (validateStoredEvents) on the session's events —
 * exactly the function whose refusal broke history loading in the field.
 *
 * Requires the harness packages resolvable from this directory (node_modules
 * symlinked to the dsh profile's hoisted tree, see .gitignore), then run:
 *   node integration-regression.mjs
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Session } from "@deepseek-ai/dsh-session";
import { validateStoredEvents } from "@deepseek-ai/dsh-session-persistence";

// Stub the network: one successful scrape of example.com.
globalThis.fetch = async (url, init) => {
  assert.equal(String(url), "https://api.firecrawl.dev/v2/scrape");
  return new Response(JSON.stringify({
    success: true,
    data: {
      markdown: "# Example Domain\n\nThis domain is for use in documentation examples.",
      metadata: { title: "Example Domain", sourceURL: "https://example.com", url: "https://example.com/", statusCode: 200 }
    }
  }), { status: 200 });
};

const diagDir = mkdtempSync(join(tmpdir(), "dsh-fc-integration-"));
const session = Session.create("session-integration-regression", undefined, {
  version: 3,
  id: "session-integration-regression",
  createdAt: Date.now(),
  isSeeded: false
});
let provider = null;
const ctx = {
  web: { registerFetchProvider(p) { provider = p; } },
  inject: () => {},
  fiber: { state: 0 },
  get: (id) => {
    if (id === "credentials") return { resolve: async () => ({ value: "integration-key" }) };
    if (id === "agents") return { currentInitiator: () => ({ session }) };
    return undefined;
  }
};

const { apply } = await import("./index.js");
apply(ctx, { apiKeyEnv: "FIRECRAWL_API_KEY", fullCopyDir: diagDir });
assert.ok(provider, "provider registered");

const result = await provider.fetch({ url: "https://example.com" });
assert.equal(result.statusCode, 200, "fetch succeeds end to end");

// The record write is fire-and-forget; give it a tick to settle.
await new Promise((resolve) => setTimeout(resolve, 50));

// 1. No plugin-owned event may exist in the durable session log.
const events = session.snapshotEvents();
const pluginEvents = events.filter((e) => e.type.startsWith("web/firecrawl"));
assert.deepEqual(pluginEvents, [], `session log contains plugin-owned events: ${pluginEvents.map((e) => e.type)}`);

// 2. The harness's own persistence validation (the field failure) must pass
//    on this build's known-event catalog — which does NOT include
//    web/firecrawl-fetch-request.
validateStoredEvents(session.header, events, { path: "integration-regression" });

// 3. The diagnostic record exists in the ephemeral local file instead.
const diagFile = join(diagDir, "requests.jsonl");
assert.ok(existsSync(diagFile), "requests.jsonl written under the full-copy dir");
const [record] = readFileSync(diagFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
assert.equal(record.endpoint, "https://api.firecrawl.dev/v2/scrape");
assert.equal(record.url, "https://example.com");
assert.equal(typeof record.time, "number");

console.log("ok: fetch works, session log stays clean, validateStoredEvents passes, diagnostic recorded locally");
rmSync(diagDir, { recursive: true, force: true });
console.log("INTEGRATION REGRESSION PASSED");
