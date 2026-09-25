/**
 * Reads a response body with a hard byte ceiling, cancelling the rest.
 *
 * `await response.text()` buffers whatever the upstream chooses to send before
 * anyone can truncate it, so the ceiling a caller thought it had applied was
 * only ever applied to memory it had already taken.
 */
export async function readBodyUpTo(
  response: Response,
  maxBytes: number,
  options: {
    idleTimeoutMs?: number;
    onChunk?: (chunk: Uint8Array) => void | Promise<void>;
    collectBytes?: boolean;
  } = {},
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  // A declared length over the ceiling marks the result truncated, but the
  // first `maxBytes` are still read. Returning nothing here instead would make
  // the outcome depend on whether the upstream sent `content-length`: a caller
  // that truncates (every HTML-producing step) would get a whole page from a
  // chunked response and an empty string from a declared one, and would call
  // both a success.
  const declared = Number(response.headers.get("content-length"));
  const declaredOverflow = Number.isFinite(declared) && declared > maxBytes;
  if (!response.body) {
    const whole = new Uint8Array(await response.arrayBuffer());
    return whole.length > maxBytes
      ? { bytes: whole.subarray(0, maxBytes), truncated: true }
      : { bytes: whole, truncated: declaredOverflow };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await readWithIdleTimeout(reader, options.idleTimeoutMs);
      if (done) break;
      if (!value?.length) continue;
      total += value.length;
      if (total > maxBytes) {
        if (options.collectBytes !== false) chunks.push(value);
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
      await options.onChunk?.(value);
      if (options.collectBytes !== false) chunks.push(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  }
  const kept = options.collectBytes === false ? 0 : Math.min(total, maxBytes);
  const out = new Uint8Array(kept);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= kept) break;
    const slice = chunk.subarray(0, kept - offset);
    out.set(slice, offset);
    offset += slice.length;
  }
  return { bytes: out, truncated: truncated || declaredOverflow };
}

async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number | undefined,
): ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]> {
  if (idleTimeoutMs === undefined) return await reader.read();
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) {
    throw new RangeError("idleTimeoutMs must be a positive finite number");
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new DOMException(
            `Response body made no progress for ${idleTimeoutMs} ms`,
            "TimeoutError",
          ));
        }, idleTimeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Decodes bytes that may have been cut mid-character.
 *
 * A UTF-8 sequence split by the byte ceiling would decode as a replacement
 * character; dropping the incomplete tail keeps the text exactly as far as the
 * last whole character.
 */
export function decodeTruncatedUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(trimIncompleteUtf8Tail(bytes));
}

function trimIncompleteUtf8Tail(buf: Uint8Array): Uint8Array {
  const len = buf.length;
  for (let back = 1; back <= 3 && back <= len; back++) {
    const byte = buf[len - back]!;
    if ((byte & 0b1100_0000) === 0b1000_0000) continue;
    let sequenceLength = 1;
    if ((byte & 0b1110_0000) === 0b1100_0000) sequenceLength = 2;
    else if ((byte & 0b1111_0000) === 0b1110_0000) sequenceLength = 3;
    else if ((byte & 0b1111_1000) === 0b1111_0000) sequenceLength = 4;
    return sequenceLength > back ? buf.subarray(0, len - back) : buf;
  }
  return buf;
}
