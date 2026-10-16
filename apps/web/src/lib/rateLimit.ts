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
    return (result as any)?.rowCount ?? (result as any)?.count ?? 0;
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
 * Normalizes and converts an IPv6 string into a 128-bit BigInt.
 * Supports standard notation, compressed '::' notation, and IPv4-mapped IPv6.
 */
export function parseIpv6(ip: string): bigint | null {
  if (!ip || typeof ip !== "string") return null;
  let normalized = ip.trim().toLowerCase();

  // Handle IPv4-mapped IPv6 (e.g. ::ffff:192.0.2.1)
  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");
    if (lastColon === -1) return null;
    const ipv4Part = normalized.slice(lastColon + 1);
    const ipv4Parts = ipv4Part.split(".").map(Number);
    if (ipv4Parts.length !== 4 || ipv4Parts.some((p) => isNaN(p) || p < 0 || p > 255)) return null;
    const hex1 = ((ipv4Parts[0] << 8) | ipv4Parts[1]).toString(16);
    const hex2 = ((ipv4Parts[2] << 8) | ipv4Parts[3]).toString(16);
    normalized = normalized.slice(0, lastColon + 1) + hex1 + ":" + hex2;
  }

  const parts = normalized.split("::");
  if (parts.length > 2) return null;

  let words: number[] = [];
  if (parts.length === 2) {
    const left = parts[0] ? parts[0].split(":").map((w) => parseInt(w, 16)) : [];
    const right = parts[1] ? parts[1].split(":").map((w) => parseInt(w, 16)) : [];
    if (left.some(isNaN) || right.some(isNaN)) return null;
    const missing = 8 - (left.length + right.length);
    if (missing < 0) return null;
    words = [...left, ...new Array(missing).fill(0), ...right];
  } else {
    words = parts[0].split(":").map((w) => parseInt(w, 16));
    if (words.length !== 8 || words.some(isNaN)) return null;
  }

  let result = 0n;
  for (const word of words) {
    if (word < 0 || word > 0xffff) return null;
    result = (result << 16n) | BigInt(word);
  }
  return result;
}

/**
 * Evaluates whether an IPv4 or IPv6 address falls within a CIDR subnet block
 * (e.g. 10.0.0.0/8, 192.168.1.0/24, 2001:db8::/32, fc00::/7, fe80::/10).
 */
export function matchesCidr(ip: string, cidr: string): boolean {
  if (!ip || !cidr) return false;
  const [range, bitsStr] = cidr.split("/");
  if (!range || !bitsStr) return false;
  const bits = parseInt(bitsStr, 10);
  if (isNaN(bits) || bits < 0) return false;

  const isIpV6 = ip.includes(":") || range.includes(":");
  if (isIpV6) {
    if (bits > 128) return false;
    const ipBig = parseIpv6(ip);
    const rangeBig = parseIpv6(range);
    if (ipBig === null || rangeBig === null) return false;
    if (bits === 0) return true;
    const shift = BigInt(128 - bits);
    return (ipBig >> shift) === (rangeBig >> shift);
  }

  if (bits > 32) return false;
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
 *
 * SECURITY RULES:
 * 1. For direct network sockets (options.isHeaderHop = false), loopback interfaces (127.0.0.1, ::1)
 *    represent legitimate local reverse proxies (Nginx, Envoy) running on the same host.
 * 2. For hops extracted from request headers (options.isHeaderHop = true), in production loopback
 *    addresses (127.0.0.1, ::1) are NOT automatically trusted unless explicitly declared in
 *    TRUSTED_PROXIES. This prevents attackers from spoofing identities with "X-Forwarded-For: 9.9.9.9, 127.0.0.1".
 * 3. When TRUSTED_PROXIES is configured, explicit list matching always takes precedence.
 * 4. In development and test environments, loopback and private networks are allowed for convenience.
 */
export function isTrustedProxyHop(ip: string, options: { isHeaderHop?: boolean } = {}): boolean {
  if (!ip || !isValidIpAddress(ip)) return false;
  const trimmed = ip.trim().toLowerCase();
  const isProd = process.env.NODE_ENV === "production";
  const isLoopback = trimmed === "127.0.0.1" || trimmed === "::1";

  // Check explicit TRUSTED_PROXIES configuration first:
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

    // When TRUSTED_PROXIES is explicitly configured, ONLY listed IPs/subnets are trusted.
    // Socket loopback (127.0.0.1, ::1) is still trusted for local reverse proxy sockets,
    // but header loopback hops MUST NOT be trusted unless explicitly in the allowlist.
    if (isLoopback && !options.isHeaderHop) {
      return true;
    }

    return false;
  }

  // In production without TRUSTED_PROXIES, header hops (including loopback 127.0.0.1 and ::1)
  // MUST NOT be automatically trusted.
  if (isProd && options.isHeaderHop) {
    return false;
  }

  // Socket loopback (127.0.0.1, ::1) or dev/test header hops without explicit TRUSTED_PROXIES
  if (isLoopback) {
    return true;
  }

  // In production without matching TRUSTED_PROXIES, unlisted IPs are not trusted
  if (isProd) {
    return false;
  }

  // In development and test environments without explicit TRUSTED_PROXIES, allow private networks
  return isPrivateOrLoopbackIp(trimmed);
}

