/**
 * Browser half of `dsh-fetch-url-firecrawl`: the settings card for the
 * Firecrawl fetch provider.
 *
 * This is a client-module bundle in the loader's lazy-CJS factory format:
 * executing it only REGISTERS the factory; the body (CSS + React + the card
 * registration) runs at materialization, when the client module system first
 * imports the id. It registers one card into the shared `settings.plugin.item`
 * slot, keyed on this plugin's settings namespace — the same join key the host
 * half registers via `ctx.settings.installSection`. The "Plugin configuration" tab
 * dispatches the card only when the host serves the namespace, so a deployment
 * that never composed the host half shows no trace of it.
 *
 * The bundle-purity gate forbids value-importing the section's card chrome or
 * form model, so this card renders its own chrome and owns its own staging and
 * revision-fenced writes (a minimal CardForm over the client settings scope).
 * It value-imports only shared libraries (react, the client runtime), never
 * another plugin's client export.
 *
 * Visual parity with the in-box cards: the CSS below is the shipped
 * PluginCard/fields rule set (same tokens, radii, paddings, type scale) under
 * this card's own scoped class names; the shared chrome copy (Overridden,
 * Reset to default, …) is word-for-word the section's dictionary; the chevron
 * inlines the exact 14px glyph the shipped cards use.
 */
