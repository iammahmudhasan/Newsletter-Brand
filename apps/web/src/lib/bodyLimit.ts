import { NextRequest } from "next/server";

export interface ReadBodySuccess {
  success: true;
  text: string;
}

export interface ReadBodyError {
  success: false;
  error: string;
  status: number;
}

export type ReadBodyResult = ReadBodySuccess | ReadBodyError;

/**
 * Incrementally reads a request body stream using Web Streams API with a hard byte threshold.
 * Aborts stream reading immediately via reader.cancel() as soon as the threshold is exceeded,
 * preventing memory spikes, Unicode character miscounts, and resource exhaustion attacks.
 */
export async function readBodyWithIncrementalLimit(
  req: NextRequest,
  maxBytes: number
): Promise<ReadBodyResult> {
  const contentLength = req.headers?.get ? req.headers.get("content-length") : null;
  if (contentLength && parseInt(contentLength, 10) > maxBytes) {
    return {
      success: false,
      error: `Payload too large: Content-Length exceeds ${maxBytes} bytes limit`,
      status: 413,
    };
  }

  if (!req.body) {
    let raw = "";
    if (typeof req.text === "function") {
      raw = await req.text();
    } else if (typeof (req as any).json === "function") {
      raw = JSON.stringify(await (req as any).json());
    }
    if (Buffer.byteLength(raw, "utf8") > maxBytes) {
      return {
        success: false,
        error: `Payload too large: request body exceeds ${maxBytes} bytes limit`,
        status: 413,
      };
    }
    return { success: true, text: raw };
  }

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel("Payload size limit exceeded");
          return {
            success: false,
            error: `Payload too large: request body exceeds ${maxBytes} bytes limit`,
            status: 413,
          };
        }
        chunks.push(value);
      }
    }
  } catch (err: any) {
    if (totalBytes > maxBytes) {
      return {
        success: false,
        error: `Payload too large: request body exceeds ${maxBytes} bytes limit`,
        status: 413,
      };
    }
    throw err;
  }

  const concatenated = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    concatenated.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { success: true, text: new TextDecoder("utf-8").decode(concatenated) };
}
