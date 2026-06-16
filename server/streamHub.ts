// In-memory relay for live terminal streams. The PTY lives on the producer
// (the CLI) — this is a pure fan-out buffer, so it stays runtime-agnostic (no
// node imports) and works inside a Durable Object too. Bytes are held as a
// binary string (one char per byte) so concat/slice work everywhere without
// Buffer; the SSE layer base64-encodes on the way out.
//
// A stream is ephemeral: live deltas fan out to subscribers and accumulate in
// a bounded buffer for late joiners. Durability is the producer's job — on end
// it PUTs the final bytes into the screen part as `snapshot`, so the card still
// replays after this process (or DO) forgets the stream.

const MAX_STREAM_BYTES = 1_000_000;
const MAX_STREAMS = 64;

export type StreamEvent = { type: "data"; chunk: string } | { type: "end" };
type StreamListener = (e: StreamEvent) => void;

interface Entry {
  buffer: string;
  ended: boolean;
  cols?: number;
  rows?: number;
  touched: number;
  listeners: Set<StreamListener>;
}

export class StreamHub {
  private streams = new Map<string, Entry>();

  create(id: string, opts: { cols?: number; rows?: number } = {}): void {
    if (this.streams.has(id)) return;
    if (this.streams.size >= MAX_STREAMS) this.evictOldest();
    this.streams.set(id, {
      buffer: "",
      ended: false,
      cols: opts.cols,
      rows: opts.rows,
      touched: Date.now(),
      listeners: new Set(),
    });
  }

  has(id: string): boolean {
    return this.streams.has(id);
  }

  // Append a binary-string chunk and fan it out. Returns false if the stream is
  // unknown or already ended (the producer should stop).
  append(id: string, chunk: string): boolean {
    const e = this.streams.get(id);
    if (!e || e.ended) return false;
    e.buffer += chunk;
    if (e.buffer.length > MAX_STREAM_BYTES) {
      e.buffer = e.buffer.slice(e.buffer.length - MAX_STREAM_BYTES);
    }
    e.touched = Date.now();
    for (const fn of e.listeners) fn({ type: "data", chunk });
    return true;
  }

  end(id: string): boolean {
    const e = this.streams.get(id);
    if (!e || e.ended) return false;
    e.ended = true;
    e.touched = Date.now();
    for (const fn of e.listeners) fn({ type: "end" });
    return true;
  }

  state(id: string): { buffer: string; ended: boolean; cols?: number; rows?: number } | undefined {
    const e = this.streams.get(id);
    return e && { buffer: e.buffer, ended: e.ended, cols: e.cols, rows: e.rows };
  }

  subscribe(id: string, fn: StreamListener): () => void {
    const e = this.streams.get(id);
    if (!e) return () => {};
    e.listeners.add(fn);
    return () => e.listeners.delete(fn);
  }

  private evictOldest(): void {
    let oldestId: string | undefined;
    let oldest = Infinity;
    for (const [id, e] of this.streams) {
      // never evict a stream someone is actively watching
      if (e.listeners.size === 0 && e.touched < oldest) {
        oldest = e.touched;
        oldestId = id;
      }
    }
    if (oldestId) this.streams.delete(oldestId);
  }
}
