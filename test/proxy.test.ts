import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";

const UPSTREAM = "https://web-ui-prime.sweedpos.com";
const SITE = "https://hardhitta.supplies";
const PREFIX = "/hardhittasupplyco";

const testEnv = env as unknown as Env;

afterEach(() => vi.restoreAllMocks());

/**
 * Stub the global fetch so no test touches the network, and capture the exact
 * Request the Worker hands to the upstream.
 */
function stubUpstream(
  response: Response = new Response("<html>sweed menu</html>", {
    headers: { "content-type": "text/html" },
  }),
) {
  const calls: Request[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Request(input as RequestInfo, init));
      return response;
    },
  );
  return calls;
}

/** Drive the Worker directly so we exercise the handler, not just routing. */
const call = (path: string, init?: RequestInit) =>
  worker.fetch(new Request(`${SITE}${path}`, init), testEnv);

describe("route matching", () => {
  it("proxies the exact menu path", async () => {
    const calls = stubUpstream();
    const res = await call(PREFIX);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${UPSTREAM}${PREFIX}`);
  });

  it("proxies a nested menu path", async () => {
    const calls = stubUpstream();
    await call(`${PREFIX}/menu/item`);
    expect(calls[0].url).toBe(`${UPSTREAM}${PREFIX}/menu/item`);
  });

  it("preserves a trailing slash", async () => {
    const calls = stubUpstream();
    await call(`${PREFIX}/`);
    expect(calls[0].url).toBe(`${UPSTREAM}${PREFIX}/`);
  });

  it("preserves path and query exactly (Sweed's example)", async () => {
    const calls = stubUpstream();
    await call(`${PREFIX}/menu/item?id=5`);
    expect(calls[0].url).toBe(`${UPSTREAM}${PREFIX}/menu/item?id=5`);
  });

  it("preserves multiple and encoded query parameters", async () => {
    const calls = stubUpstream();
    await call(`${PREFIX}/search?q=blue%20dream&sort=price&page=2`);
    expect(calls[0].url).toBe(
      `${UPSTREAM}${PREFIX}/search?q=blue%20dream&sort=price&page=2`,
    );
  });
});

describe("open proxy protection", () => {
  it("does not proxy a lookalike prefix", async () => {
    const calls = stubUpstream();
    await call("/hardhittasupplyco-evil/path");
    expect(calls).toHaveLength(0);
  });

  it("does not proxy an unrelated route", async () => {
    const calls = stubUpstream();
    await call("/about");
    expect(calls).toHaveLength(0);
  });

  it("always targets the fixed Sweed origin, whatever the query says", async () => {
    const calls = stubUpstream();
    await call(`${PREFIX}?next=https://evil.example.com`);
    expect(new URL(calls[0].url).origin).toBe(UPSTREAM);
  });

  it("serves the static site at the root", async () => {
    const res = await SELF.fetch(`${SITE}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Hard Hitta");
  });
});

describe("forwarded headers", () => {
  it("sends X-Forwarded-Host and X-Forwarded-Proto", async () => {
    const calls = stubUpstream();
    await call(PREFIX);
    expect(calls[0].headers.get("x-forwarded-host")).toBe(
      "hardhitta.supplies",
    );
    expect(calls[0].headers.get("x-forwarded-proto")).toBe("https");
  });

  it("overrides a client-supplied X-Forwarded-Host", async () => {
    const calls = stubUpstream();
    await call(PREFIX, {
      headers: {
        "X-Forwarded-Host": "attacker.example.com",
        "X-Forwarded-Proto": "http",
      },
    });
    expect(calls[0].headers.get("x-forwarded-host")).toBe(
      "hardhitta.supplies",
    );
    expect(calls[0].headers.get("x-forwarded-proto")).toBe("https");
  });

  it("drops a client-supplied Forwarded header", async () => {
    const calls = stubUpstream();
    await call(PREFIX, { headers: { Forwarded: "host=attacker.example.com" } });
    expect(calls[0].headers.get("forwarded")).toBeNull();
  });

  it("forwards cookies so cart and session survive", async () => {
    const calls = stubUpstream();
    await call(PREFIX, { headers: { Cookie: "sweed_session=abc123" } });
    expect(calls[0].headers.get("cookie")).toBe("sweed_session=abc123");
  });
});

describe("methods and bodies", () => {
  it("forwards a POST body unchanged", async () => {
    const calls = stubUpstream();
    const payload = JSON.stringify({ sku: "ABC", qty: 2 });
    const res = await call(`${PREFIX}/api/cart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });
    expect(res.status).toBe(200);
    expect(calls[0].method).toBe("POST");
    expect(await calls[0].text()).toBe(payload);
  });

  it("sends no body for GET", async () => {
    const calls = stubUpstream();
    await call(PREFIX);
    expect(calls[0].body).toBeNull();
  });
});

describe("response handling", () => {
  it("rewrites a Location header pointing back at Sweed", async () => {
    stubUpstream(
      new Response(null, {
        status: 302,
        headers: { location: `${UPSTREAM}${PREFIX}/menu` },
      }),
    );
    const res = await call(PREFIX);
    expect(res.headers.get("location")).toBe(
      `https://hardhitta.supplies${PREFIX}/menu`,
    );
  });

  it("leaves an external redirect untouched", async () => {
    stubUpstream(
      new Response(null, {
        status: 302,
        headers: { location: "https://checkout.stripe.com/pay/xyz" },
      }),
    );
    const res = await call(PREFIX);
    expect(res.headers.get("location")).toBe(
      "https://checkout.stripe.com/pay/xyz",
    );
  });

  it("strips Set-Cookie Domain but keeps the security flags", async () => {
    stubUpstream(
      new Response("ok", {
        headers: {
          "set-cookie":
            "sid=xyz; Domain=web-ui-prime.sweedpos.com; Path=/; Secure; HttpOnly; SameSite=Lax",
        },
      }),
    );
    const res = await call(PREFIX);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).not.toMatch(/domain=/i);
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("passes upstream status codes through", async () => {
    stubUpstream(new Response("nope", { status: 404 }));
    const res = await call(`${PREFIX}/missing`);
    expect(res.status).toBe(404);
  });

  it("passes the real Sweed 'store not found' body through unchanged", async () => {
    stubUpstream(
      new Response("<h1>Store is not found</h1>", {
        status: 404,
        headers: { "content-type": "text/html" },
      }),
    );
    const res = await call(PREFIX);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("Store is not found");
  });

  it("returns a friendly 502 when the upstream is unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("connection refused"),
    );
    const res = await call(PREFIX);
    expect(res.status).toBe(502);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toContain("Our menu is taking a moment");
  });
});
