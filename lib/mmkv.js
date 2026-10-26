/**
 * Reading an MMKV file without MMKV.
 *
 * The phone app keeps its login state in MMKV (the APK says so: "StorageService
 * initialized (MMKV backend)"). MMKV's own file format is a length-prefixed
 * protobuf-ish map, so a plain `JSON.parse` cannot see inside it, and there is
 * no npm reader we can ship without a native module — which is exactly what
 * will not build on the DSHA container (Linux arm64, no compiler).
 *
 * So this module parses the format by hand. Layout, from MMKV's
 * `Core_MMKV_IO.cpp`:
 *
 *   offset 0            uint32 LE   size of the data area that follows
 *   offset 4            varint      a placeholder ("fake item size") written by
 *                                  every full write-back — `randomItemSizeHolder`
 *                                  makes it look like a real size, so it must be
 *                                  skipped by *reading a varint*, not 4 bytes
 *   then, repeated      varint keyLen, key bytes, varint valueLen, value bytes
 *
 * A value length of 0 means "this key was deleted", which is how MMKV removes
 * entries without rewriting. MMKV does not record types: an int is its little
 * endian bytes, a string is raw UTF-8, a bool is one byte. `decodeValue` guesses
 * from the length, which is enough for the handful of keys we care about.
 *
 * Two layouts are attempted because the placeholder only exists in files
 * written by a full write-back (MMKV >= 1.2, which is what this app ships), and
 * an older or freshly-created file can start straight at the first entry. The
 * parse that yields more real-looking entries wins.
 */

/** A file that cannot be read as MMKV. */
export class MmkvError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'MmkvError';
    this.code = code;
  }
}

/** Keys are short identifiers; anything else is a parse that went wrong. */
const MAX_KEY_BYTES = 512;

/** A value this large is not a login token; assume the parse went off the rails. */
const MAX_VALUE_BYTES = 16 * 1024 * 1024;

/**
 * Read one base-128 varint.
 * @param {Buffer} buffer
 * @param {number} offset
 * @returns {{ value: number, next: number } | undefined} `undefined` when the
 *   bytes run out or the varint is longer than 5 bytes (not a 32-bit varint).
 */
export function readVarint(buffer, offset) {
  let value = 0;
  let scale = 1;
  let position = offset;
  for (let index = 0; index < 5; index += 1) {
    if (position >= buffer.length) return undefined;
    const byte = buffer[position];
    position += 1;
    value += (byte & 0x7f) * scale;
    if ((byte & 0x80) === 0) return { value, next: position };
    // Multiply rather than shift: `<< 28` would go negative and the length
    // would come out as a huge number instead of a malformed varint.
    scale *= 128;
  }
  return undefined;
}

/**
 * @param {Buffer} bytes
 */
function keyLooksReal(bytes) {
  if (bytes.length === 0 || bytes.length > MAX_KEY_BYTES) return false;
  for (const byte of bytes) {
    // Printable ASCII only. Real keys are things like `workbuddy_token`; a
    // decryptable-looking run of binary means we started at the wrong offset.
    if (byte < 0x20 || byte > 0x7e) return false;
  }
  return true;
}

/**
 * Decode a value without knowing its type.
 * @param {Buffer} bytes
 */
export function decodeValue(bytes) {
  const length = bytes.length;
  if (length === 0) return { kind: 'empty' };
  if (length === 1 && (bytes[0] === 0 || bytes[0] === 1)) {
    return { kind: 'bool', boolean: bytes[0] === 1 };
  }
  // Length alone cannot separate a 4-character string from an int32, or an
  // 8-character uid from an int64 — MMKV stores no type tag. When every byte is
  // printable ASCII the textual reading is almost always the true one (a
  // mis-read number is worthless, a mis-read token is not), so it wins.
  if (length >= 2 && length <= MAX_KEY_BYTES && keyLooksReal(bytes)) {
    const text = bytes.toString('utf8').replace(/\0+$/, '');
    if (text !== '') return { kind: 'string', text };
  }
  if (length === 4) return { kind: 'int32', number: bytes.readInt32LE(0) };
  if (length === 8) {
    return {
      kind: 'int64',
      bigint: bytes.readBigInt64LE(0),
      number: Number(bytes.readBigInt64LE(0)),
      double: bytes.readDoubleLE(0),
    };
  }
  const text = bytes.toString('utf8').replace(/\0+$/, '');
  return { kind: 'string', text };
}

/**
 * Parse the entries of one data area.
 *
 * Returns whatever parsed before the first malformed entry, because a real
 * MMKV file is appended to and its declared size can overshoot by a few bytes
 * at the tail. Stopping at the first bad entry and keeping the good ones is
 * more useful than throwing the whole file away.
 *
 * @param {Buffer} buffer
 * @param {number} start
 * @param {number} end
 */