/**
 * Safely parses the client IP address from the CloudFront-Viewer-Address header.
 * AWS CloudFront formats this header as:
 * - IPv4: `<ip>:<port>` (e.g. `198.51.100.10:46532`)
 * - IPv6: `<ip>:<port>` (e.g. `2001:db8:85a3:8d3:1319:8a2e:370:7348:46532` or `[2001:db8:...]:46532`)
 * Robustly parses IPv6 addresses with multiple colons without mistaking address segments for port delimiters.
 */
export function parseCloudFrontViewerAddress(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // 1. Bracketed IPv6 format: "[2001:db8:...]:port" or "[2001:db8:...]"
  if (trimmed.startsWith("[")) {
    const closeBracketIdx = trimmed.indexOf("]");
    if (closeBracketIdx > 1) {
      const candidate = trimmed.substring(1, closeBracketIdx).trim();
      if (isValidIpAddress(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  // 2. Address with trailing port:
  // Since CloudFront-Viewer-Address is specified by AWS to include "<ip>:<port>",
  // we first check for a valid trailing port (1 - 65535) delimited by the LAST colon.
  // This correctly disambiguates compressed IPv6 addresses (e.g. "2001:db8::1:8080" where
  // 8080 is an ephemeral port, not an 8th hextet).
  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon > 0) {
    const candidateIp = trimmed.substring(0, lastColon).trim();
    const candidatePort = trimmed.substring(lastColon + 1).trim();

    // Verify candidate port is a valid decimal port (1 - 65535)
    if (/^\d{1,5}$/.test(candidatePort)) {
      const portNum = Number(candidatePort);
      if (portNum >= 1 && portNum <= 65535 && isValidIpAddress(candidateIp)) {
        return candidateIp;
      }
    }
  }

  // 3. Direct valid IP (if port was already stripped or omitted)
  if (isValidIpAddress(trimmed)) {
    return trimmed;
  }

  return null;
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
  if (isDirectPublicSocket && !isTrustedProxyHop(nextIp, { isHeaderHop: false }) && !trustEdge) {
    return nextIp.trim();
  }

  // 2. Provider-Specific Authoritative Edge Headers:
  // Each hosting platform defines which header is guaranteed by its infrastructure:
  // - Vercel: Vercel edge guarantees `x-vercel-forwarded-for` and prepends the client IP to `x-forwarded-for`.
  //   Client-supplied `cf-connecting-ip` or `cloudfront-viewer-address` are NOT authoritative on Vercel unless
  //   explicitly configured via TRUST_CLOUDFLARE=true or TRUST_EDGE_HEADERS=true.
  // - Cloudflare Pages / Workers: Cloudflare edge guarantees `cf-connecting-ip`.
  // - AWS / CloudFront: `cloudfront-viewer-address` is authoritative when TRUST_CLOUDFRONT=true or TRUST_EDGE_HEADERS=true.
  // - In development and test (!isProd) or when TRUST_EDGE_HEADERS=true, standard edge headers are supported.
  const isVercel = process.env.VERCEL === "1" || process.env.VERCEL === "true";
  const isCloudflare =
    process.env.CF_PAGES === "1" ||
    process.env.TRUST_CLOUDFLARE === "true" ||
    process.env.TRUST_CLOUDFLARE === "1";
  const isCloudFront =
    process.env.TRUST_CLOUDFRONT === "true" ||
    process.env.TRUST_CLOUDFRONT === "1" ||
    (Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME) &&
      (process.env.TRUST_CLOUDFRONT === "true" || process.env.TRUST_CLOUDFRONT === "1"));

  // On Vercel: check Vercel's authoritative header first
  if (isVercel) {
    const vercelIp = req.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim();
    if (vercelIp && isValidIpAddress(vercelIp)) {
      return vercelIp;
    }
  }

  // Cloudflare authoritative header:
  if (isCloudflare || trustEdge || (!isProd && !isVercel)) {
    const cfIp = req.headers.get("cf-connecting-ip")?.trim();
    if (cfIp && isValidIpAddress(cfIp)) {
      return cfIp;
    }
  }

  // CloudFront authoritative header (handles IPv4:port, IPv6:port, and bracketed IPv6:port):
  if (isCloudFront || trustEdge || (!isProd && !isVercel)) {
    const cloudFrontIp = parseCloudFrontViewerAddress(req.headers.get("cloudfront-viewer-address"));
    if (cloudFrontIp) {
      return cloudFrontIp;
    }
  }

  // Edge real-ip header:
  // When running behind CloudFront, x-real-ip is NOT trusted unless trustEdge is explicitly enabled,
  // because CloudFront does not set x-real-ip authoritatively and client-injected headers must be rejected.
  const canTrustEdgeHeaders =
    trustEdge ||
    !isProd ||
    isVercel ||
    isCloudflare ||
    (hasValidNextIp && isTrustedProxyHop(nextIp, { isHeaderHop: false }));

  if (canTrustEdgeHeaders && !isCloudFront) {
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

    // In production without explicit edge trust or verified trusted socket proxy:
    // If the immediate rightmost proxy hop is untrusted, an external client could be directly connecting
    // to the origin and forging arbitrary X-Forwarded-For headers to bypass rate limits.
    // Reject untrusted proxy chains to prevent header spoofing.
    if (isProd && !canTrustEdgeHeaders) {
      const nearestHop = parts[parts.length - 1];
      if (!nearestHop || !isValidIpAddress(nearestHop) || !isTrustedProxyHop(nearestHop, { isHeaderHop: true })) {
        if (hasValidNextIp) {
          return nextIp.trim();
        }
        console.warn(
          `[RateLimit Security] Untrusted proxy chain or unverified headers in production (nearest hop: '${nearestHop || "none"}'). Falling back to safe default '127.0.0.1'. Please configure TRUSTED_PROXIES or set TRUST_EDGE_HEADERS=true for your hosting environment.`
        );
        return "127.0.0.1";
      }
    }

    // Walk from right to left, peeling off trusted proxies
    for (let i = parts.length - 1; i >= 0; i--) {
      const candidate = parts[i];
      if (isValidIpAddress(candidate)) {
        // If candidate is a trusted proxy and not the leftmost hop, keep walking left
        if (isTrustedProxyHop(candidate, { isHeaderHop: true }) && i > 0) {
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
