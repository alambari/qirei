/**
 * Splits a byte stream into lines without ever holding more than `maxBytes` of one line.
 *
 * A line longer than `maxBytes` (newline excluded, a trailing `\r` included) is dropped as its bytes
 * arrive, so a hostile writer cannot make the sidecar buffer it; `onOversized` is called once with
 * its full length when its newline arrives or the stream ends. A trailing `\r` is stripped from
 * kept lines, and a last line without a newline is yielded at the end.
 */
export async function* readLines(
  stream: AsyncIterable<Uint8Array | string>,
  maxBytes: number,
  onOversized: (bytes: number) => void,
): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8');
  let parts: Uint8Array[] = [];
  let held = 0;
  // Bytes of the current line seen so far while it is being discarded; -1 when not discarding.
  let discarded = -1;

  const finish = (): string | undefined => {
    if (discarded >= 0) {
      onOversized(discarded);
      discarded = -1;
      return undefined;
    }
    const line = decoder.decode(Buffer.concat(parts, held));
    parts = [];
    held = 0;
    return line.endsWith('\r') ? line.slice(0, -1) : line;
  };

  const take = (bytes: Uint8Array) => {
    if (bytes.length === 0) return;
    if (discarded >= 0) {
      discarded += bytes.length;
      return;
    }
    if (held + bytes.length > maxBytes) {
      discarded = held + bytes.length;
      parts = [];
      held = 0;
      return;
    }
    parts.push(bytes);
    held += bytes.length;
  };

  for await (const chunk of stream) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    let start = 0;
    for (;;) {
      const nl = buf.indexOf(0x0a, start);
      if (nl < 0) {
        take(buf.subarray(start));
        break;
      }
      take(buf.subarray(start, nl));
      const line = finish();
      if (line !== undefined) yield line;
      start = nl + 1;
    }
  }
  if (discarded >= 0 || held > 0) {
    const line = finish();
    if (line !== undefined && line.length > 0) yield line;
  }
}
