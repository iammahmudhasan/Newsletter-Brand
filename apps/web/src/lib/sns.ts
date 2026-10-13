import crypto from "crypto";

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

/**
 * Verifies cryptographic signature of an AWS SNS message
 */
export async function verifyAwsSnsSignature(
  payload: Record<string, any>,
  options: {
    allowedTopicArn?: string;
    certificateFetcher?: (url: string) => Promise<string | null>;
  } = {}
): Promise<{ valid: boolean; error?: string }> {
  // 1. Basic structural validation
  if (!payload || typeof payload !== "object") {
    return { valid: false, error: "Invalid payload format" };
  }

  const { Type, Signature, SigningCertURL, SignatureVersion, TopicArn } = payload;

  if (!Type || !Signature || !SigningCertURL) {
    return { valid: false, error: "Missing required SNS signature fields" };
  }

  // 2. Validate TopicArn allowlist if specified
  if (options.allowedTopicArn && options.allowedTopicArn.trim() !== "") {
    if (TopicArn !== options.allowedTopicArn) {
      return {
        valid: false,
        error: `TopicArn '${TopicArn}' does not match allowed TopicArn '${options.allowedTopicArn}'`,
      };
    }
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
