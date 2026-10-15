import { NextRequest } from "next/server";
import { db, sql } from "@ai-signal/db";
import { config } from "@ai-signal/config";
import crypto from "crypto";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export interface RateLimitOptions {
  /**
   * If true, in production when the distributed database store is unavailable,
   * requests to sensitive endpoints fail closed rather than falling back to per-instance memory.
   */
  failClosed?: boolean;
}

export interface EmailCooldownOptions extends RateLimitOptions {
  /**
   * Action scope prefix to isolate cooldowns across different domains
   * (e.g. 'signup' -> 'signup:email_cooldown', 'gdpr' -> 'gdpr:email_cooldown').
   */
  actionScope?: string;
}

// In-memory fallback stores for unit test suites and offline environments
const rateLimitStore = new Map<string, RateLimitEntry>();
const emailCooldownStore = new Map<string, number>();

// Clean up stale in-memory entries every 5 minutes to prevent memory leak
if (typeof setInterval !== "undefined") {
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of rateLimitStore.entries()) {
      if (entry.resetAt <= now) {
        rateLimitStore.delete(key);
      }
    }
    for (const [email, expiresAt] of emailCooldownStore.entries()) {
      if (expiresAt <= now) {
        emailCooldownStore.delete(email);
      }
    }
  }, 5 * 60 * 1000);

  if (cleanupTimer.unref) {
    cleanupTimer.unref();
  }
}

/**
 * Validates whether an IP address is a syntactically valid IPv4 or IPv6 address.
 * Validates octets 0-255 for IPv4 to reject malformed/spoofed addresses like 999.999.999.999.
 */
export function isValidIpAddress(ip: string): boolean {
  if (!ip || typeof ip !== "string") return false;
  const trimmed = ip.trim();

  // IPv4 validation: 4 octets between 0 and 255 with no leading zeros
  const ipv4Parts = trimmed.split(".");
  if (ipv4Parts.length === 4) {
    return ipv4Parts.every((part) => {
      if (!/^\d{1,3}$/.test(part)) return false;
      const num = Number(part);
      if (num < 0 || num > 255) return false;
      if (part.length > 1 && part.startsWith("0")) return false;
      return true;
    });
  }

  // IPv6 validation
  if (trimmed.includes(":")) {
    const ipv6Regex = /^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$|^(([0-9a-fA-F]{1,4}:){0,6}[0-9a-fA-F]{1,4})?::(([0-9a-fA-F]{1,4}:){0,6}[0-9a-fA-F]{1,4})?$/;
    return ipv6Regex.test(trimmed);
  }

  return false;
}

/**
 * Pseudonymizes sensitive values (e.g. IP addresses, raw emails) into irreversible
 * cryptographic hashes with server secret salting before persisting in database keys.
 * Ensures compliance with GDPR storage limitation and data minimization principles.
 */
export function pseudonymizeRateLimitKey(prefix: string, rawIdentifier: string): string {
  const normalized = rawIdentifier.toLowerCase().trim();
  const salt = config.authSecret || "default-rate-limit-salt";
  const digest = crypto.createHmac("sha256", salt).update(normalized).digest("hex").slice(0, 32);
  return `${prefix}:${digest}`;
}

/**
 * Prunes expired rate limit records from the database to prevent unbounded table growth
 * and avoid retaining historical client rate limit data beyond the rate limit window.
 */
export async function cleanupExpiredRateLimits(): Promise<number> {
  try {
    const result = await db.execute(sql`
      DELETE FROM rate_limits
      WHERE reset_at < NOW() - INTERVAL '10 minutes';
    `);
    return (result as any)?.rowCount || 0;
  } catch {
    return 0;
  }
}

/**
 * Checks whether an IP address belongs to private, loopback, link-local,
 * Carrier-Grade NAT (RFC 6598), or reserved special-purpose ranges (IPv4 & IPv6).
 */
