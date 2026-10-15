import { describe, it, expect } from "bun:test";
import { validateProductionConfig, config } from "../../packages/config/src/index";
import {
  createAdminSessionToken,
  verifyAdminSessionToken,
  verifyAdminPassword,
  isAuthorizedAdmin,
} from "../../apps/web/src/lib/auth";

describe("Production Security Baseline & Configuration Guardrails", () => {
  it("fails closed in production if AUTH_SECRET or ADMIN_PASSWORD are using insecure defaults", () => {
    const insecureEnv: NodeJS.ProcessEnv = {
      NODE_ENV: "production",
      AUTH_SECRET: "fallback-secret-development-only-change-me",
      ADMIN_PASSWORD: "admin123",
      DATABASE_URL: "postgres://prod_user:secret@db.prod.internal:5432/ai_signal",
      EMAIL_PROVIDER: "resend",
      RESEND_API_KEY: "re_123456789",
      EMAIL_WEBHOOK_SECRET: "whsec_real_secret_1234567890",
    };

    expect(() => validateProductionConfig(insecureEnv)).toThrow("Production startup aborted");
  });

  it("fails closed in production if EMAIL_PROVIDER is set to console mock", () => {
    const consoleInProdEnv: NodeJS.ProcessEnv = {
      NODE_ENV: "production",
      AUTH_SECRET: "super-secure-production-secret-must-be-very-long-32-chars",
      ADMIN_PASSWORD: "StrongAdminPassword2026!#",
      DATABASE_URL: "postgres://prod_user:secret@db.prod.internal:5432/ai_signal",
      EMAIL_PROVIDER: "console",
      EMAIL_WEBHOOK_SECRET: "whsec_real_secret_1234567890",
    };

    expect(() => validateProductionConfig(consoleInProdEnv)).toThrow(
      "EMAIL_PROVIDER=console is not permitted in production"
    );
  });

  it("fails closed in production if DATABASE_URL points to localhost", () => {
    const localhostInProd: NodeJS.ProcessEnv = {
      NODE_ENV: "production",
      AUTH_SECRET: "super-secure-production-secret-must-be-very-long-32-chars",
      ADMIN_PASSWORD: "StrongAdminPassword2026!#",
      DATABASE_URL: "postgres://postgres:postgres@localhost:5432/ai_signal",
      EMAIL_PROVIDER: "resend",
      RESEND_API_KEY: "re_123456789",
      EMAIL_WEBHOOK_SECRET: "whsec_real_secret_1234567890",
    };

    expect(() => validateProductionConfig(localhostInProd)).toThrow(
      "DATABASE_URL cannot point to localhost in production"
    );
  });

  it("passes validation when production environment is properly hardened", () => {
    const validProdEnv: NodeJS.ProcessEnv = {
      NODE_ENV: "production",
      APP_URL: "https://aisignal.dev",
      AUTH_SECRET: "super-secure-production-secret-must-be-very-long-32-chars",
      ADMIN_PASSWORD: "StrongAdminPassword2026!#",
      DATABASE_URL: "postgres://prod_user:secret@aws-rds.internal:5432/ai_signal",
      EMAIL_PROVIDER: "resend",
      RESEND_API_KEY: "re_valid_api_key_production_01",
      EMAIL_WEBHOOK_SECRET: "whsec_valid_webhook_secret_production_01",
    };

    expect(() => validateProductionConfig(validProdEnv)).not.toThrow();
  });

  it("fails closed in production if APP_URL is missing, insecure HTTP, or points to private/internal hosts", () => {
    const base: NodeJS.ProcessEnv = {
      NODE_ENV: "production",
      AUTH_SECRET: "super-secure-production-secret-must-be-very-long-32-chars",
      ADMIN_PASSWORD: "StrongAdminPassword2026!#",
      DATABASE_URL: "postgres://prod_user:secret@aws-rds.internal:5432/ai_signal",
      EMAIL_PROVIDER: "resend",
      RESEND_API_KEY: "re_valid_api_key_production_01",
      EMAIL_WEBHOOK_SECRET: "whsec_valid_webhook_secret_production_01",
    };

    // Missing APP_URL
    expect(() => validateProductionConfig({ ...base })).toThrow(/APP_URL is required in production/);

    // Insecure HTTP APP_URL
    expect(() => validateProductionConfig({ ...base, APP_URL: "http://aisignal.dev" })).toThrow(
      /APP_URL must use https:\/\/ in production/
    );

    // Localhost APP_URL
    expect(() => validateProductionConfig({ ...base, APP_URL: "https://localhost:3000" })).toThrow(
      /APP_URL cannot point to localhost, private IP ranges, or internal domains/
    );

    // Private IPv4 ranges (RFC 1918 & link-local)
    expect(() => validateProductionConfig({ ...base, APP_URL: "https://192.168.1.10" })).toThrow(
      /APP_URL cannot point to localhost, private IP ranges, or internal domains/
    );
    expect(() => validateProductionConfig({ ...base, APP_URL: "https://10.0.0.5:8443" })).toThrow(
      /APP_URL cannot point to localhost, private IP ranges, or internal domains/
    );
    expect(() => validateProductionConfig({ ...base, APP_URL: "https://172.20.14.2" })).toThrow(
      /APP_URL cannot point to localhost, private IP ranges, or internal domains/
    );
    expect(() => validateProductionConfig({ ...base, APP_URL: "https://169.254.169.254" })).toThrow(
      /APP_URL cannot point to localhost, private IP ranges, or internal domains/
    );

    // Internal domains and single-label hosts
    expect(() => validateProductionConfig({ ...base, APP_URL: "https://myservice.local" })).toThrow(
      /APP_URL cannot point to localhost, private IP ranges, or internal domains/
    );
    expect(() => validateProductionConfig({ ...base, APP_URL: "https://backend.internal" })).toThrow(
      /APP_URL cannot point to localhost, private IP ranges, or internal domains/
    );
    expect(() => validateProductionConfig({ ...base, APP_URL: "https://newsletter-service" })).toThrow(
      /APP_URL cannot point to localhost, private IP ranges, or internal domains/
    );
  });

  it("verifies admin session token validity and expiration", () => {
    const token = createAdminSessionToken();
    expect(verifyAdminSessionToken(token)).toBe(true);

    const tampered = token.slice(0, -5) + "abcde";
    expect(verifyAdminSessionToken(tampered)).toBe(false);
    expect(verifyAdminSessionToken("")).toBe(false);
    expect(verifyAdminSessionToken(null)).toBe(false);
  });

  it("strictly prevents using raw admin password as Bearer token in isAuthorizedAdmin", () => {
    // Attempting to send raw password in Authorization: Bearer header
    const reqWithRawPassword = {
      headers: new Headers({
        authorization: `Bearer ${config.adminPassword}`,
      }),
      cookies: { get: () => undefined },
    } as any;

    expect(isAuthorizedAdmin(reqWithRawPassword)).toBe(false);

    // Sending valid signed session token in Bearer header MUST succeed
    const validSession = createAdminSessionToken();
    const reqWithValidSession = {
      headers: new Headers({
        authorization: `Bearer ${validSession}`,
      }),
      cookies: { get: () => undefined },
    } as any;

    expect(isAuthorizedAdmin(reqWithValidSession)).toBe(true);

    // Sending valid signed session token in Cookie MUST succeed
    const reqWithCookie = {
      headers: new Headers(),
      cookies: {
        get: (name: string) => (name === "ai_signal_admin_session" ? { value: validSession } : undefined),
      },
    } as any;

    expect(isAuthorizedAdmin(reqWithCookie)).toBe(true);
  });

  it("performs timing-safe admin password verification", () => {
    expect(verifyAdminPassword(config.adminPassword)).toBe(true);
    expect(verifyAdminPassword("wrong-password-never-matches-123")).toBe(false);
    expect(verifyAdminPassword("")).toBe(false);
  });
});
