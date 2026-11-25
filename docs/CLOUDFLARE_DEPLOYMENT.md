# Cloudflare Deployment — Hard Hitta Supplies

Production domain: **hardhitta.supplies**
Worker name: **hardhitta-supplies-web**
Menu path: **/hardhittasupplyco** → `https://web-ui-prime.sweedpos.com/hardhittasupplyco`

---

## 1. Architecture assessment

### What existed before this work

| Aspect | Finding |
|---|---|
| Stack | One static `index.html` (~32 KB). No framework, no build step. |
| Backend | None. |
| Package manager | None — no `package.json`. |
| Dependencies | None installed. CDN links only (Google Fonts, p5.js, Cloudinary images). |
| Environment variables | None. |
| Cloudflare config | None. |
| Wrangler config | None. |
| Pages/Workers config | None. |
| API integrations | None. Cloudinary is used for image hosting via URL transforms. |
| Sweed integration | None. Shop CTAs were in-page anchors to `#delivery`. |
| Routing | Single page, hash anchors only. |
| Deployment pipeline | None. |
| Git | Not a repository. Initialised during this work. |
| Auth / security config | None. No cookies, no sessions, no credentials. |

### Chosen architecture: a single Worker with Static Assets

The brief suggested a **dedicated** `hardhitta-sweed-proxy` Worker. I checked that
against the routing model and implemented the **integrated** option instead.

Reason: the site itself has to be served by something. If the site is a Worker
with a custom domain on `hardhitta.supplies`, that custom domain captures all
traffic for the hostname. A second Worker holding a route on a sub-path of the
same hostname puts two competing matchers on one zone, and the precedence
between a custom domain and an overlapping route is exactly the kind of
ambiguity that produces a hard-to-debug outage on the menu path.

One Worker removes the question. `run_worker_first` scopes script execution to
the two menu patterns; every other path is served straight from the static
asset store and never invokes the script, so there is no added cost or latency
for normal page views.

```jsonc
"assets": {
  "directory": "./public",
  "binding": "ASSETS",
  "not_found_handling": "404-page",
  "run_worker_first": ["/hardhittasupplyco", "/hardhittasupplyco/*"]
}
```

If you later need the proxy split out, the handler in `src/index.ts` is already
self-contained and can be lifted into its own Worker without modification.

---

## 2. Repository layout

```
.
├── public/              # static assets, served directly
│   ├── index.html
│   ├── robots.txt
│   └── sitemap.xml
├── src/
│   └── index.ts         # Worker: Sweed reverse proxy + asset fallback
├── test/
│   └── proxy.test.ts    # 21 tests
├── docs/
│   ├── CLOUDFLARE_DEPLOYMENT.md
│   └── SWEED_INTEGRATION.md
├── wrangler.jsonc
├── vitest.config.ts
├── tsconfig.json
└── worker-configuration.d.ts   # generated — do not hand-edit
```

---

## 3. Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Local Worker + assets on `http://127.0.0.1:8787` |
| `npm test` | Vitest suite in the workerd runtime |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run deploy:dry` | Build and package without uploading |
| `npm run deploy` | Deploy to Cloudflare |
| `npm run cf-typegen` | Regenerate `worker-configuration.d.ts` after config changes |

Point the upstream somewhere else for a local experiment without editing config:

```bash
npx wrangler dev --var SWEED_UPSTREAM:http://127.0.0.1:9999
```

---

## 4. Environment variables

Both are plain vars in `wrangler.jsonc` — neither is a secret.

| Variable | Value | Purpose |
|---|---|---|
| `SWEED_UPSTREAM` | `https://web-ui-prime.sweedpos.com` | Fixed proxy target. Only the origin is used; the path always comes from the inbound request. |
| `PUBLIC_HOST` | `hardhitta.supplies` | Value sent as `X-Forwarded-Host`, and the host used when rewriting Sweed redirects. |

There are no secrets in this project. If one is ever needed use
`npx wrangler secret put NAME` — never commit it. Note that `wrangler secret put`
creates and deploys a new version immediately; use
`npx wrangler versions secret put` to stage one instead.

---

## 5. Compatibility date

Pinned to `2026-08-22`, which is the newest date the installed `workerd` binary
supports. A date newer than the local runtime makes both `wrangler dev` and the
test suite fail to boot with `ERR_RUNTIME_FAILURE`. To move it forward: upgrade
`wrangler`, then raise the date, then re-run `npm test`.

---

## 6. Deployment sequence

Steps 1–5 are done. Steps 6 onward need your action.