window.__ModuleLoader__.load({
	id: "dsh-fetch-url-firecrawl",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		let react = require("react");
		let jsx = require("react/jsx-runtime");
		let runtime = require("@deepseek-ai/dsh-client-runtime/client");

		/* ── Card CSS: the shipped card rule set under this card's scoped names ── */
		const CSS = `
.fcrawl_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}
.fcrawl_card:hover{border-color:var(--dsw-alias-label-dimmed)}
.fcrawl_cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.fcrawl_header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}
.fcrawl_header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.fcrawl_headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.fcrawl_name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}
.fcrawl_description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.fcrawl_chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}
.fcrawl_chevronOpen{transform:rotate(180deg)}
.fcrawl_body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}
.fcrawl_readOnly{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:12px;line-height:1.5}
.fcrawl_pending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
.fcrawl_footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}
.fcrawl_failed{min-width:0;color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px;line-height:1.5}
.fcrawl_discard,.fcrawl_save{appearance:none;font:inherit;cursor:pointer;border:1px solid #0000;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}
.fcrawl_discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}
.fcrawl_discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.fcrawl_save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.fcrawl_discard:disabled,.fcrawl_save:disabled{opacity:.4;cursor:default}
.fcrawl_discard:focus-visible,.fcrawl_save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.fcrawl_field{flex-direction:column;gap:6px;padding:12px 0;display:flex}
.fcrawl_field+.fcrawl_field{border-top:1px solid var(--dsw-alias-border-l2)}
.fcrawl_head{align-items:center;gap:8px;display:flex}
.fcrawl_label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}
.fcrawl_badges{align-items:center;gap:8px;display:inline-flex}
.fcrawl_badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
.fcrawl_reset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px;line-height:1.5}
.fcrawl_reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.fcrawl_reset:disabled{cursor:default}
.fcrawl_input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5}
.fcrawl_input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.fcrawl_input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.fcrawl_inputInvalid{border-color:var(--dsw-alias-label-error)}
.fcrawl_invalid{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}
.fcrawl_hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}`;
		const CSS_TAG = "dsh-fetch-url-firecrawl/client.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-fetch-url-firecrawl";
			tag.dataset.pluginCss = CSS_TAG;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}
		const C = {
			card: "fcrawl_card",
			cardOpen: "fcrawl_cardOpen",
			header: "fcrawl_header",
			headText: "fcrawl_headText",
			name: "fcrawl_name",
			description: "fcrawl_description",
			pending: "fcrawl_pending",
			chevron: "fcrawl_chevron",
			chevronOpen: "fcrawl_chevronOpen",
			body: "fcrawl_body",
			readOnly: "fcrawl_readOnly",
			footer: "fcrawl_footer",
			failed: "fcrawl_failed",
			discard: "fcrawl_discard",
			save: "fcrawl_save",
			field: "fcrawl_field",
			head: "fcrawl_head",
			label: "fcrawl_label",
			badges: "fcrawl_badges",
			badge: "fcrawl_badge",
			reset: "fcrawl_reset",
			input: "fcrawl_input",
			inputInvalid: "fcrawl_inputInvalid",
			invalid: "fcrawl_invalid",
			hint: "fcrawl_hint"
		};

		/* ── Join key + locale dictionary namespace ───────────────────────── */
		// Spelled (not imported): a client package must not depend on a Host package.
		const NS = "dsh-fetch-url-firecrawl";
		const DICT = "settings.firecrawlFetch";

		// Shared chrome keys mirror the section's dictionary word-for-word so the
		// card reads as part of the family; card-specific keys are ours.
		const en = {
			title: "Firecrawl web fetch",
			description: "Backend for the web_fetch tool (Firecrawl /v2/scrape).",
			maxFetchedLength: "Max fetched length (bytes)",
			maxFetchedLengthHint: "Per-fetch cap. Longer content is trimmed in the tool context and the full copy is spilled to a file the model can read.",
			overridden: "Overridden",
			reset: "Reset to default",
			invalidNumber: "Enter a number, or leave blank to use the default.",
			unsaved: "Unsaved",
			readOnly: "This deployment stores settings read-only.",
			discard: "Discard",
			save: "Save",
			saving: "Saving\u2026",
			saveFailed: "The deployment did not accept these values; they were left for you to correct.",
			expand: "Show settings",
			collapse: "Hide settings"
		};
		const zh = {
			title: "Firecrawl \u7f51\u9875\u6293\u53d6",
			description: "web_fetch \u5de5\u5177\u7684\u540e\u7aef\uff08Firecrawl /v2/scrape\uff09\u3002",
			maxFetchedLength: "\u6700\u5927\u6293\u53d6\u957f\u5ea6\uff08\u5b57\u8282\uff09",
			maxFetchedLengthHint: "\u6bcf\u6b21\u6293\u53d6\u7684\u4e0a\u9650\u3002\u8d85\u51fa\u90e8\u5206\u4f1a\u88ab\u622a\u65ad\uff0c\u5b8c\u6574\u5185\u5bb9\u4f1a\u5199\u5165\u6587\u4ef6\u4f9b\u6a21\u578b\u9605\u8bfb\u3002",
			overridden: "\u5df2\u8986\u76d6",
			reset: "\u6062\u590d\u9ed8\u8ba4",
			invalidNumber: "\u8bf7\u586b\u6570\u5b57\uff1b\u7559\u7a7a\u8868\u793a\u4f7f\u7528\u9ed8\u8ba4\u503c\u3002",
			unsaved: "\u672a\u4fdd\u5b58",
			readOnly: "\u672c\u90e8\u7f72\u7684\u8bbe\u7f6e\u4e3a\u53ea\u8bfb\u3002",
			discard: "\u653e\u5f03\u4fee\u6539",
			save: "\u4fdd\u5b58",
			saving: "\u4fdd\u5b58\u4e2d\u2026",
			saveFailed: "\u672c\u90e8\u7f72\u6ca1\u6709\u63a5\u53d7\u8fd9\u4e9b\u503c\uff0c\u5df2\u4fdd\u7559\u4f9b\u4f60\u4fee\u6539\u3002",
			expand: "\u5c55\u5f00\u8bbe\u7f6e",
			collapse: "\u6536\u8d77\u8bbe\u7f6e"
		};

		/* ── Chevron: the exact 14px glyph the shipped cards use ───────────── */
		const CHEVRON_PATH = "M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z";
		function IconChevronDown14({ className }) {
			return jsx.jsx("svg", {
				width: 14,
				height: 14,
				className,
				viewBox: "0 0 14 14",
				fill: "none",
				xmlns: "http://www.w3.org/2000/svg",
				children: jsx.jsx("path", { d: CHEVRON_PATH, fill: "currentColor" })
			});
		}

		/* ── Field specs ───────────────────────────────────────────────────── */
		/** A whole-number field: empty draft clears; a non-numeric draft blocks save. */
		function numberField(field) {
			return {
				field,
				format: (value) => (typeof value === "number" ? String(value) : ""),
				parse: (text) => {
					const trimmed = text.trim();
					if (trimmed === "") return { kind: "clear" };
					const parsed = Number(trimmed);
					return Number.isFinite(parsed) ? { kind: "set", value: parsed } : void 0;
				}
			};
		}

		/* ── CardForm: staged edits over one namespace, written on save ────── */
		class CardForm {
			constructor(scope, specs) {
				this.scope = scope;
				this.specs = new Map(specs.map((s) => [s.field, s]));
				this.staged = new Map();
				this.listeners = new Set();
				this.saving = false;
				this.failed = false;
				scope.subscribe(() => this.publish());
			}
			bind(project) {
				const store = runtime.createSnapshotStore(project());
				this.listeners.add(() => store.set(project()));
				return store;
			}
			shell() {
				const snap = this.scope.getSnapshot();
				const plan = this.plan();
				return {
					available: snap.status === "ready",
					writable: snap.writable,
					dirty: plan.length > 0,
					invalid: plan.some((item) => item.run === void 0),
					saving: this.saving,
					failed: this.failed
				};
			}
			field(name) {
				const staged = this.staged.get(name);
				const spec = this.specs.get(name);
				if (staged === void 0) {
					return {
						text: spec.format(this.sectionValue(name)),
						overridden: this.stored(name),
						invalid: false
					};
				}
				const write = staged.clear ? { kind: "clear" } : spec.parse(staged.text);
				return {
					text: staged.text,
					overridden: write !== void 0 && write.kind === "set",
					invalid: write === void 0
				};
			}
			actions() {
				return {
					edit: (field, text) => this.stage(field, { text, clear: false }),
					resetField: (field) => this.stage(field, { text: this.specs.get(field).format(this.baseValue(field)), clear: true }),
					save: () => this.save(),
					discard: () => {
						if (this.staged.size === 0 && !this.failed) return;
						this.staged.clear();
						this.failed = false;
						this.publish();
					}
				};
			}
			async save() {
				const plan = this.plan();
				const writes = plan.flatMap((item) => (item.run === void 0 ? [] : [item.run]));
				if (plan.length === 0 || this.saving || writes.length !== plan.length) return;
				this.saving = true;
				this.failed = false;
				this.publish();
				let landed = true;
				for (const write of writes) landed = (await write()) && landed;
				if (landed) this.staged.clear();
				this.saving = false;
				this.failed = !landed;
				this.publish();
			}
			plan() {
				const plan = [];
				for (const [field, staged] of this.staged) {
					const spec = this.specs.get(field);
					if (staged.clear) {
						if (this.stored(field)) plan.push({ field, run: () => this.clear(field) });
						continue;
					}
					if (staged.text === spec.format(this.sectionValue(field))) continue;
					const write = spec.parse(staged.text);
					if (write === void 0) plan.push({ field, run: void 0 });
					else if (write.kind === "clear") plan.push({ field, run: () => this.clear(field) });
					else plan.push({ field, run: () => this.store(field, write.value) });
				}
				return plan;
			}
			async clear(field) {
				await this.scope.unset(field);
				return !this.stored(field);
			}
			async store(field, value) {
				await this.scope.set(field, value);
				return this.userLayer() !== void 0 && this.userLayer()[field] === value;
			}
			stage(field, edit) {
				this.staged.set(field, edit);
				this.failed = false;
				this.publish();
			}
			snapshotOf() { return this.scope.getSnapshot(); }
			sectionValue(field) { return this.snapshotOf().value?.[field]; }
			baseValue(field) { return this.snapshotOf().base?.[field]; }
			userLayer() { return this.snapshotOf().user; }
			stored(field) {
				const user = this.userLayer();
				return user !== void 0 && Object.hasOwn(user, field);
			}
			publish() { for (const listener of this.listeners) listener(); }
		}

		/* ── Controller ────────────────────────────────────────────────────── */
		class FirecrawlCardController {
			constructor(scope) {
				this.form = new CardForm(scope, [numberField("maxFetchedLength")]);
				this.store = this.form.bind(() => this.projection());
			}
			projection() {
				return {
					...this.form.shell(),
					maxFetchedLength: this.form.field("maxFetchedLength")
				};
			}
			inject() {
				return {
					hooks: { firecrawlCard: this.store },
					...this.form.actions()
				};
			}
		}

		/* ── One labeled field (shipped-card structure) ────────────────────── */
		function ValueField(props) {
			return jsx.jsxs("div", {
				className: C.field,
				children: [
					jsx.jsxs("div", {
						className: C.head,
						children: [
							jsx.jsx("label", {
								className: C.label,
								htmlFor: props.id,
								children: props.label
							}),
							props.overridden ? jsx.jsxs("span", {
								className: C.badges,
								children: [
									jsx.jsx("span", {
										className: C.badge,
										children: props.overriddenLabel
									}),
									jsx.jsx("button", {
										type: "button",
										className: C.reset,
										disabled: props.disabled,
										onClick: props.onReset,
										children: props.resetLabel
									})
								]
							}) : null
						]
					}),
					jsx.jsx("input", {
						id: props.id,
						className: props.invalid ? C.input + " " + C.inputInvalid : C.input,
						type: "text",
						...props.numeric === true ? { inputMode: "numeric" } : {},
						...props.invalid ? { "aria-invalid": true } : {},
						value: props.text,
						placeholder: props.placeholder ?? "",
						disabled: props.disabled,
						onChange: (event) => {
							props.onEdit(event.target.value);
						}
					}),
					jsx.jsx("p", {
						className: props.invalid ? C.invalid : C.hint,
						children: props.invalid ? props.invalidLabel : props.hint
					})
				]
			});
		}

		/* ── The card (shipped-card structure) ─────────────────────────────── */
		function FirecrawlCard(props) {
			const [open, setOpen] = react.useState(false);
			const state = props.useFirecrawlCard((s) => s);
			if (!state || !state.available) return null;
			const t = props.t;
			const title = t("title");
			const blocked = !state.dirty || state.invalid || state.saving;
			return jsx.jsxs("li", {
				className: open ? C.card + " " + C.cardOpen : C.card,
				children: [
					jsx.jsxs("button", {
						type: "button",
						className: C.header,
						"aria-expanded": open,
						"aria-label": `${t(open ? "collapse" : "expand")}: ${title}`,
						onClick: () => {
							setOpen(!open);
						},
						children: [
							jsx.jsxs("span", {
								className: C.headText,
								children: [
									jsx.jsx("span", {
										className: C.name,
										children: title
									}),
									jsx.jsx("span", {
										className: C.description,
										children: t("description")
									})
								]
							}),
							state.dirty ? jsx.jsx("span", {
								className: C.pending,
								children: t("unsaved")
							}) : null,
							jsx.jsx(IconChevronDown14, {
								className: open ? C.chevron + " " + C.chevronOpen : C.chevron
							})
						]
					}),
					open ? jsx.jsxs("div", {
						className: C.body,
						children: [
							!state.writable ? jsx.jsx("p", {
								className: C.readOnly,
								role: "status",
								children: t("readOnly")
							}) : null,
							jsx.jsx(ValueField, {
								id: "fcrawl-max-fetched-length",
								label: t("maxFetchedLength"),
								hint: t("maxFetchedLengthHint"),
								overriddenLabel: t("overridden"),
								resetLabel: t("reset"),
								invalidLabel: t("invalidNumber"),
								numeric: true,
								disabled: !state.writable,
								...state.maxFetchedLength,
								onEdit: (text) => {
									props.edit("maxFetchedLength", text);
								},
								onReset: () => {
									props.resetField("maxFetchedLength");
								}
							}),
							jsx.jsxs("div", {
								className: C.footer,
								children: [
									state.failed ? jsx.jsx("p", {
										className: C.failed,
										role: "status",
										children: t("saveFailed")
									}) : null,
									jsx.jsx("button", {
										type: "button",
										className: C.discard,
										disabled: !state.dirty || state.saving,
										onClick: props.discard,
										children: t("discard")
									}),
									jsx.jsx("button", {
										type: "button",
										className: C.save,
										disabled: blocked,
										onClick: props.save,
										children: state.saving ? t("saving") : t("save")
									})
								]
							})
						]
					}) : null
				]
			});
		}

		/* ── Plugin face ───────────────────────────────────────────────────── */
		const inject = ["slots", "locale", "settingsScope"];
		function apply(ctx) {
			const t = ctx.locale.bind(DICT);
			ctx.effect(() => ctx.locale.register(DICT, { en, zh }), "dsh-fetch-url-firecrawl: dictionary");
			const card = new FirecrawlCardController(ctx.settingsScope.bind({ namespace: NS }));
			ctx.slots.inject("settings.plugin.item", function* () {
				yield ctx.slots.register({
					name: "settings.plugin.item",
					key: NS,
					locale: DICT,
					inject: () => card.inject()
				}, FirecrawlCard);
			});
		}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
