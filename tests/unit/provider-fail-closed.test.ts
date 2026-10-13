import { describe, it, expect } from "bun:test";
import { validateProductionConfig } from "@ai-signal/config";
import { getEmailProvider } from "@ai-signal/email";

describe("Email Provider Fail-Closed Security Rules", () => {
  const baseValidProductionEnv: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    AUTH_SECRET: "a-valid-production-auth-secret-with-over-32-chars-long!",
    ADMIN_PASSWORD: "SuperSecureProductionAdminPassword2026!#",
    DATABASE_URL: "postgres://user:pass@remote-rds-cluster.amazonaws.com:5432/ai_signal",
    EMAIL_PROVIDER: "resend",
    RESEND_API_KEY: "re_test_valid_key_1234567890",
    EMAIL_WEBHOOK_SECRET: "whsec_valid_production_signing_secret_999",
  };

  it("passes validation with valid production configuration", () => {
    expect(() => validateProductionConfig(baseValidProductionEnv)).not.toThrow();
  });

  it("fails startup if EMAIL_PROVIDER is missing in production", () => {
    const env = { ...baseValidProductionEnv };
    delete env.EMAIL_PROVIDER;

    expect(() => validateProductionConfig(env)).toThrow(
      /EMAIL_PROVIDER is required in production/
    );
  });

  it("fails startup if EMAIL_PROVIDER=console in production", () => {
    const env = { ...baseValidProductionEnv, EMAIL_PROVIDER: "console" };

    expect(() => validateProductionConfig(env)).toThrow(
      /EMAIL_PROVIDER=console is not permitted in production/
    );
  });

  it("fails startup if EMAIL_PROVIDER is set to an unknown or typo value in production", () => {
    const env = { ...baseValidProductionEnv, EMAIL_PROVIDER: "mock" };
    expect(() => validateProductionConfig(env)).toThrow(
      /EMAIL_PROVIDER 'mock' is unrecognized and invalid/
    );

    const env2 = { ...baseValidProductionEnv, EMAIL_PROVIDER: "sendgrid" };
    expect(() => validateProductionConfig(env2)).toThrow(
      /EMAIL_PROVIDER 'sendgrid' is unrecognized and invalid/
    );
  });

  it("fails startup if EMAIL_PROVIDER=ses and AWS_SNS_TOPIC_ARN is missing in production", () => {
    const sesEnvWithoutTopic: NodeJS.ProcessEnv = {
      ...baseValidProductionEnv,
      EMAIL_PROVIDER: "ses",
      AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
      AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      AWS_REGION: "us-east-1",
      // AWS_SNS_TOPIC_ARN is missing!
    };
    delete sesEnvWithoutTopic.RESEND_API_KEY;

    expect(() => validateProductionConfig(sesEnvWithoutTopic)).toThrow(
      /AWS_SNS_TOPIC_ARN is required for SES in production to validate SNS webhooks/
    );
  });

  it("passes validation when EMAIL_PROVIDER=ses and all AWS keys and AWS_SNS_TOPIC_ARN are present", () => {
    const validSesEnv: NodeJS.ProcessEnv = {
      ...baseValidProductionEnv,
      EMAIL_PROVIDER: "ses",
      AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
      AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      AWS_REGION: "us-east-1",
      AWS_SNS_TOPIC_ARN: "arn:aws:sns:us-east-1:123456789012:ai-signal-ses-webhook-topic",
    };
    delete validSesEnv.RESEND_API_KEY;

    expect(() => validateProductionConfig(validSesEnv)).not.toThrow();
  });

  it("strictly prohibits runtime SKIP_ENV_VALIDATION bypass unless in Next.js static build phase", () => {
    const insecureEnv: NodeJS.ProcessEnv = {
      NODE_ENV: "production",
      SKIP_ENV_VALIDATION: "true", // Attacker attempts to bypass validation via env flag
      // Missing all required production secrets!
    };

    // Since NEXT_PHASE is NOT 'phase-production-build', validation MUST still fail-closed
    expect(() => validateProductionConfig(insecureEnv)).toThrow(
      /Production startup aborted due to security validation failures/
    );
  });

  it("allows SKIP_ENV_VALIDATION strictly when NEXT_PHASE=phase-production-build (static compile only)", () => {
    const buildPhaseEnv: NodeJS.ProcessEnv = {
      NODE_ENV: "production",
      NEXT_PHASE: "phase-production-build",
      SKIP_ENV_VALIDATION: "true",
    };

    expect(() => validateProductionConfig(buildPhaseEnv)).not.toThrow();
  });

  describe("getEmailProvider Factory Enforcement", () => {
    it("throws explicit exception for unknown or unsupported providers instead of fallback", () => {
      expect(() => getEmailProvider("unknown-provider")).toThrow(
        /Unsupported or unknown email provider: 'unknown-provider'/
      );
      expect(() => getEmailProvider("sendgrid")).toThrow(
        /Unsupported or unknown email provider: 'sendgrid'/
      );
    });

    it("throws when console provider is attempted in production", () => {
      const originalNodeEnv = process.env.NODE_ENV;
      try {
        (process.env as any).NODE_ENV = "production";
        expect(() => getEmailProvider("console")).toThrow(
          /Console mock provider cannot be used in production/
        );
      } finally {
        (process.env as any).NODE_ENV = originalNodeEnv;
      }
    });
  });
});