export function isPrivateOrLoopbackIp(ip: string): boolean {
  if (!ip || typeof ip !== "string") return false;
  const trimmed = ip.trim().toLowerCase();
  if (
    trimmed === "127.0.0.1" ||
    trimmed === "::1" ||
    trimmed === "::" ||
    trimmed === "0.0.0.0" ||
    trimmed === "localhost"
  ) {
    return true;
  }

  // Handle IPv4-mapped IPv6 (e.g., ::ffff:192.168.1.1 or 0:0:0:0:0:ffff:10.0.0.1)
  if (trimmed.startsWith("::ffff:") || trimmed.startsWith("0:0:0:0:0:ffff:")) {
    const lastColon = trimmed.lastIndexOf(":");
    const mappedIpv4 = trimmed.slice(lastColon + 1);
    if (mappedIpv4.includes(".")) {
      return isPrivateOrLoopbackIp(mappedIpv4);
    }
  }

  // IPv4 range checks
  const parts = trimmed.split(".").map(Number);
  if (parts.length === 4 && parts.every((p) => !isNaN(p) && p >= 0 && p <= 255)) {
    // 0.0.0.0/8 - Current network (RFC 1122)
    if (parts[0] === 0) return true;
    // 10.0.0.0/8 - Private-use (RFC 1918)
    if (parts[0] === 10) return true;
    // 100.64.0.0/10 - Shared address space / Carrier-Grade NAT (RFC 6598)
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    // 127.0.0.0/8 - Loopback (RFC 1122)
    if (parts[0] === 127) return true;
    // 169.254.0.0/16 - Link-local (RFC 3927)
    if (parts[0] === 169 && parts[1] === 254) return true;
    // 172.16.0.0/12 - Private-use (RFC 1918)
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    // 192.0.0.0/24 - IETF protocol assignments (RFC 6890)
    if (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) return true;
    // 192.168.0.0/16 - Private-use (RFC 1918)
    if (parts[0] === 192 && parts[1] === 168) return true;
    // 198.18.0.0/15 - Benchmarking (RFC 2544)
    if (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) return true;
    // 224.0.0.0/4 - Multicast (RFC 5771)
    if (parts[0] >= 224 && parts[0] <= 239) return true;
    // 240.0.0.0/4 - Reserved for future use / Broadcast (RFC 1112)
    if (parts[0] >= 240) return true;

    return false;
  }

  // IPv6 range checks
  if (trimmed.includes(":")) {
    const firstHextetStr = trimmed.split(":")[0];
    if (firstHextetStr) {
      const firstHextet = parseInt(firstHextetStr, 16);
      if (!isNaN(firstHextet)) {
        // fc00::/7 - Unique Local Addresses (RFC 4193: 0xfc00 through 0xfdff)
        if (firstHextet >= 0xfc00 && firstHextet <= 0xfdff) return true;
        // fe80::/10 - Link-local Unicast (RFC 4291: 0xfe80 through 0xfebf)
        if (firstHextet >= 0xfe80 && firstHextet <= 0xfebf) return true;
        // fec0::/10 - Deprecated Site-local (RFC 3879: 0xfec0 through 0xfeff)
        if (firstHextet >= 0xfec0 && firstHextet <= 0xfeff) return true;
        // ff00::/8 - Multicast (RFC 4291: 0xff00 through 0xffff)
        if (firstHextet >= 0xff00 && firstHextet <= 0xffff) return true;
      }
    }
  }

  return false;
}

/**
 * Evaluates whether an IPv4 address falls within a CIDR subnet block (e.g. 10.0.0.0/8).
 */
export function matchesCidr(ip: string, cidr: string): boolean {
  if (!ip || !cidr) return false;
  const [range, bitsStr] = cidr.split("/");
  const bits = parseInt(bitsStr, 10);
  if (isNaN(bits) || bits < 0 || bits > 32) return false;

  const ipParts = ip.split(".").map(Number);
  const rangeParts = range.split(".").map(Number);
  if (ipParts.length !== 4 || rangeParts.length !== 4) return false;
  if (ipParts.some(isNaN) || rangeParts.some(isNaN)) return false;

  const ipNum = ((ipParts[0] << 24) | (ipParts[1] << 16) | (ipParts[2] << 8) | ipParts[3]) >>> 0;
  const rangeNum = ((rangeParts[0] << 24) | (rangeParts[1] << 16) | (rangeParts[2] << 8) | rangeParts[3]) >>> 0;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;

  return (ipNum & mask) === (rangeNum & mask);
}

/**
 * Checks whether an IP matches any configured trusted proxy IP or CIDR block.
 * Reads TRUSTED_PROXIES env var (comma-separated list of IPs or CIDR blocks).
 * By default, private networks and loopback interfaces are treated as trusted proxy hops.
 */
export function isTrustedProxyHop(ip: string): boolean {
  if (!ip || !isValidIpAddress(ip)) return false;
  const trimmed = ip.trim().toLowerCase();

  const configured = process.env.TRUSTED_PROXIES;
  if (configured) {
    const list = configured.split(",").map((s) => s.trim()).filter(Boolean);
    for (const item of list) {
      if (item.includes("/")) {
        if (matchesCidr(trimmed, item)) return true;
      } else if (item.toLowerCase() === trimmed) {
        return true;
      }
    }
  }

  // Default to private/loopback/link-local networks as trusted reverse proxy infrastructure
  return isPrivateOrLoopbackIp(trimmed);
}

