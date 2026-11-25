# Sweed POS Integration — Hard Hitta Supplies

| | |
|---|---|
| Store identifier | `s1141` — menu served from upstream `/menu` (Sweed, 2026-11-25) |
| Public menu URL | `https://hardhitta.supplies/menu` |
| Upstream | `https://web-ui-prime.sweedpos.com/menu` |
| Implementation | `src/index.ts`, routed via `run_worker_first` in `wrangler.jsonc` |

---

## 1. Sweed's instructions — verified

Sweed (Karim and Eva) confirmed the final configuration on 2026-11-25. Checked
against the implementation:

| Sweed requirement | Status |
|---|---|
| Public menu at `https://hardhitta.supplies/menu` | ✅ matches `run_worker_first` and `MENU_PREFIX` |
| Forward to `https://web-ui-prime.sweedpos.com/menu` | ✅ `SWEED_UPSTREAM` + verbatim path |
| Preserve full path and query | ✅ tested, including their `?id=5` example |
| Send `X-Forwarded-Host: hardhitta.supplies` | ✅ set from `PUBLIC_HOST`, overrides client values |
| True reverse proxy, not a redirect / iframe / DNS-only | ✅ `fetch()` to upstream, browser stays on our domain |

Their email says "once everything is set up and **redirects**". That wording is
loose — their own Notes section is correct that this is a reverse proxy, not an
HTTP redirect. The implementation is a proxy. No action needed.

### Store slug changed

The slug moved from `hardhittasupplyco` to `hardhittasupplies`. Updated
throughout: `MENU_PREFIX` in `src/index.ts`, `run_worker_first` in
`wrangler.jsonc`, all 10 site CTAs, `robots.txt`, `sitemap.xml`, and the tests.
`/hardhittasupplyco` is no longer proxied and now returns a 404 from static
assets — confirmed against `wrangler dev`.

### Worth asking before you send

Sweed offered: *"If you would like the /{storename} to reflect differently
please let me know."* The current result is
`hardhitta.supplies/menu`, which stutters — the brand name appears
twice. A shorter slug such as `/menu` or `/shop` would read better and is a
one-line change on our side (`MENU_PREFIX` plus the matching
`run_worker_first` patterns). Cheap to change now, annoying once links are
printed and indexed.

---

## 2. Blocker: the store is still not provisioned

Probed 2026-11-25, after the slug change. The **new** slug returns the same
404, 192 bytes, as the old one:

```html
<html><head><title>Store is not found</title></head>
<body><h1>Store is not found</h1></body></html>
```

| Request | Result |
|---|---|
| `/menu` | 404 `Store is not found` |
| `/menu` + `X-Forwarded-Host: hardhitta.supplies` | 404 |
| `/menu/menu/item?id=5` + `X-Forwarded-Host` | 404 |
| `/hardhittasupplyco` (previous slug) | 404 |
| `/` (upstream root) | 404 |

"Store is not found" is Sweed's own application response, not a generic edge
404 — requests reach Sweed's router, which then fails to resolve a store. The
host and path are right; the store is not active yet.

Earlier probing (before the domain and slug were settled) showed the same 404
for `X-Forwarded-Host: theauthenticcannabis.com` and for the old
`/hardhittasupplyco` path, and the previous reference site
`www.theauthenticcannabis.com/hardhittasupplyco` served a Vercel 404. So there
has never been a working deployment of this store to compare against.

The proxy is complete and verified. It cannot be validated end to end until
Sweed activates the store. Until then the correct behaviour is exactly what
happens now: Sweed's 404 passes through unchanged. A test asserts that.

### Reply to send Sweed