1. ✅ Inspect and back up existing configuration
2. ✅ Website code changes
3. ✅ Reverse proxy implemented
4. ✅ Local tests pass
5. ⬜ **Deploy preview** — `npx wrangler deploy` publishes to
   `hardhitta-supplies-web.<subdomain>.workers.dev` while `workers_dev: true`
   and routes stay commented out. Nothing touches the live domain.
6. ⬜ **Register `hardhitta.supplies`** — see §7
7. ⬜ **Add the zone to Cloudflare** and import DNS
8. ⬜ **Approval**, then update nameservers at the registrar
9. ⬜ **Verify zone Active**
10. ⬜ **Uncomment `routes`** in `wrangler.jsonc`, set `workers_dev: false`, redeploy
11. ⬜ **Verify HTTPS**
12. ⬜ **Sweed provisions the store** — see `SWEED_INTEGRATION.md`
13. ⬜ **Validate** the full customer journey
14. ⬜ **Monitor**

---

## 7. Domain status — blocker

`hardhitta.supplies` **is not registered.** Verified three ways on 2026-11-25:

```
dig +trace hardhitta.supplies NS   → NSEC3 denial-of-existence from .supplies
RDAP (Identity Digital)            → 404 Object not found
whois hardhitta.supplies           → falls through to IANA TLD record only
```

Register it before any DNS or deployment work. `.supplies` is an Identity
Digital (Binky Moon) TLD; GoDaddy sells it, so registration can stay with your
existing registrar account.

### The other domain in the brief

The brief named `hardhittasupplies.com` as production with GoDaddy as DNS
provider. That is not what is live:

```
hardhittasupplies.com NS  → ns8.wixdns.net, ns9.wixdns.net
hardhittasupplies.com A   → 185.230.63.107/.186/.171   (Wix)
https://hardhittasupplies.com → HTTP 404, server: Pepyaka (Wix)
MX / SPF / DMARC / DNSSEC → none present
```

So DNS for that domain is delegated to **Wix**, not GoDaddy, and a Wix property
exists but publishes nothing at the apex. No email records exist on it, so there
is no mail to preserve. Nothing in this project modifies that domain.

---

## 8. Registrar → Cloudflare migration

Once the domain is registered. Registration and renewal stay with the registrar;
only the nameservers move.

1. **Record the current state first.** Screenshot the registrar's DNS panel and save:
   ```bash
   for t in NS A AAAA MX TXT CNAME CAA SOA DS; do echo "--- $t"; dig +short hardhitta.supplies $t; done
   dig +short _dmarc.hardhitta.supplies TXT
   dig +short www.hardhitta.supplies
   ```
2. **Add the zone** in the Cloudflare dashboard → Add a site → enter the domain →
   pick a plan (Free is sufficient). Cloudflare scans and imports existing records.
3. **Compare the import against your screenshot, record by record.** The scan is
   best-effort and routinely misses records. Preserve: `MX`, SPF (`TXT`), DKIM
   (`TXT` on selector subdomains), `_dmarc` (`TXT`), any verification `TXT`,
   existing subdomains, service `CNAME`s, and `CAA`.
4. **DNSSEC.** If it is ever enabled at the registrar, disable it there and wait
   for the DS record to clear *before* changing nameservers — otherwise
   resolvers reject the zone and the domain goes dark. For a freshly registered
   domain this is normally off; confirm with `dig +short hardhitta.supplies DS`
   (empty = off).
5. **Read your assigned nameservers** from Cloudflare's overview page. They are
   account-specific — I have not guessed them, and you should not use any pair
   found in a tutorial.
