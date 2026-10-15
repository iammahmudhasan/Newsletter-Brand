import crypto from "crypto";
import { config } from "@ai-signal/config";

// In-memory certificate cache: URL -> PEM certificate string
const certCache = new Map<string, { pem: string; expiresAt: number }>();
const CERT_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Validates that an AWS SNS SigningCertURL is a trusted HTTPS endpoint on amazonaws.com
 */
export function validateSnsCertUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);

    // 1. Must be HTTPS
    if (parsed.protocol !== "https:") {
      return false;
    }

    // 2. Host must match AWS SNS hostname pattern: sns.<region>.amazonaws.com
    const snsHostRegex = /^sns\.[a-zA-Z0-9-]+\.amazonaws\.com$/;
    if (!snsHostRegex.test(parsed.hostname)) {
      return false;
    }

    // 3. Path must end with .pem
    if (!parsed.pathname.endsWith(".pem")) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Builds the canonical string representation of an AWS SNS message according to AWS specification:
 * https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html
 */
export function buildSnsCanonicalString(payload: Record<string, any>): string | null {
  const type = payload.Type;
  if (!type) return null;

  let fields: string[] = [];

  if (type === "Notification") {
    fields = ["Message", "MessageId"];
    if (payload.Subject !== undefined && payload.Subject !== null) {
      fields.push("Subject");
    }
    fields.push("Timestamp", "TopicArn", "Type");
  } else if (type === "SubscriptionConfirmation" || type === "UnsubscribeConfirmation") {
    fields = [
      "Message",
      "MessageId",
      "SubscribeURL",
      "Timestamp",
      "Token",
      "TopicArn",
      "Type",
    ];
  } else {
    return null;
  }

  // Fields must appear in alphabetical order in the canonical string
  fields.sort();

  let canonical = "";
  for (const field of fields) {
    if (payload[field] === undefined || payload[field] === null) {
      return null;
    }
    canonical += `${field}\n${payload[field]}\n`;
  }

  return canonical;
}

/**
 * Fetches and caches the AWS SNS X.509 certificate securely
 */
async function fetchSnsCertificate(certUrl: string): Promise<string | null> {
  if (!validateSnsCertUrl(certUrl)) {
    console.error(`[AWS SNS Security] Rejected untrusted SigningCertURL: ${certUrl}`);
    return null;
  }

  const cached = certCache.get(certUrl);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.pem;
  }

  try {
    const res = await fetch(certUrl, {
      method: "GET",
      headers: { Accept: "application/x-pem-file, text/plain" },
      signal: AbortSignal.timeout(5000), // 5s timeout
    });

    if (!res.ok) {
      console.error(`[AWS SNS Security] Failed to fetch certificate from ${certUrl}: HTTP ${res.status}`);
      return null;
    }

    const pem = await res.text();
    if (!pem.includes("-----BEGIN CERTIFICATE-----")) {
      console.error(`[AWS SNS Security] Fetched content is not a valid PEM certificate from ${certUrl}`);
      return null;
    }

    certCache.set(certUrl, {
      pem,
      expiresAt: Date.now() + CERT_CACHE_TTL_MS,
    });

    return pem;
  } catch (err: any) {
    console.error(`[AWS SNS Security] Error fetching certificate: ${err.message}`);
    return null;
  }
}

export interface VerifyAwsSnsOptions {
  allowedTopicArn: string;
  certificateFetcher?: (url: string) => Promise<string | null>;
}

/**
 * Verifies cryptographic signature of an AWS SNS message and validates TopicArn
 */
