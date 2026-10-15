import { NextRequest, NextResponse } from "next/server";
import { db, subscribers, eq } from "@ai-signal/db";
import { normalizeEmail, generateSignedToken, config, TokenPurpose } from "@ai-signal/config";
import { getEmailProvider } from "@ai-signal/email";
import { checkRateLimit, checkEmailCooldown, getClientIp, pseudonymizeRateLimitKey } from "@/lib/rateLimit";

const MAX_BODY_BYTES = 16384; // 16KB

export async function POST(req: NextRequest) {
  try {
    let body: any;
    if (typeof req.text === "function") {
      const rawBody = await req.text();
      if (rawBody.length > MAX_BODY_BYTES) {
        return NextResponse.json({ error: "Payload too large. Maximum size is 16KB." }, { status: 413 });
      }
      try {
        body = JSON.parse(rawBody);
      } catch {
        return NextResponse.json({ error: "Malformed JSON payload" }, { status: 400 });
      }
    } else if (typeof req.json === "function") {
      body = await req.json();
    } else {
      return NextResponse.json({ error: "Invalid request payload" }, { status: 400 });
    }

    const { email, purpose } = body;

    if (!email || typeof email !== "string") {
      return NextResponse.json({ error: "A valid email address is required" }, { status: 400 });
    }

    if (purpose !== "data_export" && purpose !== "data_delete") {
      return NextResponse.json(
        { error: "Invalid purpose. Must be 'data_export' or 'data_delete'" },
        { status: 400 }
      );
    }

    const clientIp = getClientIp(req);
    const normalized = normalizeEmail(email);

    // 1. Rate limiting by IP (max 5 privacy requests per 15 minutes per IP) with failClosed policy
    const ipRateLimit = await checkRateLimit(
      pseudonymizeRateLimitKey("gdpr:ip", clientIp),
      5,
      900,
      { failClosed: true }
    );
    if (!ipRateLimit.allowed) {
      return NextResponse.json(
        { error: "Too many privacy requests. Please wait a few minutes before trying again." },
        { status: 429, headers: { "Retry-After": String(ipRateLimit.retryAfterSeconds || 60) } }
      );
    }

    // 2. Cooldown per email address (max 1 request per 10 minutes per email to avoid email bombing) with failClosed policy
    const emailCooldown = await checkEmailCooldown(normalized, 600, { failClosed: true, actionScope: "gdpr" });
    if (!emailCooldown.allowed) {
      // Privacy-preserving response: Do not leak whether the account exists or failed cooldown
      return NextResponse.json({
        success: true,
        message:
          "If an account is associated with this email, a verification link has been sent to your inbox.",
      });
    }

    // Look up subscriber
    const [sub] = await db
      .select({ id: subscribers.id, email: subscribers.email })
      .from(subscribers)
      .where(eq(subscribers.email, normalized));

    // Privacy-preserving response: Do not leak whether the subscriber exists
    if (!sub) {
      return NextResponse.json({
        success: true,
        message:
          "If an account is associated with this email, a verification link has been sent to your inbox.",
      });
    }

    // Generate signed token with 2-hour expiration
    const token = generateSignedToken(
      {
        id: sub.id,
        email: sub.email,
        purpose: purpose as TokenPurpose,
      },
      7200 // 2 hours
    );

    const provider = getEmailProvider();
    const isExport = purpose === "data_export";
    const actionUrl = isExport
      ? `${config.appUrl}/api/subscriber/gdpr?token=${token}`
      : `${config.appUrl}/privacy?action=delete&token=${token}`;

    const emailSubject = isExport
      ? "AI Signal: Your GDPR Personal Data Archive"
      : "AI Signal: Confirm Personal Data Deletion Request";

    const emailHtml = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 20px; background: #0b0f19; color: #f8fafc; border-radius: 12px;">
        <h2 style="margin: 0 0 16px 0; color: #6366f1;">AI Signal Privacy Request</h2>
        <p style="color: #cbd5e1; font-size: 15px; line-height: 1.6;">
          We received a verified request to <strong>${isExport ? "export your personal data archive" : "permanently delete your subscriber record"}</strong>.
        </p>
        <div style="margin: 28px 0;">
          <a href="${actionUrl}" style="background: #6366f1; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-weight: 600; font-size: 14px; display: inline-block;">
            ${isExport ? "Download Data Archive" : "Confirm Data Deletion"}
          </a>
        </div>
        <p style="color: #64748b; font-size: 13px; line-height: 1.5;">
          This link will expire in 2 hours. If you did not make this request, you can safely ignore this email.
        </p>
      </div>
    `.trim();

    const emailText = `AI Signal Privacy Request\n\nWe received a verified request to ${
      isExport ? "export your personal data archive" : "permanently delete your subscriber record"
    }.\n\nClick the link below:\n${actionUrl}\n\nThis link expires in 2 hours.`;

    const sendResult = await provider.sendEmail({
      to: sub.email,
      subject: emailSubject,
      html: emailHtml,
      text: emailText,
    });

    if (!sendResult.success) {
      console.error(
        `[GDPR Request Error] Verification email dispatch failed for subscriber ${sub.id}: ${sendResult.error}`
      );
      return NextResponse.json(
        { error: "Unable to dispatch verification email. Please try again later." },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      message:
        "If an account is associated with this email, a verification link has been sent to your inbox.",
    });
  } catch (err: any) {
    console.error("[GDPR Request Error]:", err.message);
    return NextResponse.json(
      { error: "Failed to process privacy request" },
      { status: 500 }
    );
  }
}
