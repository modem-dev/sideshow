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

// bytes -> base64, runtime-agnostic (btoa is a global in Node and Workers, same
// as the btoa server/types.ts already relies on for id generation). Chunked
// String.fromCharCode: spreading a whole multi-megabyte asset in one call blows
// the argument-count limit (RangeError), so build the binary string in 32 KiB
// slices. No Buffer — that's Node-only and would break the Worker DO.
export function encodeBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