export async function verifyAwsSnsSignature(
  payload: Record<string, any>,
  options: VerifyAwsSnsOptions
): Promise<{ valid: boolean; error?: string }> {
  // 1. Basic structural validation
  if (!payload || typeof payload !== "object") {
    return { valid: false, error: "Invalid payload format" };
  }

  const { Type, Signature, SigningCertURL, SignatureVersion, TopicArn } = payload;

  if (!Type || !Signature || !SigningCertURL) {
    return { valid: false, error: "Missing required SNS signature fields" };
  }

  // 2. Strict TopicArn validation: allowedTopicArn MUST be non-empty and configured
  if (
    !options ||
    !options.allowedTopicArn ||
    typeof options.allowedTopicArn !== "string" ||
    options.allowedTopicArn.trim() === ""
  ) {
    return {
      valid: false,
      error: "Verification failed: allowedTopicArn is required and cannot be empty",
    };
  }

  if (!TopicArn || typeof TopicArn !== "string") {
    return {
      valid: false,
      error: "Verification failed: Incoming SNS message is missing TopicArn",
    };
  }

  const expectedTopicArn = options.allowedTopicArn.trim();
  const incomingTopicArn = TopicArn.trim();

  if (incomingTopicArn !== expectedTopicArn) {
    return {
      valid: false,
      error: `TopicArn mismatch: received '${incomingTopicArn}', expected '${expectedTopicArn}'`,
    };
  }

  // 3. Validate SigningCertURL domain
  if (!validateSnsCertUrl(SigningCertURL)) {
    return {
      valid: false,
      error: `Untrusted SigningCertURL hostname or scheme: ${SigningCertURL}`,
    };
  }

  // 4. Build canonical string
  const canonicalString = buildSnsCanonicalString(payload);
  if (!canonicalString) {
    return { valid: false, error: "Failed to construct valid SNS canonical string" };
  }

  // 5. Fetch certificate
  const fetcher = options.certificateFetcher || fetchSnsCertificate;
  const certPem = await fetcher(SigningCertURL);
  if (!certPem) {
    return { valid: false, error: "Unable to retrieve valid signing certificate" };
  }

  // 6. Cryptographic signature check
  try {
    if (SignatureVersion !== "1" && SignatureVersion !== "2") {
      return {
        valid: false,
        error: `Unsupported or unknown SNS SignatureVersion: '${SignatureVersion}'. Only versions 1 and 2 are permitted.`,
      };
    }
    const algorithm = SignatureVersion === "2" ? "RSA-SHA256" : "RSA-SHA1";
    const verifier = crypto.createVerify(algorithm);
    verifier.update(canonicalString, "utf8");

    const isValid = verifier.verify(certPem, Signature, "base64");
    if (!isValid) {
      return { valid: false, error: "Cryptographic signature mismatch" };
    }

    return { valid: true };
  } catch (err: any) {
    return { valid: false, error: `Signature verification exception: ${err.message}` };
  }
}

export interface ConfirmSubscriptionOptions {
  TopicArn: string;
  Token: string;
  SubscribeURL?: string;
  customFetcher?: (url: string) => Promise<{ ok: boolean; status: number }>;
}

/**
 * Confirms an AWS SNS subscription using either the official AWS SNS ConfirmSubscriptionCommand
 * or by programmatically visiting the strictly verified SubscribeURL.
 */
export async function confirmSnsSubscription(
  options: ConfirmSubscriptionOptions
): Promise<{ success: boolean; subscriptionArn?: string; error?: string }> {
  const { TopicArn, Token, SubscribeURL, customFetcher } = options;

  if (!TopicArn || !Token) {
    return {
      success: false,
      error: "Missing required TopicArn or Token for subscription confirmation",
    };
  }

  // 1. If AWS credentials are configured, use AWS SDK's ConfirmSubscriptionCommand
  const { accessKeyId, secretAccessKey, region } = config.email.aws;
  if (accessKeyId && secretAccessKey) {
    try {
      const { SNSClient, ConfirmSubscriptionCommand } = await import("@aws-sdk/client-sns");
      const snsClient = new SNSClient({
        region: region || "us-east-1",
        credentials: { accessKeyId, secretAccessKey },
      });
      const response = await snsClient.send(
        new ConfirmSubscriptionCommand({
          TopicArn,
          Token,
        })
      );
      return {
        success: true,
        subscriptionArn: response.SubscriptionArn,
      };
    } catch (sdkErr: any) {
      console.warn(
        `[SNS ConfirmSubscription SDK Warning]: ${sdkErr.message}. Attempting secure SubscribeURL fallback...`
      );
    }
  }

  // 2. Fallback: Programmatically visit SubscribeURL with strict AWS domain verification
  if (SubscribeURL) {
    try {
      const parsedUrl = new URL(SubscribeURL);
      const isHttps = parsedUrl.protocol === "https:";
      const isAwsSnsHost = /^sns\.[a-zA-Z0-9-]+\.amazonaws\.com(\.cn)?$/.test(parsedUrl.hostname);

      if (!isHttps || !isAwsSnsHost) {
        return {
          success: false,
          error: `Untrusted SubscribeURL: ${SubscribeURL}`,
        };
      }

      if (customFetcher) {
        const fetchRes = await customFetcher(SubscribeURL);
        if (!fetchRes.ok) {
          return {
            success: false,
            error: `SubscribeURL HTTP error: status ${fetchRes.status}`,
          };
        }
        return { success: true };
      }

      const res = await fetch(SubscribeURL, { method: "GET" });
      if (!res.ok) {
        return {
          success: false,
          error: `SubscribeURL HTTP request failed with status ${res.status}`,
        };
      }

      return { success: true };
    } catch (urlErr: any) {
      return {
        success: false,
        error: `Failed to confirm subscription via SubscribeURL: ${urlErr.message}`,
      };
    }
  }

  return {
    success: false,
    error: "Unable to confirm subscription: neither AWS credentials nor valid SubscribeURL available",
  };
}

