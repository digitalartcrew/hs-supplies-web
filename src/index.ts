/**
 * Hard Hitta Supplies — site Worker + Sweed POS reverse proxy.
 *
 * Two jobs in one Worker:
 *   1. Serve the static site (handled by the ASSETS binding).
 *   2. Reverse-proxy /menu[/*] to Sweed POS so the menu appears
 *      to live on hardhitta.supplies.
 *
 * Only the proxy prefix reaches this script — see `run_worker_first` in
 * wrangler.jsonc. Every other path is served directly from static assets and
 * never invokes the Worker.
 */

export interface Env {
  ASSETS: Fetcher;
  /** Origin of the Sweed upstream, e.g. https://web-ui-prime.sweedpos.com */
  SWEED_UPSTREAM: string;
  /** Public hostname customers see, e.g. hardhitta.supplies */
  PUBLIC_HOST: string;
}

/**
 * Sweed store identifier. Also the public path prefix — Sweed expects both to match.
 *
 * Deliberately NOT exported: workerd treats every named export of the entry
 * module as a Worker entrypoint and rejects a plain string at startup.
 */
const MENU_PREFIX = "/menu";

/**
 * Hop-by-hop and client-controlled forwarding headers. These are stripped from
 * every inbound request before we add our own, so a caller cannot spoof the
 * domain Sweed sees by sending their own X-Forwarded-Host.
 */
const STRIPPED_REQUEST_HEADERS = [
  "host",
  "forwarded",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-forwarded-server",
  "x-real-ip",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
];

/** Response headers that must not be copied verbatim from the upstream. */
const STRIPPED_RESPONSE_HEADERS = [
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
];

const isMenuPath = (pathname: string): boolean =>
  pathname === MENU_PREFIX || pathname.startsWith(`${MENU_PREFIX}/`);

/** Status codes whose responses must not carry a body. */
const BODYLESS_STATUS = new Set([101, 204, 205, 304]);

/**
 * Rewrite a Location header that points back at the Sweed origin so the
 * customer stays on our domain. Redirects to anywhere else — payment
 * processors, identity providers — are passed through untouched.
 */
function rewriteLocation(
  location: string,
  upstreamOrigin: string,
  publicHost: string,
): string {
  let target: URL;
  try {
    // Relative Locations are legal; resolve against the upstream to compare hosts.
    target = new URL(location, upstreamOrigin);
  } catch {
    return location;
  }

  if (target.origin !== new URL(upstreamOrigin).origin) {
    return location; // external redirect — leave it alone
  }

  target.protocol = "https:";
  target.host = publicHost;
  return target.toString();
}

/**
 * Sweed sets cookies scoped to its own domain. A `Domain=...sweedpos.com`
 * attribute would be rejected outright by the browser on hardhitta.supplies,
 * which silently breaks cart and session persistence. Dropping the attribute
 * makes the cookie host-only for our domain, which is what we want. Security
 * attributes (Secure, HttpOnly, SameSite, Path, Max-Age) are preserved.
 */
function rewriteSetCookie(cookie: string): string {
  return cookie
    .split(";")
    .filter((part) => !/^\s*domain=/i.test(part))
    .join(";");
}

async function proxyToSweed(request: Request, env: Env): Promise<Response> {
  const incoming = new URL(request.url);

  const upstreamOrigin = new URL(env.SWEED_UPSTREAM).origin;
  const upstreamUrl = new URL(upstreamOrigin);
  upstreamUrl.pathname = incoming.pathname; // full path preserved, prefix included
  upstreamUrl.search = incoming.search; // query string preserved verbatim

  const headers = new Headers(request.headers);
  for (const name of STRIPPED_REQUEST_HEADERS) headers.delete(name);

  // Authoritative values — these override anything the client sent.
  headers.set("X-Forwarded-Host", env.PUBLIC_HOST);
  headers.set("X-Forwarded-Proto", "https");

  const clientIp = request.headers.get("CF-Connecting-IP");
  if (clientIp) headers.set("X-Forwarded-For", clientIp);

  const hasBody = request.method !== "GET" && request.method !== "HEAD";

  const upstreamRequest = new Request(upstreamUrl.toString(), {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    redirect: "manual", // we inspect Location ourselves
  });

  let upstream: Response;
  try {
    upstream = await fetch(upstreamRequest, {
      // Caching stays off until the integration is validated end to end.
      // Carts, sessions and pricing must never be served from cache.
      cf: { cacheEverything: false, cacheTtl: 0 },
    });
  } catch {
    return menuUnavailable();
  }

  const responseHeaders = new Headers(upstream.headers);
  for (const name of STRIPPED_RESPONSE_HEADERS) responseHeaders.delete(name);

  const location = upstream.headers.get("Location");
  if (location) {
    responseHeaders.set(
      "Location",
      rewriteLocation(location, upstreamOrigin, env.PUBLIC_HOST),
    );
  }

  const setCookies = upstream.headers.getSetCookie();
  if (setCookies.length > 0) {
    responseHeaders.delete("Set-Cookie");
    for (const cookie of setCookies) {
      responseHeaders.append("Set-Cookie", rewriteSetCookie(cookie));
    }
  }

  return new Response(
    BODYLESS_STATUS.has(upstream.status) ? null : upstream.body,
    {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    },
  );
}

function menuUnavailable(): Response {
  return new Response(
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Menu temporarily unavailable — Hard Hitta Supplies</title>
<style>body{background:#07080B;color:#F4F1EA;font-family:system-ui,sans-serif;
display:grid;place-items:center;min-height:100vh;margin:0;text-align:center;padding:24px}
h1{font-weight:500;letter-spacing:.02em}p{color:#8E93A1;max-width:42ch;line-height:1.7}
a{color:#C9A44C}</style></head><body><div>
<h1>Our menu is taking a moment</h1>
<p>We can't reach the live menu right now. Please try again shortly, or call the shop and we'll take care of you.</p>
<p><a href="/">Return to hardhitta.supplies</a></p>
</div></body></html>`,
    {
      status: 502,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    },
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (isMenuPath(url.pathname)) {
      return proxyToSweed(request, env);
    }

    // Defence in depth. `run_worker_first` should mean we never get here, but
    // if routing config changes, fall back to the site rather than 404.
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