/**
 * Extracts and sanitizes the client IP address from request headers.
 * Uses trusted proxy chain resolution with strict IPv4/IPv6 validation.
 * Traverses X-Forwarded-For from right to left, peeling off trusted proxies
 * to thwart client-injected header spoofing.
 */
export function getClientIp(req: NextRequest): string {
  const trustEdge = process.env.TRUST_EDGE_HEADERS === "true" || process.env.TRUST_EDGE_HEADERS === "1";
  const isProd = process.env.NODE_ENV === "production";

  // 1. Next.js / Edge Runtime socket IP
  const nextIp = (req as any).ip;
  const hasValidNextIp = nextIp && typeof nextIp === "string" && isValidIpAddress(nextIp);
  const isDirectPublicSocket = hasValidNextIp && !isPrivateOrLoopbackIp(nextIp);

  // If connected directly via a public socket that is NOT in the trusted proxy list,
  // edge headers sent by this client are untrusted (client header injection attack)
  if (isDirectPublicSocket && !isTrustedProxyHop(nextIp) && !trustEdge) {
    return nextIp.trim();
  }

  // 2. Cloudflare Edge / CloudFront / Real-IP authoritative headers:
  // Trusted when edge trust is forced, when in dev/test, or when connected via trusted proxy
  const canTrustEdgeHeaders = trustEdge || !isProd || (hasValidNextIp && isTrustedProxyHop(nextIp));

  if (canTrustEdgeHeaders) {
    const cfIp = req.headers.get("cf-connecting-ip")?.trim();
    if (cfIp && isValidIpAddress(cfIp)) {
      return cfIp;
    }

    const cloudFrontIp = req.headers.get("cloudfront-viewer-address")?.split(":")[0]?.trim();
    if (cloudFrontIp && isValidIpAddress(cloudFrontIp)) {
      return cloudFrontIp;
    }

    const realIp = req.headers.get("x-real-ip")?.trim();
    if (realIp && isValidIpAddress(realIp)) {
      return realIp;
    }
  }

  // 3. X-Forwarded-For: Canonical reverse proxy traversal (right-to-left)
  // Walk backwards from the nearest proxy to peel off known trusted proxies.
  // The first untrusted IP encountered is the authoritative client IP.
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const parts = forwarded.split(",").map((s) => s.trim()).filter(Boolean);
    // Walk from right to left, peeling off trusted proxies
    for (let i = parts.length - 1; i >= 0; i--) {
      const candidate = parts[i];
      if (isValidIpAddress(candidate)) {
        // If candidate is a trusted proxy and not the leftmost hop, keep walking left
        if (isTrustedProxyHop(candidate) && i > 0) {
          continue;
        }
        return candidate;
      }
    }
  }

  if (hasValidNextIp) {
    return nextIp.trim();
  }

  return "127.0.0.1";
}

let dbUnavailableUntil = 0;

/**
 * Distributed rate limiter with PostgreSQL atomic persistence and in-memory fallback.
 * Works across multiple serverless / multi-instance nodes concurrently.
 */
