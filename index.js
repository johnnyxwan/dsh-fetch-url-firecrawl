/**
 * `dsh-fetch-url-firecrawl` — DSH profile plugin: a Firecrawl-backed
 * fetch provider for the web capability seam (`ctx.web`) that retrieves page
 * content through Firecrawl's scrape API (`POST /v2/scrape`, markdown format)
 * instead of plain anonymous HTTP.
 *
 * Why Firecrawl: the scrape API renders JavaScript-heavy pages, applies
 * proxying/anti-bot handling, and returns clean markdown — what a model wants
 * in context, not an unrendered HTML soup. The normalized result therefore carries
 * `body: { kind: "text", content: <markdown> }`; a scrape that returns HTML
 * only (no markdown) degrades to `kind: "html"` so the tool's turndown path
 * still renders it.
 *
 * Status semantics follow the seam: the TARGET page's status (from
 * `data.metadata.statusCode`) is part of the result, not an error — a
 * 404 page still resolves descriptively. A Firecrawl-side failure (bad key,
 * blocked target, scrape error) throws `WebError` `WEB_PROVIDER_ERROR`;
 * aborts surface as `WEB_ABORTED`.
 *
 * Fetched-length control: the decoded body content is capped at
 * `maxFetchedLength` bytes (default 4096). An over-limit body is trimmed
 * in-place (UTF-8-safe), its FULL copy is written to a file under `fullCopyDir`
 * (default `<tmpdir>/dsh-fetch-url-firecrawl/`), and the trimmed content
 * carries the file path so the model can `read` the full text on demand.
 * `WebFetchResult.truncated` is set for the tool's own truncation footer.
 *
 * Registration: function/namespace plugin (`inject: ['web']`); it registers
 * into the seam's fetch-provider registry under the id `dsh-fetch-url-firecrawl` and owns
 * no model-facing tool (the in-box `web_fetch` tool is the consumer). Wire
 * format and the native `fetch` client are provider-private and do not use
 * `ctx.llm`.
 *
 * Install:  dsh plugin --profile <name> add <this repo's git URL> (see README).
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import z from "@deepseek-ai/schemastery";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { WebError } from "@deepseek-ai/dsh-web";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";

/** Stable id this provider registers under. */
const FIRECRAWL_PROVIDER_ID = "dsh-fetch-url-firecrawl";

/** Settings namespace this plugin owns; the join key for its settings card. */
const FIRECRAWL_SETTINGS_NAMESPACE = settingsNamespace("dsh-fetch-url-firecrawl");

/** Default Firecrawl endpoint; `/v2/scrape` is appended (the scrape API). */
const FIRECRAWL_DEFAULT_BASE_URL = "https://api.firecrawl.dev";

/** Default environment variable / credential name for the API key. */
const FIRECRAWL_DEFAULT_API_KEY_ENV = "FIRECRAWL_API_KEY";

/** Default fetched-content cap, in bytes. */
const FIRECRAWL_DEFAULT_MAX_FETCHED_LENGTH = 4096;

/** Default directory for full copies of over-limit fetched content. */
const FIRECRAWL_DEFAULT_TEMP_DIRNAME = "dsh-fetch-url-firecrawl";

/** Attribution header sent on every request. */
const USER_AGENT = "deepseek-harness/0.0.1 (dsh-fetch-url-firecrawl)";

/**
 * Validate the requested URL locally before spending a scrape call: only
 * absolute HTTP(S) URLs are legal retrieval targets (Firecrawl would reject
 * anything else with a 400, but a local check fails faster and cheaper).
 *
 * @param url - the request URL.
 * @returns the validated URL string.
 * @throws {WebError} `WEB_FETCH_URL_INVALID` when the URL is not HTTP(S).
 */
function assertHttpUrl(url) {
	if (typeof url !== "string" || url.length === 0) throw new WebError(
		"Firecrawl fetch requires a non-empty url",
		"WEB_FETCH_URL_INVALID"
	);
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		throw new WebError(`Firecrawl fetch URL is not a valid absolute URL: ${url}`, "WEB_FETCH_URL_INVALID");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new WebError(
		`Firecrawl fetch only supports http/https URLs: ${url}`,
		"WEB_FETCH_URL_INVALID"
	);
	return url;
}

/**
 * Map a scrape API response envelope to the (not-yet-capped) fetch result.
 * Firecrawl answers 2xx with `success: false` for scrape-level failures
 * (e.g. DNS resolution), so `success` — not the HTTP status alone — decides.
 *
 * @param response - the parsed `/v2/scrape` response body.
 * @param requestUrl - the request URL (fallback when metadata is thin).
 * @returns `{ url, statusCode, body, title }`; `title` is a provider-private
 *   extra used only for the full-copy file, never part of WebFetchResult.
 * @throws {WebError} on `success: false` or an unprocessable body.
 */