> Thanks — confirming `hardhitta.supplies` and the `/menu` path.
> Our reverse proxy is built, tested and ready: it preserves the full path and
> query string and sends `X-Forwarded-Host: hardhitta.supplies` and
> `X-Forwarded-Proto: https` on every request. Nameservers are on Cloudflare
> and the zone is active with a valid certificate.
>
> One thing to flag before we go live: as of today every request to
> `https://web-ui-prime.sweedpos.com/menu` returns a 404 with the
> body `<h1>Store is not found</h1>`, with and without the `X-Forwarded-Host`
> header. The upstream root returns the same. So the store does not appear to
> be active yet on that host.
>
> Could you confirm:
>
> 1. Is the store `hardhittasupplies` provisioned and active on
>    `web-ui-prime.sweedpos.com`, and is `hardhitta.supplies` registered as its
>    authorized domain?
> 2. Is `web-ui-prime.sweedpos.com` the correct upstream for our account?
> 3. Do you key the store lookup on `X-Forwarded-Host`, or do you also need the
>    `Host` header rewritten to our domain?
> 4. Does `https://hardhitta.supplies` need adding to any allowed-origin / CORS list?
> 5. Do authentication callbacks, checkout redirects or payment return URLs need
>    updating to our domain?
> 6. Any cookie domain or `SameSite` settings we should account for?
> 7. **Are there paths outside `/menu/*` that the menu needs** —
>    API endpoints, static assets, websockets? Anything outside that prefix will
>    not reach the proxy.
> 8. Should the proxied menu pages be indexable, and do you emit your own
>    canonical tags?
> 9. Are AI recommendations / upselling enabled, and is extra configuration needed?
> 10. How should we wire analytics and conversion tracking for the menu?
>
> Also — you mentioned the `/{storename}` path can be changed. We may prefer a
> shorter path such as `/menu`; could you confirm whether that is supported?

Question 7 matters most after activation: assets loaded from outside the prefix
will miss the proxy and 404. Do not widen the prefix speculatively — get the
list from Sweed, then extend `run_worker_first` and the handler's path check
together.

---

## 3. What the proxy does

### Routing

Only `/menu` and `/menu/*` reach the Worker script.
Everything else is served from static assets without invoking it. The handler
re-checks the prefix itself rather than trusting routing alone, and falls back
to `env.ASSETS.fetch()` otherwise.

The check is exact — `pathname === prefix || pathname.startsWith(prefix + "/")`.
A lookalike path like `/menu-evil/x` does **not** match and is never
proxied. There is a test for that.

### Request handling

- Upstream origin is taken from `SWEED_UPSTREAM` and is **fixed**. The target is
  never derived from user input, so this cannot be used as an open proxy.
- Path and query are copied verbatim from the inbound URL.
- Method, body, and content type pass through unchanged. `GET`/`HEAD` send no body.
- Cookies pass through so cart and session work.
- These client-supplied headers are **stripped** before the upstream call, then
  replaced with our own values: `host`, `forwarded`, `x-forwarded-host`,
  `x-forwarded-proto`, `x-forwarded-port`, `x-forwarded-server`, `x-real-ip`,
  plus the hop-by-hop set. A client cannot spoof the domain Sweed sees.
- `X-Forwarded-For` is set from Cloudflare's trusted `CF-Connecting-IP`.
- `redirect: "manual"` so redirects can be inspected.

### Response handling

- **`Location` rewriting is conditional.** A redirect back to the Sweed origin is
  rewritten to `https://hardhitta.supplies/...`. A redirect anywhere else —
  payment processor, identity provider — is passed through untouched. No blanket
  URL or HTML rewriting is done.
- **`Set-Cookie` `Domain=` is stripped.** Sweed scopes cookies to its own domain;
  a browser on `hardhitta.supplies` would reject those outright and silently
  break cart and session. Removing the attribute makes the cookie host-only for
  our domain. `Secure`, `HttpOnly`, `SameSite`, `Path`, and `Max-Age` are
  preserved — no security attribute is weakened.
- Status codes and bodies pass through unchanged, including Sweed's own errors.
- Hop-by-hop and length/encoding headers are dropped so the runtime can set them.

### Caching

Disabled: `cacheEverything: false`, `cacheTtl: 0`. Carts, sessions, pricing, and
personalised content must never be cached. Revisit only after the integration is
validated, and only for demonstrably public static assets.

