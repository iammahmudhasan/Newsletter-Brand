import {
  generateSignedToken,
  verifySignedToken,
  normalizeEmail,
  hashIp,
} from "../../packages/config/src/index";

export function testTokens() {
  console.log("▶ [UNIT TEST] Testing Token Cryptography & Normalization...");

  // 1. Normalization
  const raw = "  Alex.ML+tester@Domain.COM  ";
  const norm = normalizeEmail(raw);
  if (norm !== "alex.ml+tester@domain.com") {
    throw new Error(`Normalization failed: expected 'alex.ml+tester@domain.com', got '${norm}'`);
  }

  // 2. IP Anonymization
  const hash1 = hashIp("192.168.1.100");
  const hash2 = hashIp("192.168.1.100");
  const hash3 = hashIp("10.0.0.1");
  if (hash1 !== hash2 || hash1 === hash3) {
    throw new Error("IP hashing consistency check failed");
  }

  // 3. HMAC Token signing and decoding
  const payload = {
    id: "sub_test_99",
    email: norm,
    purpose: "confirm" as const,
  };
  const token = generateSignedToken(payload, 3600);
  const result = verifySignedToken(token);

  if (!result.valid || result.payload?.id !== payload.id || result.payload?.email !== norm) {
    throw new Error("Valid token was rejected or payload mismatched");
  }

  // 4. Tampering rejection
  const tampered = token.slice(0, -6) + "xxxxxx";
  const tamperedResult = verifySignedToken(tampered);
  if (tamperedResult.valid) {
    throw new Error("Tampered token signature was incorrectly accepted!");
  }

  // 5. Expiration rejection
  const expiredToken = generateSignedToken(payload, -10); // already expired
  const expiredResult = verifySignedToken(expiredToken);
  if (expiredResult.valid) {
    throw new Error("Expired token was incorrectly accepted!");
  }

  console.log("✔ [UNIT TEST] Token Cryptography & Normalization PASSED.");
}

testTokens();
