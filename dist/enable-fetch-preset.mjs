#!/usr/bin/env node
/**
 * Enables the model-facing web fetch tool in the shipped coding-agent presets
 * (`standard` and `code`), which ship with `fetch: false` on their `tool-web`
 * row. Without this, no stock session can call the fetch tool at all.
 *
 * The preset files are SHIPPED (system-trusted) and live inside the dsh
 * installation, so this is a deployment-local patch:
 *   - <dsh-root>/config/agent-presets/standard/agent.cordis.yml
 *   - <dsh-root>/config/agent-presets/code/agent.cordis.yml
 *
 * The patch flips exactly one line in each file — the `fetch:` key inside the
 * `- id: tool-web` entry — from `false` to `true`. Everything else is untouched.
 *
 * Usage:
 *   node enable-fetch-preset.mjs [--dsh-root DIR] [--backup-dir DIR] [--restore]
 *
 * Defaults: DSH_ROOT resolved from the `dsh` binary on PATH; backup dir is
 * <dsh-home>/preset-fetch-backups/<dsh version>/ mirroring the file layout.
 *
 * Behavior (idempotent — safe to re-run, e.g. after a dsh upgrade):
 *   - untouched file  -> original backed up once, then patched
 *   - patched file    -> skipped
 *   - --restore       -> put the backed-up originals back
 *
 * A dsh server running against the patched tree should be RESTARTED so every
 * new session composes the enabled preset (existing sessions keep the preset
 * they were created with).
 */
import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, writeFile, cp, realpath } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

function args() {
	const out = { dshRoot: void 0, backupDir: void 0, restore: false };
	const argv = process.argv.slice(2);
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--dsh-root") out.dshRoot = argv[++i];
		else if (argv[i] === "--backup-dir") out.backupDir = argv[++i];
		else if (argv[i] === "--restore") out.restore = true;
		else { console.error(`unknown flag: ${argv[i]}`); process.exit(2); }
	}
	return out;
}

async function exists(p) { try { await lstat(p); return true; } catch { return false; } }

/** Resolve the dsh package root from the `dsh` binary on PATH. */
async function resolveDshRoot() {
	const bin = execFileSync("sh", ["-c", "command -v dsh"], { encoding: "utf8" }).trim();
	let cur = await realpath(bin);
	for (let i = 0; i < 12; i++) {
		const pkg = join(cur, "package.json");
		if (await exists(pkg)) {
			const meta = JSON.parse(await readFile(pkg, "utf8"));
			if (meta.name === "@deepseek-ai/dsh") return cur;
		}
		const parent = dirname(cur);
		if (parent === cur) break;
		cur = parent;
	}
	throw new Error(`could not resolve the @deepseek-ai/dsh package root from ${bin} — pass --dsh-root`);
}

/**
 * Flip `fetch: false` -> `fetch: true` inside the `- id: tool-web` entry only.
 * Returns { text, changed, found } — found is false when the file has no
 * tool-web entry at all.
 */
function enableFetchInToolWeb(text) {
	const lines = text.split("\n");
	const start = lines.findIndex((line) => /^- id: tool-web\s*$/.test(line));
	if (start === -1) return { text, changed: false, found: false };
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) if (/^-\s/.test(lines[i]) || /^-\s*$/.test(lines[i])) { end = i; break; }
	for (let i = start; i < end; i++) {
		if (/^\s*fetch:\s*true\s*$/.test(lines[i])) return { text, changed: false, found: true };
		if (/^\s*fetch:\s*false\s*$/.test(lines[i])) {
			lines[i] = lines[i].replace("fetch: false", "fetch: true");
			return { text: lines.join("\n"), changed: true, found: true };
		}
	}
	return { text, changed: false, found: true };
}

const PRESETS = ["standard", "code"];

const opts = args();
const root = opts.dshRoot ?? await resolveDshRoot();
console.log(`dsh root: ${root}`);

let version = "unknown";
try {
	const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
	version = pkg.version;
} catch { /* keep going */ }
const backupDir = opts.backupDir ?? join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "preset-fetch-backups", version);
// Layout: <backupDir>/agent-presets/<preset>/agent.cordis.yml

let acted = 0;
for (const preset of PRESETS) {
	const rel = join("agent-presets", preset, "agent.cordis.yml");
	const path = join(root, "config", rel);
	if (!(await exists(path))) { console.log(`skip  ${rel}  (absent)`); continue; }
	const backup = join(backupDir, rel);
	const text = await readFile(path, "utf8");

	if (opts.restore) {
		if (!(await exists(backup))) { console.log(`skip  ${rel}  (no backup to restore)`); continue; }
		await cp(backup, path);
		console.log(`restore  ${rel}`);
		acted++;
		continue;
	}

	const { text: next, changed, found } = enableFetchInToolWeb(text);
	if (!found) { console.log(`skip  ${rel}  (no tool-web entry found)`); continue; }
	if (!changed) { console.log(`ok      ${rel}  (fetch already enabled)`); continue; }
	if (!(await exists(backup))) {
		// First touch: preserve the pristine original before mutating. A
		// backup from a previous patch is never clobbered after an upgrade.
		await mkdir(dirname(backup), { recursive: true });
		await writeFile(backup, text, "utf8");
		console.log(`backup  ${rel}  -> ${backup}`);
	} else {
		console.log(`backup  ${rel}  (backup already present — keeping it)`);
	}
	await writeFile(path, next, "utf8");
	console.log(`patched ${rel}  (tool-web fetch: true)`);
	acted++;
}

console.log(
	opts.restore
		? `\nDone${acted ? ` — restored ${acted} file(s)` : " (nothing to restore)"}.\nRestart the dsh server to pick up the restored presets.`
		: `\nDone${acted ? ` — patched ${acted} file(s)` : " (all already enabled)"}.\n  Restart the dsh server so new sessions compose the enabled presets.\n  Re-run this script after any dsh upgrade.\n  Restore originals with:  node ${fileURLToPath(import.meta.url)} --restore`
);
