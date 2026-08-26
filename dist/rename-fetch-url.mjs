#!/usr/bin/env node
/**
 * Renames the model-facing web fetch tool from `web_fetch` to `fetch_url`
 * across the dsh installation that serves this deployment.
 *
 * The tool name is hardcoded in four dsh packages (no config seam exists), so
 * a deployment-local patch is the only lever:
 *   - @deepseek-ai/dsh-tool-web            host: the tool name + LLM prompt text
 *   - @deepseek-ai/dsh-client-ui-tool      browser: the web card row (key/title/icon)
 *   - @deepseek-ai/dsh-client-connection   browser: name-keyed call/result presenters
 *   - @deepseek-ai/dsh-cordis-client-runner browser: reserved-name docs
 *
 * The patch is a global `web_fetch` -> `fetch_url` text replacement in each
 * file (verified: the string is always a standalone token in all four).
 *
 * Usage:
 *   node rename-fetch-url.mjs [--dsh-root DIR] [--backup-dir DIR] [--restore]
 *
 * Defaults: DSH_ROOT resolved from the `dsh` binary on PATH; backup dir is
 * <backup parent>/rename-fetch-url-backups/<dsh version>/ (defaults next to
 * the dsh root's node_modules parent).
 *
 * Behavior (idempotent — safe to re-run, e.g. after a dsh upgrade):
 *   - untouched file  -> original backed up once, then patched
 *   - patched file    -> skipped
 *   - --restore       -> put the backed-up originals back
 *
 * A dsh server running against the patched tree needs a RESTART for the host
 * half (tool catalog + prompts); the browser half re-serves on the next page
 * load (client bundles are content-hash cache-busted).
 */
import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, writeFile, cp, realpath } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

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

/** The four (package, file) pairs the rename touches, plus their roles. */
const TARGETS = [
	{ dir: "dsh-tool-web", file: "lib/index.js", role: "host: tool name + LLM prompt text" },
	{ dir: "dsh-client-ui-tool", file: "lib/client.js", role: "browser: web card row (key/title/icon)" },
	{ dir: "dsh-client-connection", file: "lib/client.js", role: "browser: name-keyed presenters" },
	{ dir: "dsh-cordis-client-runner", file: "lib/client.js", role: "browser: reserved-name docs" }
];

const opts = args();
const root = opts.dshRoot ?? await resolveDshRoot();
console.log(`dsh root: ${root}`);

let version = "unknown";
try {
	const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
	version = pkg.version;
} catch { /* keep going */ }
const backupDir = opts.backupDir ?? join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "rename-fetch-url-backups", version);
// Layout: <backupDir>/<package>/<file> — mirroring the package tree.

let acted = 0;
for (const target of TARGETS) {
	const path = join(root, "node_modules", "@deepseek-ai", target.dir, target.file);
	if (!(await exists(path))) { console.log(`skip  ${target.dir}/${target.file}  (absent)`); continue; }
	const backup = join(backupDir, target.dir, target.file);
	const text = await readFile(path, "utf8");

	if (opts.restore) {
		if (!(await exists(backup))) { console.log(`skip  ${target.dir}/${target.file}  (no backup to restore)`); continue; }
		await cp(backup, path);
		console.log(`restore  ${target.dir}/${target.file}`);
		acted++;
		continue;
	}

	if (!text.includes("web_fetch")) {
		console.log(`ok      ${target.dir}/${target.file}  (already renamed)`);
		continue;
	}
	if (!text.includes("fetch_url")) {
		// First touch: preserve the pristine original before mutating.
		if (await exists(backup)) {
			// A dsh upgrade replaced the file but a backup from a previous
			// patch already exists — keep the FIRST backup (the pristine
			// original for this install layout), never clobber it.
			console.log(`backup  ${target.dir}/${target.file}  (backup already present — keeping it)`);
		} else {
			await mkdir(dirname(backup), { recursive: true });
			await writeFile(backup, text, "utf8");
			console.log(`backup  ${target.dir}/${target.file}  -> ${backup}`);
		}
	}
	await writeFile(path, text.replaceAll("web_fetch", "fetch_url"), "utf8");
	console.log(`patched ${target.dir}/${target.file}  (${target.role})`);
	acted++;
}

console.log(
	opts.restore
		? `\nDone${acted ? ` — restored ${acted} file(s)` : " (nothing to restore)"}.\nRestart the dsh server to pick up the restored names.`
		: `\nDone${acted ? ` — patched ${acted} file(s)` : " (all already renamed)"}.\n  Restart the dsh server so the host half (tool catalog + prompts) picks up the\n  new name; the browser half re-serves on the next page load.\n  Re-run this script after any dsh upgrade.\n  Restore originals with:  node ${fileURLToPath(import.meta.url)} --restore`
);
