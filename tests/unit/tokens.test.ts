import { describe, it, expect } from "bun:test";
import {
  generateSignedToken,
  verifySignedToken,
  normalizeEmail,
  hashIp,
} from "../../packages/config/src/index";

describe("Token Cryptography, Purpose Enforcement & Normalization", () => {
  it("normalizes mixed-case and whitespace-padded emails", () => {
    const raw = "  Alex.ML+tester@Domain.COM  ";
    expect(normalizeEmail(raw)).toBe("alex.ml+tester@domain.com");
  });

  it("hashes IP addresses deterministically with auth secret salting", () => {
    const hash1 = hashIp("192.168.1.100");
    const hash2 = hashIp("192.168.1.100");
    const hash3 = hashIp("10.0.0.1");

    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(hash3);
    expect(hashIp(undefined)).toBe("unknown");
  });

  it("verifies a valid signed token when expected purpose matches", () => {
    const payload = {
      id: "sub_test_99",
      email: "engineer@domain.com",
      purpose: "confirm" as const,
    };
    const token = generateSignedToken(payload, 3600);
    const result = verifySignedToken(token, "confirm");

    expect(result.valid).toBe(true);
    expect(result.payload?.id).toBe("sub_test_99");
    expect(result.payload?.email).toBe("engineer@domain.com");
    expect(result.payload?.purpose).toBe("confirm");
  });

  it("strictly rejects a valid token when expected purpose mismatches", () => {
    const confirmToken = generateSignedToken(
      {
        id: "sub_test_99",
        email: "engineer@domain.com",
        purpose: "confirm",
      },
      3600
    );

    // Attempt to misuse confirmation token on unsubscribe or GDPR endpoint
    const unsubResult = verifySignedToken(confirmToken, "unsubscribe");
    expect(unsubResult.valid).toBe(false);
    expect(unsubResult.error).toContain("Invalid token purpose");

    const gdprExportResult = verifySignedToken(confirmToken, "data_export");
    expect(gdprExportResult.valid).toBe(false);

    const gdprDeleteResult = verifySignedToken(confirmToken, "data_delete");
    expect(gdprDeleteResult.valid).toBe(false);
  });

  it("correctly accepts distinct GDPR export and delete tokens", () => {
    const exportToken = generateSignedToken({
      id: "sub_gdpr_01",
      email: "user@privacy.org",
      purpose: "data_export",
    });
    expect(verifySignedToken(exportToken, "data_export").valid).toBe(true);
    expect(verifySignedToken(exportToken, "data_delete").valid).toBe(false);

    const deleteToken = generateSignedToken({
      id: "sub_gdpr_01",
      email: "user@privacy.org",
      purpose: "data_delete",
    });
    expect(verifySignedToken(deleteToken, "data_delete").valid).toBe(true);
    expect(verifySignedToken(deleteToken, "data_export").valid).toBe(false);
  });

  it("rejects tampered token signatures", () => {
    const token = generateSignedToken({
      id: "sub_1",
      email: "safe@aisignal.dev",
      purpose: "confirm",
    });
    const tampered = token.slice(0, -6) + "xxxxxx";
    const result = verifySignedToken(tampered);

    expect(result.valid).toBe(false);
    expect(result.error).toBe("Invalid signature");
  });

  it("rejects expired tokens", () => {
    const expiredToken = generateSignedToken(
      {
        id: "sub_1",
        email: "expired@aisignal.dev",
        purpose: "confirm",
      },
      -10 // Expired 10 seconds ago
    );
    const result = verifySignedToken(expiredToken);

    expect(result.valid).toBe(false);
    expect(result.error).toBe("Token expired");
  });
});
