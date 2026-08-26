/**
 * Standalone test for the Firecrawl fetch provider.
 * Run from this directory:  node test.mjs
 * Stubs globalThis.fetch and the cordis plugin context; asserts wire shape,
 * response mapping, fetched-length capping (trim + tmp full-copy spill),
 * non-2xx-target semantics, error paths, and abort handling.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let captured = null;
let fakeScrapeOverride = null;
const fakeScrape = {
	success: true,
	data: {
		markdown: "# Example Domain\n\nThis domain is for use in documentation examples.",
		metadata: {
			title: "Example Domain",
			sourceURL: "https://example.com",
			url: "https://example.com/",
			statusCode: 200,
			contentType: "text/html"
		}
	}
};

globalThis.fetch = async (url, init) => {
	captured = { url: String(url), init };
	if (process.env.FAKE_HTTP === "401") {
		return new Response(JSON.stringify({ success: false, error: "Unauthorized: Invalid token" }), { status: 401 });
	}
	if (process.env.FAKE_HTTP === "redirect") {
		return new Response(null, { status: 302, headers: { location: "https://evil.example" } });
	}
	return new Response(JSON.stringify(fakeScrapeOverride ?? fakeScrape), { status: 200 });
};

const mod = await import("./index.js");
const {
	FirecrawlFetchProvider, FIRECRAWL_PROVIDER_ID, Config, apply, inject, name,
	capFetchedLength, fullCopyName, truncateUtf8, mapScrapeResponse, assertHttpUrl,
	FIRECRAWL_DEFAULT_MAX_FETCHED_LENGTH
} = mod;

// ── plugin surface ─────────────────────────────────────────────────────────
assert.equal(FIRECRAWL_PROVIDER_ID, "dsh-fetch-url-firecrawl");
assert.equal(name, "dsh-fetch-url-firecrawl");
assert.deepEqual(inject, ["web"]);
assert.ok(Config, "Config schema exported");
assert.equal(FIRECRAWL_DEFAULT_MAX_FETCHED_LENGTH, 4096);
console.log("ok: plugin surface (id, name, inject, Config, default cap 4096)");

// ── fake cordis context ────────────────────────────────────────────────────
const webStub = {
	registered: [],
	registerFetchProvider(p) { this.registered.push(p); return () => {}; },
};

// Minimal mounted-settings simulation: installSettingsSection calls
// ctx.inject(["settings"], fn); we build a fake scoped ctx whose register()
// returns a live-mutable scope captured in `settingsScope` for assertions and
// hot-reload. `noopInject` models a host with no settings service mounted.
let settingsScope = null;
function fakeInject(deps, fn) {
	if (!Array.isArray(deps) || !deps.includes("settings")) return; // not mounted
	const sctx = {
		settings: {
			register(ns, schema, opts) {
				let value = { ...opts.base };
				const watchers = [];
				settingsScope = {
					ns, schema, opts,
					get: () => value,
					watch: (cb) => watchers.push(cb),
					set(next) { value = { ...next }; watchers.forEach((cb) => cb()); }
				};
				return settingsScope;
			}
		},
		effect: () => {}
	};
	fn(sctx);
}
const noopInject = () => {}; // settings service not mounted → composed-as-is

const ctx = {
	web: webStub, // injected property (inject: ['web'])
	inject: fakeInject,
	fiber: { state: 0 }, // not unloading/disposed (dsh-settings isUnloading guard)
	get: (id) => {
		if (id === "credentials") return { resolve: async (ref) => (ref === "FIRECRAWL_API_KEY" ? { value: "fc-test-key" } : undefined) };
		return undefined; // agents → recordRequest no-op
	},
};

// ── apply() registers into ctx.web ─────────────────────────────────────────
apply(ctx, { apiKeyEnv: "FIRECRAWL_API_KEY" });
assert.equal(webStub.registered.length, 1);
const provider = webStub.registered[0];
assert.equal(provider.id, "dsh-fetch-url-firecrawl");
assert.equal(provider.available(), true);
console.log("ok: apply() registers a usable fetch provider under id 'dsh-fetch-url-firecrawl'");

// ── settings section: namespace registered + hot reload ────────────────────
assert.ok(settingsScope, "apply() registered a settings section");
assert.equal(settingsScope.ns, "dsh-fetch-url-firecrawl", "namespace is the plugin's id");
assert.deepEqual(settingsScope.opts.base, { apiKeyEnv: "FIRECRAWL_API_KEY" }, "base is the entry config");
// Hot reload: the provider reads current() per fetch, so a settings change
// takes effect on the next fetch without re-applying the plugin.
const hotDir = mkdtempSync(join(tmpdir(), "dsh-fetch-url-firecrawl-hot-"));
fakeScrapeOverride = {
	success: true,
	data: {
		markdown: "z".repeat(300),
		metadata: { sourceURL: "https://hot.example/a", url: "https://hot.example/a", statusCode: 200 }
	}
};
settingsScope.set({ apiKeyEnv: "FIRECRAWL_API_KEY", maxFetchedLength: 60, fullCopyDir: hotDir });
const hotResult = await provider.fetch({ url: "https://hot.example/a" });
const hotContent = hotResult.body.content.split("\n\n[fetched content")[0];
assert.ok(Buffer.byteLength(hotContent, "utf8") <= 60, "hot-changed cap (60) applied, not the old default");
assert.ok(!hotResult.body.content.includes("z".repeat(61)), "trimmed below the full 300-char length");
assert.ok(hotResult.body.content.endsWith(`\n\n[fetched content truncated to 60 bytes; full copy: ${join(hotDir, fullCopyName("https://hot.example/a"))}]`), "hot-changed cap + dir honored");
assert.equal(hotResult.truncated, true, "truncated flag set on the seam result");
assert.ok(existsSync(join(hotDir, fullCopyName("https://hot.example/a"))), "hot spill written to the hot dir");
fakeScrapeOverride = null;
rmSync(hotDir, { recursive: true, force: true });
// Restore the base section so later tests run against the defaults.
settingsScope.set({ apiKeyEnv: "FIRECRAWL_API_KEY" });
console.log("ok: settings section registered (ns 'dsh-fetch-url-firecrawl') and hot-reloaded");

// ── happy path: wire shape + mapping ───────────────────────────────────────
const result = await provider.fetch({ url: "https://example.com" });
assert.equal(captured.url, "https://api.firecrawl.dev/v2/scrape");
assert.equal(captured.init.method, "POST");
assert.equal(captured.init.headers.authorization, "Bearer fc-test-key");
assert.equal(captured.init.headers["content-type"], "application/json");
const body = JSON.parse(captured.init.body);
assert.deepEqual(body, { url: "https://example.com", formats: ["markdown"] });
assert.equal(result.url, "https://example.com/", "final URL from metadata.url");
assert.equal(result.statusCode, 200, "status from metadata.statusCode");
assert.deepEqual(result.body, { kind: "text", content: fakeScrape.data.markdown }, "markdown maps to a text body");
assert.equal(result.truncated, false, "under-cap fetch is not truncated");
console.log("ok: wire shape (POST /v2/scrape, url + formats) and result mapping");

// ── non-2xx TARGET is a result, not an error ───────────────────────────────
fakeScrapeOverride = {
	success: true,
	data: {
		markdown: "# Not Found\n\nPage missing.",
		metadata: { sourceURL: "https://example.com/nope", url: "https://example.com/nope", statusCode: 404, error: "Not Found" }
	}
};
const notFound = await provider.fetch({ url: "https://example.com/nope" });
assert.equal(notFound.statusCode, 404, "404 target resolves descriptively");
assert.equal(notFound.body.content, "# Not Found\n\nPage missing.");
assert.equal(notFound.truncated, false);
fakeScrapeOverride = null;
console.log("ok: non-2xx target page is a result with its status, not a throw");

// ── html fallback when markdown is absent ──────────────────────────────────
fakeScrapeOverride = {
	success: true,
	data: {
		html: "<html><body>content</body></html>",
		metadata: { sourceURL: "https://x.example", url: "https://x.example", statusCode: 200 }
	}
};
const htmlResult = await provider.fetch({ url: "https://x.example" });
assert.deepEqual(htmlResult.body, { kind: "html", content: "<html><body>content</body></html>" }, "html-only scrape degrades to the html arm");
fakeScrapeOverride = null;
console.log("ok: html-only response degrades to kind 'html'");

// ── URL validation ─────────────────────────────────────────────────────────
await assert.rejects(
	provider.fetch({ url: "ftp://example.com/file" }),
	(err) => err.code === "WEB_FETCH_URL_INVALID"
);
await assert.rejects(
	provider.fetch({ url: "not a url" }),
	(err) => err.code === "WEB_FETCH_URL_INVALID"
);
await assert.rejects(
	provider.fetch({ url: "" }),
	(err) => err.code === "WEB_FETCH_URL_INVALID"
);
assert.throws(() => assertHttpUrl("javascript:alert(1)"), (err) => err.code === "WEB_FETCH_URL_INVALID");
console.log("ok: non-HTTP(S) URLs rejected locally before any API call");

// ── retrieved-length cap: trim + tmp full-copy spill ───────────────────────
const capDir = mkdtempSync(join(tmpdir(), "dsh-fetch-url-firecrawl-cap-test-"));
const longMarkdown = "# Long page\n\n" + "x".repeat(9000) + " END-MARKER";
fakeScrapeOverride = {
	success: true,
	data: {
		markdown: longMarkdown,
		metadata: { title: "Long page", sourceURL: "https://long.example/a", url: "https://long.example/a", statusCode: 200 }
	}
};
const capWeb = { registered: [], registerFetchProvider(p) { this.registered.push(p); return () => {}; } };
const capCtx = { web: capWeb, inject: noopInject, get: (id) => (id === "credentials" ? { resolve: async () => ({ value: "k" }) } : undefined) };
apply(capCtx, { apiKeyEnv: "FIRECRAWL_API_KEY", maxFetchedLength: 1000, fullCopyDir: capDir });
const capResult = await capWeb.registered[0].fetch({ url: "https://long.example/a" });
assert.equal(capResult.truncated, true, "over-limit fetch flagged truncated");
assert.ok(!capResult.body.content.includes("END-MARKER"), "over-limit body trimmed");
const expectedPointer = `\n\n[fetched content truncated to 1000 bytes; full copy: ${join(capDir, fullCopyName("https://long.example/a"))}]`;
assert.ok(capResult.body.content.endsWith(expectedPointer), "pointer to full copy appended");
const trimmedPart = capResult.body.content.split("\n\n[fetched content")[0];
assert.ok(Buffer.byteLength(trimmedPart, "utf8") <= 1000, "trimmed content within budget");
const copyFile = join(capDir, fullCopyName("https://long.example/a"));
assert.ok(existsSync(copyFile), "full copy file written");
const copyText = readFileSync(copyFile, "utf8");
assert.ok(copyText.includes("# Long page"), "copy has title");
assert.ok(copyText.includes("https://long.example/a"), "copy has url");
assert.ok(copyText.includes("HTTP 200"), "copy has status");
assert.ok(copyText.includes("END-MARKER"), "copy has the FULL content");
assert.deepEqual(readdirSync(capDir).sort(), [fullCopyName("https://long.example/a")], "exactly one spill file");
fakeScrapeOverride = null;
rmSync(capDir, { recursive: true, force: true });
console.log("ok: over-limit body trimmed to budget, full copy spilled to tmp with pointer");

// ── default cap (4096) applies when unconfigured ───────────────────────────
fakeScrapeOverride = {
	success: true,
	data: {
		markdown: "y".repeat(5000),
		metadata: { sourceURL: "https://long.example/d", url: "https://long.example/d", statusCode: 200 }
	}
};
const defWeb = { registered: [], registerFetchProvider(p) { this.registered.push(p); return () => {}; } };
const defDir = mkdtempSync(join(tmpdir(), "dsh-fetch-url-firecrawl-default-cap-"));
apply({ web: defWeb, inject: noopInject, get: (id) => (id === "credentials" ? { resolve: async () => ({ value: "k" }) } : undefined) }, { apiKeyEnv: "FIRECRAWL_API_KEY", fullCopyDir: defDir });
const defResult = await defWeb.registered[0].fetch({ url: "https://long.example/d" });
const defTrimmed = defResult.body.content.split("\n\n[fetched content")[0];
assert.ok(Buffer.byteLength(defTrimmed, "utf8") <= 4096, "default 4096 cap applied");
assert.ok(defResult.body.content.includes("truncated to 4096 bytes"), "pointer names the default cap");
fakeScrapeOverride = null;
rmSync(defDir, { recursive: true, force: true });
console.log("ok: default maxFetchedLength 4096 enforced when unconfigured");

// ── UTF-8-safe truncation ──────────────────────────────────────────────────
{
	const cjk = "中".repeat(5000); // 3 bytes each → 15000 bytes
	const out = truncateUtf8(cjk, 100);
	assert.ok(Buffer.byteLength(out, "utf8") <= 100, "within byte budget");
	assert.ok([...out].every((ch) => ch === "中"), "no torn characters");
	assert.ok(!out.includes("\uFFFD"), "no replacement characters");
	const mixed = "abc" + "中".repeat(4000) + "def";
	const out2 = truncateUtf8(mixed, 31);
	assert.ok(Buffer.byteLength(out2, "utf8") <= 31);
	assert.ok(!out2.includes("\uFFFD"));
}
console.log("ok: truncateUtf8 snaps to character boundaries (CJK, mixed)");

// ── cap: write failure degrades gracefully ─────────────────────────────────
{
	// A regular file as the dir's parent → mkdir fails fast with ENOTDIR.
	const { writeFileSync } = await import("node:fs");
	const blocker = join(tmpdir(), `dsh-fetch-url-firecrawl-blocker-${Date.now()}.file`);
	writeFileSync(blocker, "blocker");
	const opts = { maxFetchedLength: 100, fullCopyDir: join(blocker, "impossible-subdir") };
	const mapped = mapScrapeResponse(
		{ success: true, data: { markdown: "y".repeat(500), metadata: { url: "https://x.example", statusCode: 200 } } },
		"https://x.example"
	);
	const out = await capFetchedLength(mapped, opts);
	assert.ok(out.body.content.includes("full copy unavailable"), "degraded pointer on write failure");
	assert.ok(Buffer.byteLength(out.body.content.split("\n\n[")[0], "utf8") <= 100);
	assert.equal(out.truncated, true);
	rmSync(blocker, { force: true });
}
console.log("ok: tmp write failure degrades to pointer-less trim (fetch survives)");

// ── mapScrapeResponse: success:false and unprocessable bodies ──────────────
assert.throws(
	() => mapScrapeResponse({ success: false, code: "SCRAPE_DNS_RESOLUTION_ERROR", error: 'DNS resolution failed for hostname "bad.example"' }, "https://bad.example"),
	(err) => err.code === "WEB_PROVIDER_ERROR" && /DNS resolution failed/.test(err.message)
);
assert.throws(
	() => mapScrapeResponse({ success: true, data: { metadata: { statusCode: 200 } } }, "https://x.example"),
	(err) => err.code === "WEB_PROVIDER_ERROR" && /missing markdown\/html/.test(err.message)
);
console.log("ok: success:false / unprocessable bodies surface WEB_PROVIDER_ERROR with detail");

// ── HTTP error path ────────────────────────────────────────────────────────
process.env.FAKE_HTTP = "401";
await assert.rejects(
	provider.fetch({ url: "https://example.com" }),
	(err) => err.code === "WEB_PROVIDER_ERROR" && /Invalid token/.test(err.message)
);
console.log("ok: non-2xx Firecrawl response surfaces WEB_PROVIDER_ERROR with the provider message");

// ── redirect rejection (fetch redirect:'error') ────────────────────────────
process.env.FAKE_HTTP = "redirect";
await assert.rejects(
	provider.fetch({ url: "https://example.com" }),
	(err) => err.code === "WEB_PROVIDER_ERROR"
);
console.log("ok: redirect rejected before contacting the Location target");

// ── missing credential ─────────────────────────────────────────────────────
delete process.env.FAKE_HTTP;
const noKeyProvider = new FirecrawlFetchProvider(() => ({
	resolveApiKey: async () => undefined,
	apiKeyEnv: "FIRECRAWL_API_KEY",
	baseURL: "https://api.firecrawl.dev",
	maxFetchedLength: 4096,
	fullCopyDir: "/tmp/dsh-fetch-url-firecrawl",
	recordRequest: undefined,
}));
assert.equal(noKeyProvider.available(), true, "a key RESOLVER counts as available; the miss surfaces at request time");
await assert.rejects(
	noKeyProvider.fetch({ url: "https://example.com" }),
	(err) => err.code === "WEB_PROVIDER_CREDENTIAL_MISSING" && /FIRECRAWL_API_KEY/.test(err.message)
);
console.log("ok: missing key surfaces WEB_PROVIDER_CREDENTIAL_MISSING naming the env var");

// ── abort before fetch ─────────────────────────────────────────────────────
const ac = new AbortController();
ac.abort(new Error("dsh-timeout"));
await assert.rejects(
	provider.fetch({ url: "https://example.com" }, ac.signal),
	(err) => err.code === "WEB_ABORTED"
);
console.log("ok: pre-aborted signal surfaces WEB_ABORTED");

console.log("\nALL TESTS PASSED");
