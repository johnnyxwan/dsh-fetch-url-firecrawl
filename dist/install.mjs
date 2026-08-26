#!/usr/bin/env node
/**
 * Installs the dsh-fetch-url-firecrawl profile plugin into a DSH home.
 *
 * Usage:
 *   node install.mjs [--dsh-home DIR] [--profile NAME] [--no-activate]
 *
 * Defaults: DSH_HOME env var or ~/.dsh; profile "web".
 *
 * What it does (all idempotent — safe to re-run):
 *   1. Extracts the plugin package next to the profile:
 *        <dsh-home>/profiles/<profile>/plugins/dsh-fetch-url-firecrawl/
 *   2. Symlinks it into the profile's node_modules under its package name,
 *      which is what BOTH the host loader and the client-card discovery
 *      resolve by bare name (the profile's own node_modules is on the
 *      resolution path; no global-install or pnpm involvement).
 *   3. Appends a marked entry block to the profile's cordis.patch.yml
 *        - insert: dsh-fetch-url-firecrawl (name + config)
 *      and activates the provider (skipped with --no-activate) by setting
 *      `fetchProvider: dsh-fetch-url-firecrawl` on the `web` service entry — weaving the
 *      key into an EXISTING `- id: web` entry (the loader rejects duplicate
 *      entry ids, so a second `id: web` row is only appended when the patch
 *      has no web entry at all).
 *   4. Checks the credentials store for FIRECRAWL_API_KEY and reports.
 *
 * The plugin's dsh-internal dependencies (dsh-settings, dsh-web,
 * dsh-credentials, dsh-launch-environment, schemastery) are NOT bundled —
 * they resolve from the target's dsh installation, so install on the same
 * dsh version as this kit was built against (0.1.0-rc.7).
 */
import { execFileSync } from "node:child_process";
import { lstat, access, mkdir, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_NAME = "dsh-fetch-url-firecrawl";
const PLUGIN_DIRNAME = "dsh-fetch-url-firecrawl";
const MARKER_HEAD = `# >>> ${PKG_NAME} (managed block — uninstall.mjs removes this) >>>`;
const MARKER_TAIL = `# <<< ${PKG_NAME} <<<`;
const KNOWN_GOOD_DSH = "0.1.0-rc.7";

/** Escape regex metacharacters so the marker strings match literally. */
function escapeRegExp(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
const BLOCK_RE = new RegExp(`\\n?${escapeRegExp(MARKER_HEAD)}[\\s\\S]*?${escapeRegExp(MARKER_TAIL)}\\n?`);

function args() {
	const out = { dshHome: void 0, profile: "web", activate: true };
	const argv = process.argv.slice(2);
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--dsh-home") out.dshHome = argv[++i];
		else if (argv[i] === "--profile") out.profile = argv[++i];
		else if (argv[i] === "--no-activate") out.activate = false;
		else { console.error(`unknown flag: ${argv[i]}`); process.exit(2); }
	}
	return out;
}

async function exists(p) { try { await access(p); return true; } catch { return false; } }

/**
 * Weave `fetchProvider: dsh-fetch-url-firecrawl` into the patch file's `- id: web` entry.
 * Line-based on purpose: the patch file is hand-kept YAML and this touches
 * exactly one key. Returns { changed, already } — changed when a line was
 * inserted, already when the web entry carries fetchProvider: dsh-fetch-url-firecrawl.
 */
function weaveFetchProvider(content) {
	const lines = content.split("\n");
	const start = lines.findIndex((line) => /^-\s*id:\s*web\s*$/.test(line));
	if (start === -1) return { content, changed: false, already: false, absent: true };
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) if (/^-\s/.test(lines[i]) || /^-\s*$/.test(lines[i])) { end = i; break; }
	const block = lines.slice(start, end);
	const existing = block.find((line) => /^\s*fetchProvider:/.test(line));
	if (existing !== undefined) return { content, changed: false, already: existing.includes("dsh-fetch-url-firecrawl"), absent: false };
	const keyLine = "    fetchProvider: dsh-fetch-url-firecrawl";
	const cfgIdx = block.findIndex((line) => /^\s*config:\s*$/.test(line));
	if (cfgIdx !== -1) {
		lines.splice(start + cfgIdx + 1, 0, keyLine);
	} else {
		// No config block on the entry: append one after the last 2-space key.
		let lastKey = -1;
		for (let i = 0; i < block.length; i++) if (/^  \S/.test(block[i])) lastKey = i;
		lines.splice(start + lastKey + 1, 0, "  config:", keyLine);
	}
	return { content: lines.join("\n"), changed: true, already: false, absent: false };
}

