import { describe, it, expect } from "bun:test";
import { POST } from "../../apps/web/src/app/api/admin/auth/route";
import { config } from "../../packages/config/src/index";

describe("Admin Authentication Security, Distributed Rate Limiting & CSRF", () => {
  it("rejects oversized request payloads with HTTP 413", async () => {
    const req = {
      headers: new Headers({
        "content-length": "5000", // > 2KB limit
        "content-type": "application/json",
      }),
      json: async () => ({ password: "a".repeat(4500) }),
    } as any;

    const res = await POST(req);
    expect(res.status).toBe(413);

    const data = await res.json();
    expect(data.error).toBe("Payload too large");
  });

  it("rejects cross-origin authentication requests with HTTP 403", async () => {
    const req = {
      headers: new Headers({
        origin: "https://evil-attacker-site.com",
        host: "localhost:3000",
        "content-type": "application/json",
      }),
      json: async () => ({ password: config.adminPassword }),
    } as any;

    const res = await POST(req);
    expect(res.status).toBe(403);

    const data = await res.json();
    expect(data.error).toContain("Cross-origin authentication requests are disallowed");
  });

  it("accepts same-origin requests matching appUrl or Host header", async () => {
    const req = {
      headers: new Headers({
        origin: "http://localhost:3000",
        host: "localhost:3000",
        "content-type": "application/json",
      }),
      json: async () => ({ password: config.adminPassword }),
    } as any;

    const res = await POST(req);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it("rejects incorrect admin password with HTTP 401", async () => {
    const req = {
      headers: new Headers({
        "x-forwarded-for": "198.51.100.5",
        "content-type": "application/json",
      }),
      json: async () => ({ password: "wrong-password-guess" }),
    } as any;

    const res = await POST(req);
    expect(res.status).toBe(401);

    const data = await res.json();
    expect(data.error).toBe("Invalid admin credentials");
  });

  it("enforces brute-force lockout after 5 consecutive failed attempts", async () => {
    const testIp = "203.0.113.99";

    // 5 failed login attempts
    for (let i = 0; i < 5; i++) {
      const failReq = {
        headers: new Headers({
          "x-forwarded-for": testIp,
          "content-type": "application/json",
        }),
        json: async () => ({ password: `wrong-${i}` }),
      } as any;

      await POST(failReq);
    }

    // 6th attempt should be blocked with 429
    const blockedReq = {
      headers: new Headers({
        "x-forwarded-for": testIp,
        "content-type": "application/json",
      }),
      json: async () => ({ password: config.adminPassword }), // Even with right password!
    } as any;

    const blockedRes = await POST(blockedReq);
    expect(blockedRes.status).toBe(429);

    const data = await blockedRes.json();
    expect(data.error).toContain("Too many failed login attempts");
    expect(blockedRes.headers.get("Retry-After")).not.toBeNull();
  });
});