export async function checkRateLimit(
  key: string,
  maxRequests: number,
  windowSeconds: number,
  options?: RateLimitOptions
): Promise<{ allowed: boolean; remaining: number; retryAfterSeconds?: number }> {
  const now = Date.now();
  let dbFailed = false;

  if (now >= dbUnavailableUntil) {
    try {
      // Opportunistically prune expired records in the background (roughly once every 50 calls)
      if (Math.random() < 0.02) {
        cleanupExpiredRateLimits().catch(() => {});
      }

      const result = await db.execute<{ count: number; reset_at: Date }>(sql`
        INSERT INTO rate_limits (key, count, reset_at, updated_at)
        VALUES (${key}, 1, NOW() + (${windowSeconds} || ' seconds')::interval, NOW())
        ON CONFLICT (key) DO UPDATE
        SET
          count = CASE
            WHEN rate_limits.reset_at < NOW() THEN 1
            ELSE rate_limits.count + 1
          END,
          reset_at = CASE
            WHEN rate_limits.reset_at < NOW() THEN NOW() + (${windowSeconds} || ' seconds')::interval
            ELSE rate_limits.reset_at
          END,
          updated_at = NOW()
        RETURNING count, reset_at;
      `);

      const row = (result as any)?.[0];
      if (row) {
        const currentCount = Number(row.count);
        const resetTime = new Date(row.reset_at).getTime();
        const retryAfter = Math.max(1, Math.ceil((resetTime - now) / 1000));

        if (currentCount > maxRequests) {
          return { allowed: false, remaining: 0, retryAfterSeconds: retryAfter };
        }
        return { allowed: true, remaining: Math.max(0, maxRequests - currentCount) };
      }
    } catch (err: any) {
      dbFailed = true;
      dbUnavailableUntil = Date.now() + 10_000;
      if (process.env.NODE_ENV === "production") {
        console.error(
          `[RateLimit Critical Alert] Distributed PostgreSQL storage unreachable: ${err.message}. ${
            options?.failClosed ? "Failing closed on sensitive endpoint." : "Falling back to local instance memory."
          }`
        );
      }
    }
  } else {
    dbFailed = true;
  }

  // Sensitive endpoint policy: In production, fail closed if distributed DB is offline
  if (dbFailed && options?.failClosed && process.env.NODE_ENV === "production") {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 30,
    };
  }

  // Fallback: In-memory store (for testing, local dev, or non-critical endpoints)
  const entry = rateLimitStore.get(key);
  if (!entry || entry.resetAt <= now) {
    rateLimitStore.set(key, {
      count: 1,
      resetAt: now + windowSeconds * 1000,
    });
    return { allowed: true, remaining: maxRequests - 1 };
  }

  if (entry.count >= maxRequests) {
    const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    return { allowed: false, remaining: 0, retryAfterSeconds: retryAfter };
  }

  entry.count += 1;
  return { allowed: true, remaining: maxRequests - entry.count };
}

/**
 * Distributed per-email action cooldown (prevents rapid email bombing).
 * Enforces atomic cooldown across all worker/web instances via PostgreSQL.
 * Identifiers are cryptographically pseudonymized before database storage.
 */
export async function checkEmailCooldown(
  email: string,
  cooldownSeconds: number,
  options?: EmailCooldownOptions
): Promise<{ allowed: boolean; retryAfterSeconds?: number }> {
  const normalized = email.toLowerCase().trim();
  const prefix = options?.actionScope ? `${options.actionScope}:email_cooldown` : "email_cooldown";
  const cooldownKey = pseudonymizeRateLimitKey(prefix, normalized);
  const now = Date.now();
  let dbFailed = false;

  if (now >= dbUnavailableUntil) {
    try {
      const result = await db.execute<{ count: number; reset_at: Date }>(sql`
        INSERT INTO rate_limits (key, count, reset_at, updated_at)
        VALUES (${cooldownKey}, 1, NOW() + (${cooldownSeconds} || ' seconds')::interval, NOW())
        ON CONFLICT (key) DO UPDATE
        SET
          count = CASE
            WHEN rate_limits.reset_at < NOW() THEN 1
            ELSE rate_limits.count + 1
          END,
          reset_at = CASE
            WHEN rate_limits.reset_at < NOW() THEN NOW() + (${cooldownSeconds} || ' seconds')::interval
            ELSE rate_limits.reset_at
          END,
          updated_at = NOW()
        RETURNING count, reset_at;
      `);

      const row = (result as any)?.[0];
      if (row) {
        const currentCount = Number(row.count);
        const resetTime = new Date(row.reset_at).getTime();
        const retryAfter = Math.max(1, Math.ceil((resetTime - now) / 1000));

        if (currentCount > 1) {
          return { allowed: false, retryAfterSeconds: retryAfter };
        }
        return { allowed: true };
      }
    } catch (err: any) {
      dbFailed = true;
      dbUnavailableUntil = Date.now() + 10_000;
      if (process.env.NODE_ENV === "production") {
        console.error(
          `[EmailCooldown Critical Alert] DB unavailable: ${err.message}. ${
            options?.failClosed ? "Failing closed." : "Falling back to local memory."
          }`
        );
      }
    }
  } else {
    dbFailed = true;
  }

  if (dbFailed && options?.failClosed && process.env.NODE_ENV === "production") {
    return {
      allowed: false,
      retryAfterSeconds: 30,
    };
  }

  // Fallback: In-memory store
  const expiresAt = emailCooldownStore.get(cooldownKey);
  if (expiresAt && expiresAt > now) {
    const retryAfter = Math.max(1, Math.ceil((expiresAt - now) / 1000));
    return { allowed: false, retryAfterSeconds: retryAfter };
  }

  emailCooldownStore.set(cooldownKey, now + cooldownSeconds * 1000);
  return { allowed: true };
}