const opts = args();
const dshHome = opts.dshHome ?? process.env.DSH_HOME ?? join(homedir(), ".dsh");
const profileDir = join(dshHome, "profiles", opts.profile);
const pluginDir = join(profileDir, "plugins", PLUGIN_DIRNAME);
const patchPath = join(profileDir, "cordis.patch.yml");

console.log(`DSH home:   ${dshHome}`);
console.log(`Profile:    ${opts.profile}`);

if (!(await exists(profileDir))) {
	console.error(`profile directory not found: ${profileDir} — is this a DSH home with a "${opts.profile}" profile?`);
	process.exit(1);
}

// ── 0. dsh version sanity (best effort) ──────────────────────────────────────
try {
	const v = execFileSync("dsh", ["--version"], { encoding: "utf8", timeout: 10_000 }).trim().split("\n").pop();
	console.log(`dsh on PATH: ${v}${v !== KNOWN_GOOD_DSH ? `  (warning: kit built against ${KNOWN_GOOD_DSH})` : "  (matches kit)"}`);
} catch {
	console.log("dsh on PATH: (not found or no --version — skipping sanity check)");
}

// ── 1. extract the plugin package ────────────────────────────────────────────
const tgz = join(HERE, `${PKG_NAME}.tar.gz`);
if (!(await exists(tgz))) { console.error(`missing tarball next to this script: ${tgz}`); process.exit(1); }
await rm(pluginDir, { recursive: true, force: true });
await mkdir(pluginDir, { recursive: true });
execFileSync("tar", ["-xzf", tgz, "-C", pluginDir]);
const files = ["package.json", "index.js", "client.js", "test.mjs", "test-client.mjs"];
for (const f of files) if (!(await exists(join(pluginDir, f)))) { console.error(`tarball missing ${f}`); process.exit(1); }
console.log(`1/4 plugin files -> ${pluginDir}`);

// ── 2. profile-local node_modules symlink (bare-name resolution) ─────────────
const nmDir = join(profileDir, "node_modules");
const linkPath = join(nmDir, PKG_NAME);
await mkdir(nmDir, { recursive: true });
try { const st = await lstat(linkPath); if (st.isSymbolicLink() || st.isDirectory()) await rm(linkPath, { recursive: true, force: true }); } catch { /* absent */ }
await symlink(pluginDir, linkPath);
console.log(`2/4 symlink      ${linkPath} -> ${pluginDir}`);

