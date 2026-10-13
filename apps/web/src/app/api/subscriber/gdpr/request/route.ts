import { NextRequest, NextResponse } from "next/server";
import { db, subscribers, eq } from "@ai-signal/db";
import { normalizeEmail, generateSignedToken, config, TokenPurpose } from "@ai-signal/config";
import { getEmailProvider } from "@ai-signal/email";

export async function POST(req: NextRequest) {
  try {
    const { email, purpose } = await req.json();

    if (!email || typeof email !== "string") {
      return NextResponse.json({ error: "A valid email address is required" }, { status: 400 });
    }

    if (purpose !== "data_export" && purpose !== "data_delete") {
      return NextResponse.json(
        { error: "Invalid purpose. Must be 'data_export' or 'data_delete'" },
        { status: 400 }
      );
    }

    const normalized = normalizeEmail(email);

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
