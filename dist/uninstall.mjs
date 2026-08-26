#!/usr/bin/env node
/**
 * Removes the dsh-fetch-url-firecrawl profile plugin from a DSH home.
 *
 * Usage:
 *   node uninstall.mjs [--dsh-home DIR] [--profile NAME] [--purge]
 *
 * Defaults: DSH_HOME env var or ~/.dsh; profile "web".
 *
 * Removes:
 *   - the managed entry block from <profile>/cordis.patch.yml (between the
 *     >>> / <<< marker comments; your other patch entries are untouched)
 *   - the `fetchProvider: dsh-fetch-url-firecrawl` line install.mjs wove into the
 *     `- id: web` entry (if present)
 *   - the profile-local node_modules symlink for the package
 *   - with --purge: the plugin files under <profile>/plugins/dsh-fetch-url-firecrawl/
 *
 * Keeps the FIRECRAWL_API_KEY credential (delete it from
 * <dsh-home>/.credentials.yaml yourself if you want it gone — and rotate it
 * if this machine was ever untrusted).
 */
import { lstat, access, readFile, readlink, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const PKG_NAME = "dsh-fetch-url-firecrawl";
const PLUGIN_DIRNAME = "dsh-fetch-url-firecrawl";
const MARKER_HEAD = `# >>> ${PKG_NAME} (managed block — uninstall.mjs removes this) >>>`;
const MARKER_TAIL = `# <<< ${PKG_NAME} <<<`;

function args() {
	const out = { dshHome: void 0, profile: "web", purge: false };
	const argv = process.argv.slice(2);
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--dsh-home") out.dshHome = argv[++i];
		else if (argv[i] === "--profile") out.profile = argv[++i];
		else if (argv[i] === "--purge") out.purge = true;
		else { console.error(`unknown flag: ${argv[i]}`); process.exit(2); }
	}
	return out;
}
async function exists(p) { try { await access(p); return true; } catch { return false; } }

/** Escape regex metacharacters so the marker strings match literally. */
function escapeRegExp(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
const BLOCK_RE = new RegExp(`\\n?${escapeRegExp(MARKER_HEAD)}[\\s\\S]*?${escapeRegExp(MARKER_TAIL)}\\n?`);

/**
 * Remove the `fetchProvider: dsh-fetch-url-firecrawl` line from the patch file's
 * `- id: web` entry block (line-based; other lines are untouched).
 * Returns true when a line was removed.
 */
function removeFetchProviderLine(content) {
	const lines = content.split("\n");
	const start = lines.findIndex((line) => /^-\s*id:\s*web\s*$/.test(line));
	if (start === -1) return { content, removed: false };
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) if (/^-\s/.test(lines[i]) || /^-\s*$/.test(lines[i])) { end = i; break; }
	const idx = lines.findIndex((line, i) => i >= start && i < end && /^\s*fetchProvider:\s*dsh-fetch-url-firecrawl\s*$/.test(line));
	if (idx === -1) return { content, removed: false };
	lines.splice(idx, 1);
	return { content: lines.join("\n"), removed: true };
}

const opts = args();
const dshHome = opts.dshHome ?? process.env.DSH_HOME ?? join(homedir(), ".dsh");
const profileDir = join(dshHome, "profiles", opts.profile);
const pluginDir = join(profileDir, "plugins", PLUGIN_DIRNAME);
const linkPath = join(profileDir, "node_modules", PKG_NAME);
const patchPath = join(profileDir, "cordis.patch.yml");
console.log(`DSH home: ${dshHome}  profile: ${opts.profile}`);

let touched = 0;

// 1. patch block + woven key
if (await exists(patchPath)) {
	let text = await readFile(patchPath, "utf8");
	let patchTouched = false;
	if (text.includes(MARKER_HEAD)) {
		text = text.replace(BLOCK_RE, "\n").replace(/\n{3,}/g, "\n\n");
		patchTouched = true;
	} else {
		console.log("patch:        no managed block found — cordis.patch.yml untouched");
	}
	if (text.includes("fetchProvider: dsh-fetch-url-firecrawl")) {
		const next = removeFetchProviderLine(text);
		if (next.removed) {
			text = next.content;
			patchTouched = true;
		}
	}
	if (patchTouched) {
		await writeFile(patchPath, text);
		console.log(`patch:        cleaned ${patchPath}`);
		touched++;
	}
} else {
	console.log("patch:        cordis.patch.yml absent — nothing to do");
}

// 2. symlink
if (await exists(linkPath)) {
	const st = await lstat(linkPath);
	if (st.isSymbolicLink()) {
		// readlink, not readFile: the target is a directory and readFile would EISDIR.
		const target = (await readlink(linkPath)).trim();
		if (target.endsWith(join("plugins", PLUGIN_DIRNAME)) || target === pluginDir) {
			await rm(linkPath);
			console.log(`symlink:      removed ${linkPath}`);
			touched++;
		} else {
			console.log(`symlink:      ${linkPath} points elsewhere (${target}) — left alone`);
		}
	} else {
		console.log(`symlink:      ${linkPath} is not a symlink — left alone`);
	}
} else {
	console.log(`symlink:      absent — nothing to do`);
}

// 3. plugin files (only with --purge)
if (opts.purge && (await exists(pluginDir))) {
	await rm(pluginDir, { recursive: true, force: true });
	console.log(`plugin dir:   removed ${pluginDir}`);
	touched++;
} else if (!opts.purge) {
	console.log(`plugin dir:   kept ${pluginDir} (use --purge to delete the files)`);
}

console.log(`
Done${touched ? "" : " (nothing to remove)"}.
Reminder: the FIRECRAWL_API_KEY credential still sits in ${join(dshHome, ".credentials.yaml")}
if you added it there — remove that line (and rotate the key) if you want it gone.
If a dsh server is running in that environment, restart it to drop the plugin.`);
