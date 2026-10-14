import { NextRequest } from "next/server";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const rateLimitStore = new Map<string, RateLimitEntry>();
const emailCooldownStore = new Map<string, number>();

// Clean up stale entries every 5 minutes to prevent memory leak
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
 * Extracts and sanitizes the client IP address from request headers.
 */
export function getClientIp(req: NextRequest): string {
  // 1. Next.js / Edge Runtime client IP
  const nextIp = (req as any).ip;
  if (nextIp && typeof nextIp === "string" && nextIp.trim()) {
    return nextIp.trim();
  }

  // 2. Cloudflare trusted header
  const cfIp = req.headers.get("cf-connecting-ip");
  if (cfIp && typeof cfIp === "string" && cfIp.trim()) {
    return cfIp.trim();
  }

  // 3. X-Real-IP
  const realIp = req.headers.get("x-real-ip");
  if (realIp && typeof realIp === "string" && realIp.trim()) {
    return realIp.trim();
  }

  // 4. Standard X-Forwarded-For (client is leftmost entry)
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const firstIp = forwarded.split(",")[0]?.trim();
    if (firstIp && /^[0-9a-fA-F:.]+$/.test(firstIp)) {
      return firstIp;
    }
  }

  return "127.0.0.1";
}

/**
 * In-memory sliding window rate limiter
 */
export function checkRateLimit(
  key: string,
  maxRequests: number,
  windowSeconds: number
): { allowed: boolean; remaining: number; retryAfterSeconds?: number } {
  const now = Date.now();
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
 * Check and enforce per-email action cooldown (prevents rapid email bombing)
 */
export function checkEmailCooldown(
  email: string,
  cooldownSeconds: number
): { allowed: boolean; retryAfterSeconds?: number } {
  const now = Date.now();
  const key = email.toLowerCase().trim();
  const expiresAt = emailCooldownStore.get(key);

  if (expiresAt && expiresAt > now) {
    const retryAfter = Math.max(1, Math.ceil((expiresAt - now) / 1000));
    return { allowed: false, retryAfterSeconds: retryAfter };
  }

  emailCooldownStore.set(key, now + cooldownSeconds * 1000);
  return { allowed: true };
}
