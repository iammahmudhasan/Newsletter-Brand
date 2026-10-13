import { NextRequest, NextResponse } from "next/server";
import {
  createAdminSessionToken,
  verifyAdminPassword,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
} from "@/lib/auth";

// In-memory rate limiting map: ip -> { count, resetAt }
interface RateLimitRecord {
  attempts: number;
  resetAt: number;
}
const loginRateLimits = new Map<string, RateLimitRecord>();

const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

function checkRateLimit(ip: string): { allowed: boolean; retryAfterSeconds?: number } {
  const now = Date.now();
  const record = loginRateLimits.get(ip);

  if (!record || now > record.resetAt) {
    return { allowed: true };
  }

  if (record.attempts >= MAX_LOGIN_ATTEMPTS) {
    const retryAfter = Math.ceil((record.resetAt - now) / 1000);
    return { allowed: false, retryAfterSeconds: retryAfter };
  }

  return { allowed: true };
}

function recordFailedAttempt(ip: string): void {
  const now = Date.now();
  const record = loginRateLimits.get(ip);

  if (!record || now > record.resetAt) {
    loginRateLimits.set(ip, {
      attempts: 1,
      resetAt: now + LOCKOUT_WINDOW_MS,
    });
  } else {
    record.attempts += 1;
  }
}

function resetRateLimit(ip: string): void {
  loginRateLimits.delete(ip);
}

export async function POST(req: NextRequest) {
  try {
    const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || 
                     req.headers.get("x-real-ip") || 
                     "127.0.0.1";

    // Rate limit check
    const rateLimit = checkRateLimit(clientIp);
    if (!rateLimit.allowed) {
      return NextResponse.json(
        {
          error: `Too many failed login attempts. Please try again in ${rateLimit.retryAfterSeconds} seconds.`,
        },
        {
          status: 429,
          headers: {
            "Retry-After": String(rateLimit.retryAfterSeconds || 60),
          },
        }
      );
    }

    const { password } = await req.json();

    if (!password || !verifyAdminPassword(password)) {
      recordFailedAttempt(clientIp);
      return NextResponse.json({ error: "Invalid admin credentials" }, { status: 401 });
    }

    // Success: clear rate limit record
    resetRateLimit(clientIp);

    const token = createAdminSessionToken();
    const res = NextResponse.json({
      success: true,
      message: "Admin authenticated successfully",
    });

    res.cookies.set({
      name: SESSION_COOKIE_NAME,
      value: token,
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: SESSION_MAX_AGE_SECONDS,
      path: "/",
    });

    return res;
  } catch (err: any) {
    return NextResponse.json({ error: "Authentication processing error" }, { status: 500 });
  }
}

export async function DELETE() {
  const res = NextResponse.json({ success: true, message: "Logged out" });
  res.cookies.delete(SESSION_COOKIE_NAME);
  return res;
}
