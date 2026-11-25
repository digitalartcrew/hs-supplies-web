# Sweed POS Integration — Hard Hitta Supplies

| | |
|---|---|
| Store identifier | `hardhittasupplyco` (unchanged) |
| Public menu URL | `https://hardhitta.supplies/hardhittasupplyco` |
| Upstream | `https://web-ui-prime.sweedpos.com/hardhittasupplyco` |
| Implementation | `src/index.ts`, routed via `run_worker_first` in `wrangler.jsonc` |

---

## 1. Blocker: the upstream store is not provisioned

Probed on 2026-11-25. **Every** request to the Sweed upstream returns the same
404, 192 bytes:

```html
<html><head><title>Store is not found</title></head>
<body><h1>Store is not found</h1></body></html>
```

That response is identical for all of:

| Request | Result |
|---|---|
| `/hardhittasupplyco` | 404 `Store is not found` |
| `/hardhittasupplyco/` | 404 `Store is not found` |
| `/hardhittasupplyco` + `X-Forwarded-Host: hardhitta.supplies` | 404 |
| `/hardhittasupplyco` + `X-Forwarded-Host: theauthenticcannabis.com` | 404 |
| `/hardhittasupplyco` + `Host: theauthenticcannabis.com` | 404 |
| `/` (upstream root) | 404 |

Two conclusions:

1. **The host is correct but the store is not active.** "Store is not found" is
   Sweed's own application response, not a generic edge 404 — the request is
   reaching Sweed's router, which then fails to resolve a store.
2. **The originally supplied domain does not work either.** Sweed's instructions
   said to send `X-Forwarded-Host: theauthenticcannabis.com`; that value returns
   the same 404. The reference site also 404s —
   `https://www.theauthenticcannabis.com/hardhittasupplyco` serves a Next.js 404
   page from Vercel. So there is no working deployment of this store anywhere
   to copy behaviour from.

The proxy is complete and verified. It cannot be validated end-to-end until
Sweed activates the store. Until then the correct, faithful behaviour is exactly
what happens today: the proxy passes Sweed's 404 through unchanged. There is a
test asserting that.

---

## 2. Message to send to Sweed

> Hi — we're setting up the reverse proxy for our Sweed menu and need the store
> provisioned against our production domain.
>
> **Store identifier:** `hardhittasupplyco`
> **Our production domain:** `hardhitta.supplies`
> **Public menu URL:** `https://hardhitta.supplies/hardhittasupplyco`
> **Upstream we are proxying to:** `https://web-ui-prime.sweedpos.com/hardhittasupplyco`
>
> Our proxy is built and tested. It preserves the full path and query string,
> and sends `X-Forwarded-Host: hardhitta.supplies` and
> `X-Forwarded-Proto: https` on every request.
>
> Right now every request to
> `https://web-ui-prime.sweedpos.com/hardhittasupplyco` returns a 404 with the
> body `<h1>Store is not found</h1>` — including when we send
> `X-Forwarded-Host: theauthenticcannabis.com`, the domain in your original
> instructions. The upstream root returns the same thing. So we believe the
> store is not currently active for any domain.
>
> Could you please confirm:
>
> 1. Is `hardhittasupplyco` the correct store identifier, and is it active?
> 2. Please register **`hardhitta.supplies`** as the authorized domain for this
>    store, and remove `theauthenticcannabis.com` — we are not using that domain.
> 3. Is `web-ui-prime.sweedpos.com` the correct upstream for our account, or
>    should we target a different host?
> 4. Is `X-Forwarded-Host` the header you key the store lookup on, or do you also
>    need the `Host` header rewritten to our domain?
> 5. Any allowed-origin / CORS list that needs `https://hardhitta.supplies` added?
> 6. Do authentication callbacks, checkout redirects, or payment return URLs need
>    updating to our domain?
> 7. Any cookie domain or `SameSite` configuration we should know about?
> 8. Are there additional paths outside `/hardhittasupplyco/*` that the menu
>    requires — API endpoints, static assets, websockets — that we need to proxy?
> 9. Should the proxied menu pages be indexable, and do you set canonical tags?
> 10. Are AI recommendations / upselling enabled for this store, and is any
>     extra configuration needed?
> 11. How should we wire analytics and conversion tracking for the menu?
>
> Thanks.

Question 8 matters most after activation: if the menu loads assets from a path
outside the prefix, those requests will miss the proxy and 404. Do not widen the
proxy prefix speculatively — get the list from Sweed, then extend
`run_worker_first` and the handler's path check together.

---

## 3. What the proxy does

### Routing

Only `/hardhittasupplyco` and `/hardhittasupplyco/*` reach the Worker script.
Everything else is served from static assets without invoking it. The handler
re-checks the prefix itself rather than trusting routing alone, and falls back
to `env.ASSETS.fetch()` otherwise.

The check is exact — `pathname === prefix || pathname.startsWith(prefix + "/")`.
A lookalike path like `/hardhittasupplyco-evil/x` does **not** match and is never
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
request : GET /hardhittasupplyco/menu/item?id=5
          X-Forwarded-Host: attacker.example.com
          Forwarded: host=evil.com
          Cookie: sweed_session=abc

upstream url      : /hardhittasupplyco/menu/item?id=5   ← path + query preserved
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
POST /hardhittasupplyco/api/cart  body {"sku":"ABC","qty":2}
  → method: POST | url: /hardhittasupplyco/api/cart | body: {"sku":"ABC","qty":2}
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
curl -sI https://hardhitta.supplies/hardhittasupplyco
curl -sI "https://hardhitta.supplies/hardhittasupplyco/menu/item?id=5"
```

Then in a browser with DevTools open: product listings, categories, detail
pages, images, search, filtering, inventory, add-to-cart, cart persistence
across navigation, customer login, session persistence, checkout reachability,
AI recommendations if enabled, promotions if enabled, and mobile layout. Watch
the Network and Console panels for requests escaping the `/hardhittasupplyco`
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