function mapScrapeResponse(response, requestUrl) {
	if (response === null || typeof response !== "object" || response.success !== true) {
		const detail = typeof response?.error === "string" && response.error.length > 0
			? response.error
			: `HTTP ${response?.code ?? "unknown"}`;
		throw new WebError(`Firecrawl scrape failed: ${detail}`, "WEB_PROVIDER_ERROR");
	}
	const data = response.data;
	if (data === null || typeof data !== "object") throw new WebError(
		"Firecrawl returned an unprocessable response body: missing data",
		"WEB_PROVIDER_ERROR"
	);
	const metadata = data.metadata !== null && typeof data.metadata === "object" ? data.metadata : {};
	const statusCode = Number.isInteger(metadata.statusCode) ? metadata.statusCode : 200;
	const url = typeof metadata.url === "string" && metadata.url.length > 0
		? metadata.url
		: typeof metadata.sourceURL === "string" && metadata.sourceURL.length > 0
			? metadata.sourceURL
			: requestUrl;
	let body;
	if (typeof data.markdown === "string") body = { kind: "text", content: data.markdown };
	else if (typeof data.html === "string") body = { kind: "html", content: data.html };
	else throw new WebError(
		"Firecrawl returned an unprocessable response body: missing markdown/html",
		"WEB_PROVIDER_ERROR"
	);
	return {
		url,
		statusCode,
		body,
		...typeof metadata.title === "string" && metadata.title.length > 0 ? { title: metadata.title } : {}
	};
}

/**
 * Longest UTF-8-safe prefix of `str` whose encoding is at most `maxBytes`
 * bytes. Snaps back to a character boundary so the prefix is always valid
 * UTF-8 (never a torn multi-byte sequence).
 *
 * @param str - the input string.
 * @param maxBytes - the byte budget.
 * @returns the truncated (or unchanged) string.
 */
function truncateUtf8(str, maxBytes) {
	const buf = Buffer.from(str, "utf8");
	if (buf.length <= maxBytes) return str;
	let end = maxBytes;
	// Walk back past continuation bytes (10xxxxxx) to a character boundary.
	while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
	return buf.subarray(0, end).toString("utf8");
}

/** Stable per-URL file name: sha256(url), 16 hex chars. */
function fullCopyName(url) {
	return `${createHash("sha256").update(url).digest("hex").slice(0, 16)}.txt`;
}

/** Render the full copy of one fetched page (title, url, status, full content). */
function renderFullCopy(mapped) {
	return [
		mapped.title !== undefined ? `# ${mapped.title}` : null,
		mapped.url,
		`HTTP ${mapped.statusCode}`,
		"",
		mapped.body.content
	].filter((line) => line !== null).join("\n");
}

/**
 * Enforce the fetched-length cap on one mapped result. Under the cap, the
 * body is returned unchanged with `truncated: false`. Over the cap, the full
 * page is written to `options.fullCopyDir` and the body content is replaced
 * with the truncated content plus a pointer to the full-copy file;
 * `truncated` is set so the tool appends its truncation footer.
 *
 * @param mapped - the mapped scrape result (with provider-private `title`).
 * @param options - resolved provider options (maxFetchedLength, fullCopyDir).
 * @returns `{ body, truncated }` for the normalized WebFetchResult.
 */
async function capFetchedLength(mapped, options) {
	const { kind, content } = mapped.body;
	const limit = options.maxFetchedLength;
	if (Buffer.byteLength(content, "utf8") <= limit) return { body: mapped.body, truncated: false };

	const file = join(options.fullCopyDir, fullCopyName(mapped.url));
	try {
		await mkdir(options.fullCopyDir, { recursive: true });
		await writeFile(file, renderFullCopy(mapped), "utf8");
	} catch (error) {
		// Losing the full copy degrades the pointer; never fail the fetch
		// over a tmp write (disk pressure, permissions). Trim without it.
		return {
			body: { kind, content: `${truncateUtf8(content, limit)}\n\n[fetched content truncated to ${limit} bytes; full copy unavailable: ${String(error)}]` },
			truncated: true
		};
	}
	return {
		body: { kind, content: `${truncateUtf8(content, limit)}\n\n[fetched content truncated to ${limit} bytes; full copy: ${file}]` },
		truncated: true
	};
}

/**
 * The Firecrawl fetch provider. Credentials resolve per request (managed
 * credential store, then launch environment); HTTP redirects fail as
 * `WEB_PROVIDER_ERROR`; aborts surface as `WEB_ABORTED`.
 */
class FirecrawlFetchProvider {
	id = FIRECRAWL_PROVIDER_ID;
	#resolveOptions;

	/**
	 * @param resolveOptions - the options for the NEXT operation, snapshotted
	 * once at each operation's entry so one fetch never mixes two sections.
	 */
	constructor(resolveOptions) {
		this.#resolveOptions = resolveOptions;
	}