### Failure mode

If the upstream is unreachable the customer gets a branded 502 page with
`Cache-Control: no-store`, not a stack trace. Sweed's own error responses are
passed through rather than masked.

---

## 4. Verified behaviour

Against a local echo upstream via `wrangler dev`, with deliberately spoofed
inbound headers:

```
request : GET /menu/menu/item?id=5
          X-Forwarded-Host: attacker.example.com
          Forwarded: host=evil.com
          Cookie: sweed_session=abc

upstream url      : /menu/menu/item?id=5   ← path + query preserved
method            : GET
x-forwarded-host  : hardhitta.supplies                  ← spoof overridden
x-forwarded-proto : https
forwarded         : None                                ← spoof dropped
cookie            : sweed_session=abc                   ← session preserved
```

```
response Set-Cookie in : sid=echo123; Domain=web-ui-prime.sweedpos.com; Path=/; Secure; HttpOnly; SameSite=Lax
response Set-Cookie out: sid=echo123; Path=/; Secure; HttpOnly; SameSite=Lax
```

```
POST /menu/api/cart  body {"sku":"ABC","qty":2}
  → method: POST | url: /menu/api/cart | body: {"sku":"ABC","qty":2}
```

Against the **real** Sweed upstream, the proxy correctly returns Sweed's
`Store is not found` 404 — confirming connectivity and faithful pass-through.

---

## 5. Test suite

`npm test` — 21 tests, all passing.

Route matching (5) · open-proxy protection (4) · forwarded headers (4) ·
methods and bodies (2) · response handling (6).

Covered: exact and nested paths, trailing slash, Sweed's `?id=5` example,
encoded multi-param queries, lookalike-prefix rejection, unrelated routes,
fixed-origin enforcement, static site serving, `X-Forwarded-Host`/`-Proto`,
spoof override, `Forwarded` stripping, cookie forwarding, POST body
preservation, empty GET body, conditional `Location` rewriting, external
redirect preservation, `Set-Cookie` domain stripping with flags retained,
status pass-through, the real `Store is not found` body, and the 502 path.

---

## 6. Post-activation verification

Once Sweed confirms the store is live:

```bash
curl -sI https://hardhitta.supplies/menu
curl -sI "https://hardhitta.supplies/menu/menu/item?id=5"
```

Then in a browser with DevTools open: product listings, categories, detail
pages, images, search, filtering, inventory, add-to-cart, cart persistence
across navigation, customer login, session persistence, checkout reachability,
AI recommendations if enabled, promotions if enabled, and mobile layout. Watch
the Network and Console panels for requests escaping the `/menu`
prefix, CSP violations, and CORS errors.

**Do not submit a real order or process a payment without explicit authorization.**

---

## 7. SEO

`robots.txt` allows the menu path and points at `sitemap.xml`, which lists the
home page and the menu entry. The home page carries
`<link rel="canonical" href="https://hardhitta.supplies/">`.

Open question for Sweed (§2, Q9): whether their pages emit their own canonical
tags. If they emit canonicals pointing at `sweedpos.com`, the proxied pages will
de-index in favour of Sweed's domain and may create duplicate-content conflicts.
Confirm before investing further in menu SEO. Do not assume the Sweed menu
supports the same SEO surface as the marketing site.

---

## 8. Security notes

- The upstream host is fixed in config and never taken from user input.
- Path validation is exact-prefix, so the Worker cannot be used as an open proxy.
- Forwarded headers are stripped then re-set; client values are never trusted.
- Upstream connections are HTTPS with standard TLS verification. Verification is
  not disabled anywhere, and no browser security protection is weakened to make
  the integration work.
- The marketing site sets no cookies and has no authentication, so there are no
  first-party credentials that could leak to Sweed. If auth is ever added to the
  site, revisit the cookie forwarding in `proxyToSweed()` and forward only what
  Sweed needs.
- No secrets exist in this project; nothing sensitive is committed.
- Nothing logs bodies, cookies, credentials, or customer data.