// ── 3. patch entries ─────────────────────────────────────────────────────────
const patchBlock = [
	"",
	MARKER_HEAD,
	"# Firecrawl web fetch (POST /v2/scrape, markdown): fetch provider plugin",
	"# + settings card. The package resolves by bare name via the profile-local",
	"# node_modules symlink; the API key resolves per request from the",
	"# credentials store, the environment, or a literal config.apiKey.",
	"- insert:",
	"    - id: dsh-fetch-url-firecrawl",
	"      name: 'dsh-fetch-url-firecrawl'",
	"      config:",
	"        apiKeyEnv: FIRECRAWL_API_KEY",
	"        # maxFetchedLength (bytes, default 4096): fetched-content cap;",
	"        # over-limit bodies are trimmed and the full copy spills to a tmp",
	"        # file whose path is left in the tool context. Also editable in",
	"        # the GUI (Settings -> Plugins -> Firecrawl web fetch).",
	"        maxFetchedLength: 4096",
];
const existing = await (await exists(patchPath) ? readFile(patchPath, "utf8") : "");
if (existing.includes("id: dsh-fetch-url-firecrawl")) {
	console.log("3/4 patch        already contains dsh-fetch-url-firecrawl — leaving cordis.patch.yml untouched");
} else if (existing.includes(MARKER_HEAD)) {
	const patched = existing.replace(BLOCK_RE, "\n");
	patchBlock.push(MARKER_TAIL, "");
	await writeFile(patchPath, patched + patchBlock.join("\n"));
	console.log("3/4 patch        stale managed block found without the entry — replacing it");
} else {
	const header = existing === "" ? "# Patch layer for this dsh profile (top-level YAML array of loader patch entries).\n" : "";
	if (opts.activate && !/^-\s*id:\s*web\s*$/m.test(existing)) {
		// No web entry in the patch at all: a fresh id:web row is safe here
		// (the loader rejects duplicate entry ids, so we never append one
		// when an entry already exists).
		patchBlock.push(
			"",
			"- id: web",
			"  name: '@deepseek-ai/dsh-web'",
			"  config:",
			"    fetchProvider: dsh-fetch-url-firecrawl",
		);
	}
	patchBlock.push(MARKER_TAIL, "");
	await writeFile(patchPath, header + existing + patchBlock.join("\n"));
	console.log(`3/4 patch        appended managed block to ${patchPath}`);
}
// Activation against an EXISTING web entry: weave the key in (the insert row
// above is present either way; weaving is a no-op when already set).
if (opts.activate && (await exists(patchPath))) {
	const current = await readFile(patchPath, "utf8");
	const woven = weaveFetchProvider(current);
	if (woven.changed) {
		await writeFile(patchPath, woven.content);
		console.log("3/4 patch        wove fetchProvider: dsh-fetch-url-firecrawl into the existing - id: web entry");
	} else if (woven.already) {
		console.log("3/4 patch        web entry already carries fetchProvider: dsh-fetch-url-firecrawl");
	} else if (!woven.absent) {
		console.warn("3/4 patch        WARNING: the web entry sets a different fetchProvider — not touching it");
	}
}

// ── 4. credentials + smoke tests + report ────────────────────────────────────
const credPath = join(dshHome, ".credentials.yaml");
let keyOk = false;
if (await exists(credPath)) keyOk = /^FIRECRAWL_API_KEY:\s*\S/m.test(await readFile(credPath, "utf8"));
if (!process.env.FIRECRAWL_API_KEY) keyOk = false; // env also satisfies

console.log("4/4 credentials  " + (keyOk
	? "FIRECRAWL_API_KEY present (credentials store or environment)"
	: "FIRECRAWL_API_KEY NOT FOUND — add it to .credentials.yaml, export it, or set a literal config.apiKey:"));
if (!keyOk) console.log(`     ${credPath}   (add: FIRECRAWL_API_KEY: fc-...)`);

let tests = "skipped (no node?)";
try {
	execFileSync("node", ["test.mjs"], { cwd: pluginDir, encoding: "utf8", timeout: 60_000, stdio: "pipe" });
	execFileSync("node", ["test-client.mjs"], { cwd: pluginDir, encoding: "utf8", timeout: 60_000, stdio: "pipe" });
	tests = "both suites pass";
} catch (err) {
	const out = String(err.stdout ?? "") + String(err.stderr ?? "");
	if (/Cannot find package/.test(out)) tests = "FAILED — dsh-internal packages did not resolve (dsh version mismatch?)";
	else if (err.code === 127 || /ENOENT/.test(String(err.message))) tests = "skipped (node not found)";
	else tests = "FAILED (see below)";
	if (/FAILED/.test(tests)) console.log(out.split("\n").slice(-8).join("\n"));
}
console.log(`     smoke tests  ${tests}`);

console.log(`
Done. Next steps:
  1. Restart the dsh server in that environment (or start it).
  2. Open the GUI, refresh the page, Settings -> Plugins -> "Plugin configuration":
     the "Firecrawl web fetch" card should appear (Max fetched length).
  3. Verify with a web_fetch from a new session — content should be Firecrawl
     markdown, capped at the configured maxFetchedLength (default 4096 bytes,
     full copy spilled to a file when trimmed).
Uninstall later with:  node uninstall.mjs --dsh-home ${dshHome} --profile ${opts.profile}
`);
