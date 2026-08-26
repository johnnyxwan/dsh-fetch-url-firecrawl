# dsh-fetch-url-firecrawl

Firecrawl-backed fetch provider for the DSH web capability seam (`ctx.web`).
Gives a DSH profile's `web_fetch` tool rendered-markdown retrieval via
Firecrawl's scrape API (`POST /v2/scrape`, markdown format), instead of raw
HTML.

- **Provider id:** `dsh-fetch-url-firecrawl`
- **Settings namespace:** `dsh-fetch-url-firecrawl` (`maxFetchedLength`, default `4096` bytes; over-limit bodies are trimmed with a spill-file pointer in the tool context)
- **API key:** `FIRECRAWL_API_KEY` — from the DSH credentials store (GUI: *Settings → Credentials*), the process environment, or a literal `config.apiKey`. The endpoint base URL can be overridden with the `FIRECRAWL_BASE_URL` environment variable.

## Install (one command)

```sh
dsh plugin --profile web add git+https://github.com/johnnyxwan/dsh-fetch-url-firecrawl.git
```

`dsh plugin` forwards to pnpm in the profile directory and then reconciles
`dsh.profile.bundles`: because this package declares `dsh.bundle.patch`
(`./cordis.patch.yml`), the launcher applies its bundle layer at boot, mounting
the `dsh-fetch-url-firecrawl` provider entry. No build step is involved.

## Wire it up (profile's own `cordis.patch.yml`)

The bundle layer only mounts the provider entry. **Selecting** it is a
deployment choice, made in the profile's own `cordis.patch.yml`
(`~/.dsh/profiles/<profile>/cordis.patch.yml`, applied after every bundle
layer):

```yaml
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    fetchProvider: dsh-fetch-url-firecrawl
    searchProvider: <your search provider, if any>
```

Note: entry-patch overrides replace whole config keys, so the `id: web` row
must state every provider selection the profile wants in one place.

### Tool enablement

Whether a session's model can actually call `web_fetch` is a separate gate
from provider selection:

- **Web surface** (`dsh-web-app` profile): the host `tool-web` row is
  disabled by the bundle by design; per-session tool enablement comes from
  the **agent preset** in use. The shipped `standard`/`code` presets ship
  `fetch: false` — set `fetch: true` in the preset (or a derived one) for
  the sessions that should see `web_fetch`.
- **Non-web profile**: the host `tool-web` row is live and ships
  `fetch: false`; patch it in the profile's `cordis.patch.yml` (config keys
  replace wholesale, so carry the full intended config, e.g.
  `fetch: true` plus `searchTimeoutMs: 60000`).

After editing, restart the DSH server (the host half loads at boot).

## Uninstall

```sh
dsh plugin --profile web remove dsh-fetch-url-firecrawl
```

and remove the selection/enabling rows above from the profile's
`cordis.patch.yml`. Persisted settings under the `dsh-fetch-url-firecrawl`
namespace survive uninstall.

## Layout

| file | role |
| --- | --- |
| `index.js` | host half: registers the fetch provider + settings section |
| `client.js` | browser half: the settings card (served at `/plugins/dsh-fetch-url-firecrawl/client.js`) |
| `cordis.patch.yml` | the bundle layer (`dsh.bundle.patch`) |
| `test.mjs` / `test-client.mjs` | host / browser test suites (`node test.mjs` / `node test-client.mjs`) |
| `dist/enable-fetch-preset.mjs` | deployment-maintenance tool (not part of the plugin runtime): patches the *shipped* standard/code agent presets (`fetch: false` → `true`) in the dsh installation — the `web_fetch` enablement gate on the web surface; re-run after a dsh upgrade |
