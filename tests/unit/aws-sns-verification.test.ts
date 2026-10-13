import { describe, it, expect } from "bun:test";
import crypto from "crypto";
import {
  validateSnsCertUrl,
  buildSnsCanonicalString,
  verifyAwsSnsSignature,
} from "../../apps/web/src/lib/sns";

describe("AWS SNS Webhook Signature Verification Security", () => {
  describe("validateSnsCertUrl", () => {
    it("accepts valid AWS SNS HTTPS certificate URLs", () => {
      expect(
        validateSnsCertUrl(
          "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-0123456789abcdef.pem"
        )
      ).toBe(true);
      expect(
        validateSnsCertUrl(
          "https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-bb98477f16022191e01d00f7fb340a57.pem"
        )
      ).toBe(true);
      expect(
        validateSnsCertUrl(
          "https://sns.ap-southeast-1.amazonaws.com/cert.pem"
        )
      ).toBe(true);
    });

    it("rejects insecure HTTP certificate URLs", () => {
      expect(
        validateSnsCertUrl(
          "http://sns.us-east-1.amazonaws.com/SimpleNotificationService.pem"
        )
      ).toBe(false);
    });

    it("rejects untrusted domains (spoofing / phishing)", () => {
      expect(validateSnsCertUrl("https://evil.com/SimpleNotificationService.pem")).toBe(false);
      expect(
        validateSnsCertUrl("https://attacker.amazonaws.com.evil.com/cert.pem")
      ).toBe(false);
      expect(
        validateSnsCertUrl("https://sns.us-east-1.amazonaws.com.attacker.com/cert.pem")
      ).toBe(false);
    });

    it("rejects non-PEM file extensions", () => {
      expect(
        validateSnsCertUrl("https://sns.us-east-1.amazonaws.com/cert.txt")
      ).toBe(false);
      expect(
        validateSnsCertUrl("https://sns.us-east-1.amazonaws.com/cert")
      ).toBe(false);
      expect(
        validateSnsCertUrl("https://sns.us-east-1.amazonaws.com/cert.exe")
      ).toBe(false);
    });

    it("rejects invalid URL strings safely without crashing", () => {
      expect(validateSnsCertUrl("not-a-valid-url")).toBe(false);
      expect(validateSnsCertUrl("")).toBe(false);
    });
  });

  describe("buildSnsCanonicalString", () => {
    it("constructs sorted canonical string for Notification", () => {
      const payload = {
        Type: "Notification",
        Message: "{\"eventType\":\"Bounce\"}",
        MessageId: "msg-12345",
        TopicArn: "arn:aws:sns:us-east-1:123456789012:ai-signal-ses-events",
        Timestamp: "2026-10-14T01:00:00.000Z",
      };

      const canonical = buildSnsCanonicalString(payload);
      expect(canonical).not.toBeNull();

      const expected =
        "Message\n{\"eventType\":\"Bounce\"}\n" +
        "MessageId\nmsg-12345\n" +
        "Timestamp\n2026-10-14T01:00:00.000Z\n" +
        "TopicArn\narn:aws:sns:us-east-1:123456789012:ai-signal-ses-events\n" +
        "Type\nNotification\n";

      expect(canonical).toBe(expected);
    });

    it("includes Subject in canonical string when present", () => {
      const payload = {
        Type: "Notification",
        Message: "test",
        MessageId: "id",
        Subject: "AWS SES Notification",
        Timestamp: "2026-10-14T01:00:00.000Z",
        TopicArn: "arn:aws:sns:us-east-1:123:topic",
      };

      const canonical = buildSnsCanonicalString(payload);
      expect(canonical).toContain("Subject\nAWS SES Notification\n");
    });

    it("constructs canonical string for SubscriptionConfirmation", () => {
      const payload = {
        Type: "SubscriptionConfirmation",
        Message: "Confirm subscription",
        MessageId: "sub-123",
        SubscribeURL: "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription",
        Timestamp: "2026-10-14T01:00:00.000Z",
        Token: "token-abc-123",
        TopicArn: "arn:aws:sns:us-east-1:123:topic",
      };

      const canonical = buildSnsCanonicalString(payload);
      expect(canonical).toContain("SubscribeURL\nhttps://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription\n");
      expect(canonical).toContain("Token\ntoken-abc-123\n");
    });
  });

  describe("verifyAwsSnsSignature", () => {
    // Generate an in-memory RSA keypair for cryptographic testing
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    // Create a self-signed cert PEM wrapper
    const mockCertPem = `-----BEGIN CERTIFICATE-----\n${Buffer.from(publicKey).toString("base64")}\n-----END CERTIFICATE-----`;

    it("rejects verification when allowedTopicArn option is missing or empty", async () => {
      const result = await verifyAwsSnsSignature(
        {
          Type: "Notification",
          Message: "test",
          Signature: "sig",
          SigningCertURL: "https://sns.us-east-1.amazonaws.com/cert.pem",
          TopicArn: "arn:aws:sns:us-east-1:123:topic",
        },
        { allowedTopicArn: "" }
      );
      expect(result.valid).toBe(false);
      expect(result.error).toContain("allowedTopicArn is required");
    });

    it("rejects payload missing signature or cert URL", async () => {
      const result = await verifyAwsSnsSignature(
        {
          Type: "Notification",
          Message: "test",
          TopicArn: "arn:aws:sns:us-east-1:123:topic",
        },
        { allowedTopicArn: "arn:aws:sns:us-east-1:123:topic" }
      );
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Missing required SNS signature fields");
    });

    it("rejects payload missing TopicArn", async () => {
      const result = await verifyAwsSnsSignature(
        {
          Type: "Notification",
          Message: "test",
          Signature: "sig",
          SigningCertURL: "https://sns.us-east-1.amazonaws.com/cert.pem",
        },
        { allowedTopicArn: "arn:aws:sns:us-east-1:123:topic" }
      );
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Incoming SNS message is missing TopicArn");
    });

    it("rejects payload with untrusted SigningCertURL", async () => {
      const result = await verifyAwsSnsSignature(
        {
          Type: "Notification",
          Message: "test",
          MessageId: "123",
          TopicArn: "arn:aws:sns:us-east-1:123:topic",
          Timestamp: "2026-10-14T01:00:00.000Z",
          Signature: "fake-sig",
          SigningCertURL: "https://evil.com/fake-cert.pem",
        },
        { allowedTopicArn: "arn:aws:sns:us-east-1:123:topic" }
      );

      expect(result.valid).toBe(false);
      expect(result.error).toContain("Untrusted SigningCertURL");
    });

    it("rejects payload when TopicArn does not match allowed TopicArn (wrong topic)", async () => {
      const result = await verifyAwsSnsSignature(
        {
          Type: "Notification",
          Message: "test",
          MessageId: "123",
          TopicArn: "arn:aws:sns:us-east-1:123:attacker-rogue-topic",
          Timestamp: "2026-10-14T01:00:00.000Z",
          Signature: "fake-sig",
          SigningCertURL: "https://sns.us-east-1.amazonaws.com/cert.pem",
        },
        { allowedTopicArn: "arn:aws:sns:us-east-1:123:expected-production-topic" }
      );

      expect(result.valid).toBe(false);
      expect(result.error).toContain("TopicArn mismatch");
    });

    it("rejects valid RSA signature when TopicArn is from an untrusted rogue topic", async () => {
      // Simulates an attacker sending an authentic, cryptographically signed message from their OWN AWS account's SNS topic
      const attackerPayload: Record<string, any> = {
        Type: "Notification",
        Message: JSON.stringify({ eventType: "Bounce", mail: { messageId: "spoofed-msg" } }),
        MessageId: "sns-attacker-999",
        TopicArn: "arn:aws:sns:us-east-1:999999999999:attacker-controlled-topic",
        Timestamp: "2026-10-14T01:00:00.000Z",
        SignatureVersion: "2",
        SigningCertURL: "https://sns.us-east-1.amazonaws.com/cert.pem",
      };

      const canonical = buildSnsCanonicalString(attackerPayload)!;
      const signer = crypto.createSign("RSA-SHA256");
      signer.update(canonical, "utf8");
      attackerPayload.Signature = signer.sign(privateKey, "base64");

      const result = await verifyAwsSnsSignature(attackerPayload, {
        allowedTopicArn: "arn:aws:sns:us-east-1:123456789012:ai-signal-legitimate-topic",
        certificateFetcher: async () => publicKey,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain("TopicArn mismatch");
    });

    it("rejects forged or tampered signatures even when TopicArn matches", async () => {
      const payload = {
        Type: "Notification",
        Message: "test",
        MessageId: "123",
        TopicArn: "arn:aws:sns:us-east-1:123:legitimate-topic",
        Timestamp: "2026-10-14T01:00:00.000Z",
        SignatureVersion: "1",
        Signature: Buffer.from("forged_invalid_signature_bytes").toString("base64"),
        SigningCertURL: "https://sns.us-east-1.amazonaws.com/cert.pem",
      };

      const result = await verifyAwsSnsSignature(payload, {
        allowedTopicArn: "arn:aws:sns:us-east-1:123:legitimate-topic",
        certificateFetcher: async () => publicKey,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain("Cryptographic signature mismatch");
    });

    it("successfully verifies genuine cryptographically signed SNS notification with matching TopicArn", async () => {
      const payload: Record<string, any> = {
        Type: "Notification",
        Message: JSON.stringify({ eventType: "Bounce", mail: { messageId: "ses-msg-1" } }),
        MessageId: "sns-msg-999",
        TopicArn: "arn:aws:sns:us-east-1:123456789012:ai-signal-events",
        Timestamp: "2026-10-14T01:00:00.000Z",
        SignatureVersion: "2",
        SigningCertURL: "https://sns.us-east-1.amazonaws.com/cert.pem",
      };

      const canonical = buildSnsCanonicalString(payload)!;
      const signer = crypto.createSign("RSA-SHA256");
      signer.update(canonical, "utf8");
      const signature = signer.sign(privateKey, "base64");
      payload.Signature = signature;

      const result = await verifyAwsSnsSignature(payload, {
        allowedTopicArn: "arn:aws:sns:us-east-1:123456789012:ai-signal-events",
        certificateFetcher: async () => publicKey,
      });

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });
});
