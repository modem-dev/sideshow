// base64 -> bytes, runtime-agnostic (atob is a global in Node and Workers).
// atob throws on malformed input; rethrow as a clean error so callers turn it
// into a 400 instead of letting a raw DOMException surface as a 500.
export function decodeBase64(b64: string): Uint8Array {
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    throw new Error("invalid base64 in `data`");
  }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