function parseEntries(buffer, start, end) {
  /** @type {Map<string, ReturnType<typeof decodeValue>>} */
  const entries = new Map();
  let position = start;
  let complete = true;

  while (position < end) {
    // Append mode leaves zero padding after the last entry.
    if (buffer[position] === 0) {
      let blank = true;
      for (let index = position; index < end; index += 1) {
        if (buffer[index] !== 0) {
          blank = false;
          break;
        }
      }
      if (blank) break;
    }

    const keyLength = readVarint(buffer, position);
    if (keyLength === undefined || keyLength.value === 0 || keyLength.value > MAX_KEY_BYTES) {
      complete = false;
      break;
    }
    const keyStart = keyLength.next;
    const keyEnd = keyStart + keyLength.value;
    if (keyEnd > end) {
      complete = false;
      break;
    }
    const keyBytes = buffer.subarray(keyStart, keyEnd);
    if (!keyLooksReal(keyBytes)) {
      complete = false;
      break;
    }

    const valueLength = readVarint(buffer, keyEnd);
    if (valueLength === undefined || valueLength.value > MAX_VALUE_BYTES) {
      complete = false;
      break;
    }
    const valueStart = valueLength.next;
    const valueEnd = valueStart + valueLength.value;
    if (valueEnd > end) {
      complete = false;
      break;
    }

    const key = keyBytes.toString('utf8');
    if (valueLength.value === 0) {
      // A zero length is MMKV's tombstone, not an empty string.
      entries.delete(key);
    } else {
      entries.set(key, decodeValue(buffer.subarray(valueStart, valueEnd)));
    }
    position = valueEnd;
  }

  return { entries, complete };
}

/**
 * Parse an MMKV file.
 * @param {Buffer} buffer
 * @returns {{ entries: Map<string, ReturnType<typeof decodeValue>>, layout: string, declaredSize: number, dataSize: number, complete: boolean }}
 */
export function parseMmkv(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new MmkvError('NOT_BUFFER', '只接受 Buffer');
  }
  if (buffer.length < 5) {
    throw new MmkvError('TOO_SMALL', `文件只有 ${buffer.length} 字节，不可能是一个 MMKV 文件`);
  }

  const declaredSize = buffer.readUInt32LE(0);
  const available = buffer.length - 4;
  // The header is either the exact data size (normal) or, in MMKV's newer crc
  // layout, something else entirely — fall back to what the file actually holds.
  const dataSize = declaredSize > 0 && declaredSize <= available ? declaredSize : available;
  const end = 4 + dataSize;

  /** @type {Array<{ layout: string, start: number }>} */
  const layouts = [];
  const placeholder = readVarint(buffer, 4);
  if (placeholder !== undefined && placeholder.next < end) {
    layouts.push({ layout: 'placeholder', start: placeholder.next });
  }
  layouts.push({ layout: 'plain', start: 4 });

  let best;
  for (const candidate of layouts) {
    if (candidate.start >= end) continue;
    const parsed = parseEntries(buffer, candidate.start, end);
    // Ten points per entry outweighs the five a complete parse is worth: a
    // longer parse is a better sign of the right offset than a tidier one.
    const score = parsed.entries.size * 10 + (parsed.complete ? 5 : 0);
    if (best === undefined || score > best.score) {
      best = { ...candidate, ...parsed, score };
    }
  }

  if (best === undefined) {
    return { entries: new Map(), layout: 'none', declaredSize, dataSize, complete: false };
  }
  return {
    entries: best.entries,
    layout: best.layout,
    declaredSize,
    dataSize,
    complete: best.complete,
  };
}

/**
 * The string form of a value, or `undefined` when there is not one.
 * @param {ReturnType<typeof decodeValue> | undefined} value
 */
export function valueText(value) {
  if (value === undefined) return undefined;
  if (value.kind === 'string') return value.text;
  if (value.kind === 'empty') return '';
  if (value.kind === 'bool') return value.boolean ? 'true' : 'false';
  if (value.kind === 'int32') return String(value.number);
  if (value.kind === 'int64') return String(value.bigint);
  return undefined;
}

/**
 * A millisecond timestamp, from any of the shapes MMKV can hold one in.
 *
 * Seconds vs milliseconds is decided by magnitude rather than by guessing from
 * the key name: anything below 1e11 is a second count that has to be scaled
 * (`1e11` seconds is the year 5138, `1e11` milliseconds is 1973).
 *
 * @param {ReturnType<typeof decodeValue> | undefined} value
 */
export function valueMillis(value) {
  if (value === undefined) return undefined;
  /** @type {number | undefined} */
  let raw;
  if (value.kind === 'int64') {
    // A plausibly-sized int64 could also be a double holding a date; prefer the
    // reading that lands near the present rather than in 1970 or the year 30000.
    const asInt = value.number;
    const asDouble = Number.isFinite(value.double) ? value.double : undefined;
    const good = (candidate) =>
      candidate !== undefined &&
      Number.isFinite(candidate) &&
      candidate > 1_000_000_000_000 &&
      candidate < 4_102_444_800_000;
    raw = good(asInt) ? asInt : good(asDouble) ? asDouble : asInt;
  } else if (value.kind === 'int32') {
    raw = value.number;
  } else if (value.kind === 'string') {
    const trimmed = value.text.trim();
    if (!/^\d+$/.test(trimmed)) return undefined;
    raw = Number(trimmed);
  } else {
    return undefined;
  }
  if (!Number.isFinite(raw) || raw <= 0) return undefined;
  if (raw > 1e17) return undefined;
  // Below 1e11 it is a count of seconds (a duration or an epoch stamp), and
  // either way the answer is the same: it needs the 1000 multiplier.
  return raw < 1e11 ? Math.round(raw * 1000) : Math.round(raw);
}