	/** Cheap local usability check; never makes network calls. */
	available() {
		const options = this.#resolveOptions();
		return ((options.apiKey?.length ?? 0) > 0 || options.resolveApiKey !== undefined)
			&& URL.canParse(options.baseURL)
			&& isPositiveInteger(options.maxFetchedLength);
	}

	async fetch(request, signal) {
		const options = this.#resolveOptions();
		const apiKey = await this.#apiKey(options, signal);
		throwIfAborted(signal);

		const url = assertHttpUrl(request.url);
		const endpoint = `${options.baseURL}/v2/scrape`;
		const body = { url, formats: ["markdown"] };

		options.recordRequest?.({ endpoint, url });
		throwIfAborted(signal);

		let response;
		try {
			response = await fetch(endpoint, {
				method: "POST",
				redirect: "error",
				headers: {
					"authorization": `Bearer ${apiKey}`,
					"content-type": "application/json",
					"accept": "application/json",
					"user-agent": USER_AGENT
				},
				body: JSON.stringify(body),
				...signal !== undefined ? { signal } : {}
			});
		} catch (error) {
			if (signal?.aborted === true || isAbortError(error)) throw fetchAborted(signal, error);
			throw new WebError(`Firecrawl scrape request failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
		}

		let responseText;
		try {
			responseText = await response.text();
		} catch (error) {
			// An abort firing mid-body must surface as WEB_ABORTED, not be
			// swallowed into a generic request-failure message.
			if (signal?.aborted === true || isAbortError(error)) throw fetchAborted(signal, error);
			throw new WebError(`Firecrawl scrape request failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
		}

		if (!response.ok) {
			let message = `Firecrawl API error (HTTP ${response.status})`;
			try {
				const parsed = JSON.parse(responseText);
				const detail = typeof parsed.error === "string" ? parsed.error : undefined;
				if (detail !== undefined && detail.length > 0) message = detail;
			} catch {
				// Non-JSON error body: keep the generic message.
			}
			throw new WebError(message, "WEB_PROVIDER_ERROR");
		}

		let mapped;
		try {
			mapped = mapScrapeResponse(JSON.parse(responseText), url);
		} catch (error) {
			if (signal?.aborted === true || isAbortError(error)) throw fetchAborted(signal, error);
			if (error instanceof WebError) throw error;
			throw new WebError(`Firecrawl returned an unprocessable response body: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
		}

		// Fetched-length cap with full-copy spill to tmp.
		const capped = await capFetchedLength(mapped, options);
		return { url: mapped.url, statusCode: mapped.statusCode, body: capped.body, truncated: capped.truncated };
	}

	/**
	 * Resolve one operation's credential without retaining it on the provider.
	 * @param options - the caller's snapshot, so the key and the endpoint it is sent to come from one section.
	 * @param signal - abort signal for the surrounding fetch.
	 * @returns the resolved key.
	 */
	async #apiKey(options, signal) {
		throwIfAborted(signal);
		if (options.apiKey !== undefined && options.apiKey.length > 0) return options.apiKey;
		let resolved;
		try {
			resolved = await abortable(options.resolveApiKey?.() ?? Promise.resolve(undefined), signal);
		} catch (error) {
			if (signal?.aborted === true || isAbortError(error)) throw fetchAborted(signal, error);
			throw new WebError(`Firecrawl fetch credential resolution failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
		}
		if (resolved !== undefined && resolved.length > 0) return resolved;
		throw new WebError(
			`Firecrawl fetch has no API key for "${options.apiKeyEnv ?? FIRECRAWL_DEFAULT_API_KEY_ENV}"; store it through the credentials service, export it in the launching environment, or set a literal "apiKey" in the dsh-fetch-url-firecrawl config`,
			"WEB_PROVIDER_CREDENTIAL_MISSING"
		);
	}
}

/**
 * Project one config section into the options the provider serves its next
 * fetch with. Environment fallbacks stay here rather than in the provider.
 * @param ctx - plugin context supplying the credential and environment planes.
 * @param config - the currently authoritative section.
 * @returns options for one fetch.
 */
function resolveOptions(ctx, config) {
	const apiKeyEnv = credentialRef(config.apiKeyEnv ?? FIRECRAWL_DEFAULT_API_KEY_ENV);
	const literalApiKey = config.apiKey !== undefined && config.apiKey.length > 0 ? config.apiKey : undefined;
	return {
		...literalApiKey === undefined ? {} : { apiKey: literalApiKey },
		resolveApiKey: async () => {
			const credentials = ctx.get("credentials");
			if (credentials !== undefined) return (await credentials.resolve(apiKeyEnv))?.value;
			const ambient = launchEnvironmentOf(ctx).get(apiKeyEnv);
			return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined;
		},
		apiKeyEnv: config.apiKeyEnv ?? FIRECRAWL_DEFAULT_API_KEY_ENV,
		baseURL: config.baseURL ?? launchEnvironmentOf(ctx).get("FIRECRAWL_BASE_URL")?.value ?? FIRECRAWL_DEFAULT_BASE_URL,
		maxFetchedLength: config.maxFetchedLength ?? FIRECRAWL_DEFAULT_MAX_FETCHED_LENGTH,
		fullCopyDir: config.fullCopyDir ?? join(tmpdir(), FIRECRAWL_DEFAULT_TEMP_DIRNAME),
		recordRequest: (request) => {
			// `web/firecrawl-fetch-request` is a plugin-owned event type,
			// outside the harness's known-event catalog by construction. The
			// persistence read path refuses unknown types unless the writer
			// marks them ignorable, so this diagnostic record MUST carry the
			// envelope flag — otherwise any build without this plugin in its
			// catalog refuses to load the session's history at all.
			ctx.get("agents")?.currentInitiator()?.session.append("web/firecrawl-fetch-request", request, { ignorable: true });
		}
	};
}

/** Cordis plugin name used by loader diagnostics. */
export const name = "dsh-fetch-url-firecrawl";

/** The web seam this provider registers into. */
export const inject = ["web"];

/** Plugin config (all fields optional; defaults resolve at request time). */
export const Config = z.object({
	/** Literal API key; overrides the credential reference. */
	apiKey: z.string().role("secret"),
	/** Credential/environment name for the API key. */
	apiKeyEnv: z.string().role("credential-ref").default(FIRECRAWL_DEFAULT_API_KEY_ENV),
	/** Endpoint base; `/v2/scrape` is appended. */
	baseURL: z.string(),
	/** Fetched-content cap in bytes; over-limit bodies spill to a full-copy file. */
	maxFetchedLength: z.number().step(1).min(1).default(FIRECRAWL_DEFAULT_MAX_FETCHED_LENGTH),
	/** Directory for full copies of over-limit fetched content. */
	fullCopyDir: z.string()
});

/**
 * Register the Firecrawl fetch provider with `ctx.web`, and layer the entry
 * under the user settings document so the section is hot-editable and
 * claimable by a settings card (namespace is the join key for both halves).
 *
 * @param ctx - plugin context.
 * @param config - the composition entry config (the section's `base`).
 */
export function apply(ctx, config) {
	let current = () => config;
	installSettingsSection(ctx, FIRECRAWL_SETTINGS_NAMESPACE, Config, config, {
		setSource: (source) => {
			current = source;
		},
		onChange: () => {
			// The provider reads `current()` per fetch; nothing else to rebuild.
		}
	});
	ctx.web.registerFetchProvider(new FirecrawlFetchProvider(() => resolveOptions(ctx, current())));
}

export {
	FIRECRAWL_DEFAULT_BASE_URL,
	FIRECRAWL_DEFAULT_API_KEY_ENV,
	FIRECRAWL_DEFAULT_MAX_FETCHED_LENGTH,
	FIRECRAWL_PROVIDER_ID,
	FIRECRAWL_SETTINGS_NAMESPACE,
	FirecrawlFetchProvider,
	assertHttpUrl,
	capFetchedLength,
	fullCopyName,
	mapScrapeResponse,
	renderFullCopy,
	truncateUtf8
};

/* jscpd:ignore-start */
/** Throw the provider's stable cancellation error when the caller already aborted. */
function throwIfAborted(signal) {
	if (signal?.aborted === true) throw fetchAborted(signal);
}

/** Build the provider's stable cancellation error while retaining the caller's reason. */
function fetchAborted(signal, fallback) {
	return new WebError("Firecrawl fetch aborted", "WEB_ABORTED", { cause: signal?.aborted === true ? signal.reason : fallback });
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error) {
	return error instanceof DOMException && error.name === "AbortError";
}

/** True for a positive whole number (a limit that can be enforced). */
function isPositiveInteger(value) {
	return Number.isInteger(value) && value > 0;
}

/**
 * Race a same-process asynchronous preflight against caller cancellation. The
 * attached settlement handlers keep observing an uncooperative operation after
 * abort so a later rejection cannot become unhandled.
 */
function abortable(operation, signal) {
	if (signal === undefined) return operation;
	if (signal.aborted) return Promise.reject(fetchAborted(signal));
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			reject(fetchAborted(signal));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		operation.then((value) => {
			signal.removeEventListener("abort", onAbort);
			resolve(value);
		}, (error) => {
			signal.removeEventListener("abort", onAbort);
			reject(new Error(String(error).replace(/^Error: /u, ""), { cause: error }));
		});
	});
}
/* jscpd:ignore-end */