6. **Update nameservers at the registrar** (GoDaddy: *My Products → DNS → Nameservers
   → Change → I'll use my own*). Replace both entries with Cloudflare's pair.
7. **Wait for activation.** Usually minutes; the TLD allows up to 24 h. Cloudflare
   emails on activation.
8. **Verify:**
   ```bash
   dig +short hardhitta.supplies NS          # expect the Cloudflare pair
   curl -sI https://hardhitta.supplies | head -3
   ```

### DNS records to create for this deployment

| Type | Name | Content | Proxy |
|---|---|---|---|
| A | `@` | `192.0.2.1` (placeholder) | Proxied |
| A | `www` | `192.0.2.1` (placeholder) | Proxied |

The placeholder IP is never contacted — a proxied record is required for a
Worker route to fire, and the Worker answers before any origin fetch. If you
prefer, attach a Custom Domain to the Worker instead and Cloudflare manages the
record for you.

### www redirect

Handled by a Redirect Rule, not the Worker, so it costs nothing and applies to
every path. Dashboard → Rules → Redirect Rules → Create:

- **If** hostname equals `www.hardhitta.supplies`
- **Then** dynamic redirect, status **301**
- **Expression:** `concat("https://hardhitta.supplies", http.request.uri.path)`
- Enable **preserve query string**

---

## 9. Production validation

Run after the zone is live and Sweed has provisioned the store.

```bash
curl -sI https://hardhitta.supplies                                  # 200
curl -sI https://www.hardhitta.supplies                              # 301 → apex
curl -sI https://hardhitta.supplies/hardhittasupplyco                # expect 200
curl -sI https://hardhitta.supplies/hardhittasupplyco/               # expect 200
curl -sI "https://hardhitta.supplies/hardhittasupplyco/menu/item?id=5"
curl -sI https://hardhitta.supplies/robots.txt                       # 200
curl -sI https://hardhitta.supplies/nope                             # 404
```

Checklist: valid certificate · www redirects preserving path and query · site
pages intact · menu loads · path and query preserved · product images load ·
search and filter work · cart persists across requests · session survives
navigation · checkout reachable · mobile and desktop both render · no unexpected
redirects · no CORS errors in the console.

---

## 10. Monitoring

`observability` is enabled in `wrangler.jsonc` at a 100% head sampling rate.

```bash
npx wrangler tail --format pretty                 # live
npx wrangler tail --status error                  # errors only
npx wrangler deployments list
```

Dashboard → Workers & Pages → `hardhitta-supplies-web` → Logs / Metrics for
invocations, error rate, p50/p99 CPU, and subrequest counts. Worth alerting on:
sustained 502s (upstream down), a 4xx spike on the menu path (store
deprovisioned), and latency regressions.

Nothing in the proxy logs request bodies, cookies, or headers.

---

## 11. Troubleshooting

| Symptom | Likely cause | Check |
|---|---|---|
| `Store is not found` (404, 192 b) | Sweed has not provisioned the store for this domain | `curl -I https://web-ui-prime.sweedpos.com/hardhittasupplyco` — same response direct means it is upstream, not the proxy |
| Friendly 502 page | Worker could not reach Sweed | `npx wrangler tail` |
| Menu 404s but the site works | Route not matching | Confirm `run_worker_first` patterns and that routes are uncommented |
| Site 404s but the menu works | Assets missing from the deploy | `npm run deploy:dry` → "Read N files from the assets directory" |
| Cart or login does not persist | `Set-Cookie` rejected | DevTools → Network → Response Headers; confirm no `Domain=` attribute survives |
| Redirected to `sweedpos.com` | A `Location` rewrite was missed | Compare against `rewriteLocation()` in `src/index.ts` |
| `ERR_RUNTIME_FAILURE` locally | `compatibility_date` newer than local workerd | See §5 |
| `Incorrect type for map entry` at startup | A non-handler value exported from `src/index.ts` | Only the default export may be a value; keep constants unexported |

---

## 12. Rollback

| Change | How to undo |
|---|---|
| Worker code | `npx wrangler rollback` (or `npx wrangler deployments list` then `rollback --version-id`). Connected resources are *not* rolled back. |
| Worker routes | Comment out `routes` in `wrangler.jsonc` and redeploy, or delete them in the dashboard. Traffic falls back to the origin/DNS target. |
| Custom domain | Workers & Pages → Settings → Domains & Routes → remove. |
| Proxy only, site intact | Set `run_worker_first` to `[]` and redeploy — the menu path then serves a 404 from assets while the site keeps working. |
| DNS record | Restore from the §8.1 capture. |
| Nameservers | Re-enter the previous nameservers at the registrar. Propagation is subject to TTL. |

Site code is in git; `git revert` plus a redeploy restores any earlier state.

---

## 13. Access you may need to grant

I could not authenticate to Cloudflare — `wrangler whoami` reported the stored
token expired and the environment is non-interactive.

To deploy yourself:

```bash
npx wrangler login     # interactive browser flow
npx wrangler whoami    # confirm the correct account before deploying
npm run deploy
```

For CI, use an account-owned API token rather than the OAuth flow, scoped to the
minimum: **Workers Scripts: Edit**, **Workers Routes: Edit**, **Zone: Read**, and
**DNS: Edit** only if you want DNS managed from CI. Store it as
`CLOUDFLARE_API_TOKEN` in the CI secret store. Do not paste a token into chat.
