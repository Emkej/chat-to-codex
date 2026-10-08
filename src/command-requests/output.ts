/** Return a valid UTF-8 suffix whose encoded size never exceeds the byte budget. */
export function utf8Tail(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text);
  let start = Math.max(0, bytes.length - maxBytes);
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return { text: bytes.subarray(start).toString("utf8"), truncated: start > 0 };
}

/** Retain newest bytes while continuing to drain every data event. */
export class OutputTail {
  private bytes = Buffer.alloc(0);
  truncated = false;
  constructor(private readonly cap: number) {}
  append(chunk: Buffer): void {
    const total = this.bytes.length + chunk.length;
    if (total > this.cap) this.truncated = true;
    this.bytes = chunk.length >= this.cap
      ? Buffer.from(chunk.subarray(chunk.length - this.cap))
      : Buffer.concat([this.bytes.subarray(Math.max(0, total - this.cap)), chunk]);
  }
  take(): string {
    const text = utf8Tail(this.bytes.toString("utf8"), this.cap).text;
    this.bytes = Buffer.alloc(0);
    return text;
  }
}
