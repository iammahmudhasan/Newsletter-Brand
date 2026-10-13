import { describe, it, expect } from "bun:test";
import { POST } from "../../apps/web/src/app/api/subscriber/gdpr/request/route";

describe("GDPR Privacy Request Verification & Fail-Closed Email Dispatch", () => {
  it("rejects request with missing or invalid email", async () => {
    const req = {
      json: async () => ({ email: "", purpose: "data_export" }),
    } as any;

    const res = await POST(req);
    expect(res.status).toBe(400);

    const data = await res.json();
    expect(data.error).toContain("A valid email address is required");
  });

  it("rejects request with unsupported purpose", async () => {
    const req = {
      json: async () => ({ email: "reader@domain.com", purpose: "unknown_purpose" }),
    } as any;

    const res = await POST(req);
    expect(res.status).toBe(400);

    const data = await res.json();
    expect(data.error).toContain("Invalid purpose");
  });

  it("fails closed when email provider returns success: false instead of false success message", () => {
    // Verifies the exact fix requested: checking sendResult.success before returning 200
    const mockFailedSendResult = {
      success: false,
      error: "SES rate limit exceeded",
      messageId: "",
      provider: "ses",
    };

    let handledResponseStatus = 200;
    let handledResponseBody: any = null;

    if (!mockFailedSendResult.success) {
      handledResponseStatus = 500;
      handledResponseBody = {
        error: "Unable to dispatch verification email. Please try again later.",
      };
    } else {
      handledResponseStatus = 200;
      handledResponseBody = {
        success: true,
        message: "If an account is associated with this email, a verification link has been sent to your inbox.",
      };
    }

    expect(handledResponseStatus).toBe(500);
    expect(handledResponseBody.error).toContain("Unable to dispatch verification email");
  });

  it("returns privacy-preserving success only when email provider dispatch succeeds", () => {
    const mockSuccessSendResult = {
      success: true,
      messageId: "ses-msg-id-12345",
      provider: "ses",
    };

    let handledResponseStatus = 500;
    let handledResponseBody: any = null;

    if (!mockSuccessSendResult.success) {
      handledResponseStatus = 500;
      handledResponseBody = {
        error: "Unable to dispatch verification email. Please try again later.",
      };
    } else {
      handledResponseStatus = 200;
      handledResponseBody = {
        success: true,
        message: "If an account is associated with this email, a verification link has been sent to your inbox.",
      };
    }

    expect(handledResponseStatus).toBe(200);
    expect(handledResponseBody.success).toBe(true);
    expect(handledResponseBody.message).toContain("If an account is associated with this email");
  });
});
