/**
 * Mock-harness test for the client card bundle (client.js).
 * Executes the lazy-CJS factory against mocked react/runtime, then drives
 * apply(ctx) with a mock cordis client context to verify:
 *   - the factory runs and exports { apply, inject };
 *   - apply registers a card into settings.plugin.item keyed on the namespace;
 *   - the controller builds a form over the bound settings scope;
 *   - staging/edit/save/discard/resetField behave (revision-fenced writes).
 * Run:  node test-client.mjs   (from this directory)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ── capture the factory from window.__ModuleLoader__.load ───────────────────
let registered = null;
globalThis.window = { __ModuleLoader__: { load: (reg) => { registered = reg; } } };

// ── mock the cross-plugin require surface the factory uses ──────────────────
const runtimeMock = {
	createSnapshotStore(init) {
		let state = init;
		const listeners = new Set();
		return {
			getSnapshot: () => state,
			subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
			set: (next) => { state = next; for (const l of [...listeners]) l(); },
			update: (mutator) => { const d = { ...state }; mutator(d); state = d; for (const l of [...listeners]) l(); }
		};
	}
};
const reactMock = { useState: (init) => { let v = init; const set = (n) => { v = n; }; return [v, set]; } };
const jsxMock = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
const requireMock = (spec) => {
	if (spec === "react") return reactMock;
	if (spec === "react/jsx-runtime") return jsxMock;
	if (spec === "@deepseek-ai/dsh-client-runtime/client") return runtimeMock;
	throw new Error(`unexpected require in client bundle: ${spec}`);
};

// execute the bundle (registers the factory), then materialize it
const src = readFileSync(new URL("./client.js", import.meta.url), "utf8");
new Function("window", "require", src)(globalThis.window, requireMock);
assert.ok(registered, "bundle called window.__ModuleLoader__.load");
assert.equal(registered.id, "dsh-fetch-url-firecrawl");
const mod = registered.factory(requireMock);
assert.equal(typeof mod.apply, "function", "exports apply");
assert.deepEqual(mod.inject, ["slots", "locale", "settingsScope"], "declares required services");
console.log("ok: factory runs, exports {apply, inject: [slots, locale, settingsScope]}");

// ── mock cordis client context ──────────────────────────────────────────────
const NS = "dsh-fetch-url-firecrawl";
let dict = null;
const userLayer = {};
const baseLayer = { maxFetchedLength: 4096 };
const writes = [];
const scope = {
	getSnapshot: () => ({
		status: "ready",
		writable: true,
		value: { ...baseLayer, ...userLayer },
		base: baseLayer,
		user: userLayer
	}),
	subscribe: () => () => {},
	set: async (field, value) => { writes.push(["set", field, value]); userLayer[field] = value; },
	unset: async (field) => { writes.push(["unset", field]); delete userLayer[field]; }
};
const slotRegistrations = [];
const ctx = {
	locale: {
		bind: (ns) => (key) => (dict && dict[key]) ?? key,
		register: (ns, d) => { dict = d; }
	},
	effect: (fn) => { fn(); },
	settingsScope: { bind: ({ namespace }) => { assert.equal(namespace, NS, "binds the plugin namespace"); return scope; } },
	slots: {
		inject: (slotName, gen) => {
			assert.equal(slotName, "settings.plugin.item", "registers into the shared card slot");
			const it = gen();
			for (const step of it) {
				// each step is the (already-evaluated) result of ctx.slots.register(...)
				slotRegistrations.push(step);
			}
		},
		register: (options, component) => ({ options, component })
	}
};

mod.apply(ctx);
assert.equal(slotRegistrations.length, 1, "one card registered");
const { options, component } = slotRegistrations[0];
assert.equal(options.name, "settings.plugin.item");
assert.equal(options.key, NS, "card keyed on the settings namespace (the join key)");
assert.equal(typeof component, "function", "a React component is provided");
assert.equal(typeof options.inject, "function", "slot entry injects the controller face");
assert.ok(dict, "locale dictionary registered");
assert.ok(dict.en && dict.en.title && dict.en.maxFetchedLength, "dictionary has the card's keys");
assert.ok(dict.zh && dict.zh.title && dict.zh.maxFetchedLength, "zh dictionary has the card's keys");
console.log("ok: apply registers the card into settings.plugin.item keyed on the namespace");

// ── exercise the controller face (staging / save / discard / reset) ─────────
const face = options.inject();
assert.ok(face.hooks && face.hooks.firecrawlCard, "exposes the card snapshot hook store");
for (const a of ["edit", "resetField", "save", "discard"]) assert.equal(typeof face[a], "function", `action ${a}`);

// read the initial snapshot through the store
const store = face.hooks.firecrawlCard;
assert.equal(store.getSnapshot().available, true, "namespace available");
assert.equal(store.getSnapshot().maxFetchedLength.text, "4096", "shows effective value (4096)");
assert.equal(store.getSnapshot().maxFetchedLength.overridden, false, "not overridden initially");

// stage an edit → dirty + overridden
face.edit("maxFetchedLength", "8192");
let snap = store.getSnapshot();
assert.equal(snap.dirty, true, "dirty after edit");
assert.equal(snap.maxFetchedLength.overridden, true, "edit reads as an override");
assert.equal(snap.maxFetchedLength.text, "8192");

// save → revision-fenced write to the scope, user layer updated, draft cleared
await face.save();
assert.deepEqual(writes.at(-1), ["set", "maxFetchedLength", 8192], "save wrote the staged value");
assert.equal(userLayer.maxFetchedLength, 8192);
assert.equal(store.getSnapshot().dirty, false, "draft cleared after a landed save");

// invalid draft blocks the save
face.edit("maxFetchedLength", "not-a-number");
snap = store.getSnapshot();
assert.equal(snap.invalid, true, "non-numeric draft marks the form invalid");
await face.save();
assert.equal(userLayer.maxFetchedLength, 8192, "invalid save did not overwrite (value unchanged)");
assert.equal(store.getSnapshot().dirty, true, "invalid draft kept for correction");

// the invalid draft also blocks a concurrent reset — discard it first
face.discard();
assert.equal(store.getSnapshot().dirty, false, "discard clears the blocking invalid draft");

// resetField stages a clear back to the composition layer
face.resetField("maxFetchedLength");
snap = store.getSnapshot();
assert.equal(snap.maxFetchedLength.text, "4096", "reset shows the composed default");
await face.save();
assert.ok(!("maxFetchedLength" in userLayer), "reset cleared the override back to base");
assert.deepEqual(writes.at(-1), ["unset", "maxFetchedLength"]);

// discard drops staged edits without writing
face.edit("maxFetchedLength", "5");
assert.equal(store.getSnapshot().dirty, true);
face.discard();
assert.equal(store.getSnapshot().dirty, false, "discard clears the draft");
assert.ok(!("maxFetchedLength" in userLayer), "discard did not write (no override added)");
console.log("ok: controller stages, saves (fenced), blocks invalid, resets, and discards");

console.log("\nALL CLIENT TESTS PASSED");
