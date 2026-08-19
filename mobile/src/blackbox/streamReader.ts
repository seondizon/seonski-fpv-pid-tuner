/** Binary stream reader for BBL/BFL data -- variable-length encodings.
 *
 * Ported from SmartTune CLI's bbl_parser.py BBLStreamReader (MIT License,
 * see constants.ts for full attribution).
 *
 * One JS-specific correctness note throughout this file: JS's `<<` and `|`
 * operators coerce both operands to signed 32-bit integers, unlike Python's
 * arbitrary-precision ints. For unsigned VB decoding (up to 35 bits) this
 * file uses multiplication instead of `<<` to stay exact. For the 4-byte
 * little-endian tagged-encoding case, JS's `<<` conveniently already
 * produces a sign-extended int32 result, so (unlike the Python original)
 * no separate ">= 0x80000000 ? subtract 2^32" step is needed there -- but
 * the 1/2/3-byte cases still need manual sign extension, since those
 * values sit in the low bits of an otherwise-positive int32.
 */

export class BlackboxEofError extends Error {
  constructor(message: string = 'Unexpected end of BBL data') {
    super(message);
    this.name = 'BlackboxEofError';
  }
}

export class BlackboxStreamReader {
  private pos: number;
  private readonly len: number;

  constructor(private readonly data: Uint8Array, offset: number = 0) {
    this.pos = offset;
    this.len = data.length;
  }

  getPos(): number {
    return this.pos;
  }

  setPos(value: number): void {
    this.pos = value;
  }

  get remaining(): number {
    return this.len - this.pos;
  }

  hasData(n: number = 1): boolean {
    return this.pos + n <= this.len;
  }

  peekByte(): number {
    if (this.pos >= this.len) throw new BlackboxEofError();
    return this.data[this.pos];
  }

  /** The byte immediately after the current position, without consuming
   * anything -- used to check for an "H " header line without committing
   * to reading past a 1-byte frame marker that happens to also be 'H'. */
  peekByteAt(offset: number): number | null {
    const p = this.pos + offset;
    if (p >= this.len) return null;
    return this.data[p];
  }

  readByte(): number {
    if (this.pos >= this.len) throw new BlackboxEofError();
    return this.data[this.pos++];
  }

  readBytes(n: number): Uint8Array {
    if (this.pos + n > this.len) throw new BlackboxEofError();
    const result = this.data.subarray(this.pos, this.pos + n);
    this.pos += n;
    return result;
  }

  /** Reads an unsigned Variable Byte value: 7 data bits per byte, MSB=1
   * means another byte follows. Up to 5 bytes (35-bit value). */
  readUnsignedVb(): number {
    let result = 0;
    let shift = 0;
    for (let i = 0; i < 5; i++) {
      const b = this.readByte();
      result += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) return result;
      shift += 7;
    }
    return result;
  }

  /** Signed Variable Byte (ZigZag-decoded unsigned VB). */
  readSignedVb(): number {
    const raw = this.readUnsignedVb();
    // ZigZag decode: even -> positive, odd -> negative.
    const half = Math.floor(raw / 2);
    return raw % 2 === 0 ? half : -half - 1;
  }

  /** neg_14bit: sign-extend a 14-bit unsigned-VB value to 32 bits, then
   * negate. */
  readNeg14Bit(): number {
    let raw = this.readUnsignedVb();
    if (raw & 0x2000) {
      // Sign-extend bit 13 upward through a 32-bit value. JS's `|` already
      // returns a signed int32 result, so this is already fully extended.
      raw = raw | ~0x3fff;
    }
    return -raw;
  }

  /** tag2_3S32: 3 signed values packed with a 2-bit tag selecting the
   * per-field width scheme. */
  readTag2_3S32(): [number, number, number] {
    const header = this.readByte();
    const tag = (header >> 6) & 0x03;

    if (tag === 0) {
      // BITS_2: 2 bits per field, packed into the header byte itself.
      let val0 = (header >> 4) & 0x03;
      let val1 = (header >> 2) & 0x03;
      let val2 = header & 0x03;
      if (val0 >= 2) val0 -= 4;
      if (val1 >= 2) val1 -= 4;
      if (val2 >= 2) val2 -= 4;
      return [val0, val1, val2];
    }

    if (tag === 1) {
      // BITS_4: header low nibble = val0, next byte = val1 (hi) | val2 (lo).
      let val0 = header & 0x0f;
      const byte2 = this.readByte();
      let val1 = (byte2 >> 4) & 0x0f;
      let val2 = byte2 & 0x0f;
      if (val0 >= 8) val0 -= 16;
      if (val1 >= 8) val1 -= 16;
      if (val2 >= 8) val2 -= 16;
      return [val0, val1, val2];
    }

    if (tag === 2) {
      // BITS_6: 6-bit val0 in the header, 8-bit val1, 8-bit val2.
      let val0 = header & 0x3f;
      if (val0 >= 32) val0 -= 64;
      const byte2 = this.readByte();
      const val1 = byte2 < 128 ? byte2 : byte2 - 256;
      const byte3 = this.readByte();
      const val2 = byte3 < 128 ? byte3 : byte3 - 256;
      return [val0, val1, val2];
    }

    // tag === 3: BITS_32 -- per-field byte width (1-4 bytes each), selector
    // packed 2 bits per field in the header's low 6 bits.
    return this.readVariableWidthTriplet(header & 0x3f);
  }

  /** tag8_4S16 (v2): 4 values, an 8-bit tag with 2 bits per field selecting
   * zero / 4-bit-nibble-packed / 8-bit / 16-bit little-endian. */
  readTag8_4S16(): [number, number, number, number] {
    const tag = this.readByte();
    const values: [number, number, number, number] = [0, 0, 0, 0];
    let nibbleBuffer = 0;
    let nibbleIndex = 0; // 0 = need to read a byte, 1 = high nibble already buffered

    for (let i = 0; i < 4; i++) {
      const fieldTag = (tag >> (i * 2)) & 0x03;
      if (fieldTag === 0) {
        values[i] = 0;
      } else if (fieldTag === 1) {
        // Confirmed against real hardware (diffed against blackbox_decode
        // on an actual FC capture): the first 4-bit field sharing a byte
        // takes the HIGH nibble, the second takes the LOW nibble -- the
        // reverse of what an earlier version of this port assumed, which
        // silently swapped adjacent small-delta field pairs (e.g.
        // rcCommand[0]/rcCommand[1]) with each other.
        let val: number;
        if (nibbleIndex === 0) {
          nibbleBuffer = this.readByte();
          val = (nibbleBuffer >> 4) & 0x0f;
          nibbleIndex = 1;
        } else {
          val = nibbleBuffer & 0x0f;
          nibbleIndex = 0;
        }
        if (val >= 8) val -= 16;
        values[i] = val;
      } else if (fieldTag === 2) {
        const raw = this.readByte();
        values[i] = raw >= 128 ? raw - 256 : raw;
      } else {
        const lo = this.readByte();
        const hi = this.readByte();
        let val = lo | (hi << 8);
        if (val >= 0x8000) val -= 0x10000;
        values[i] = val;
      }
    }
    return values;
  }

  /** tag8_8SVB: N values (up to 8), one tag byte whose bit i says whether
   * field i is a signed-VB value (1) or exactly zero (0); any fields past
   * the 8th are always read as plain signed VBs. */
  readTag8_8Svb(count: number): number[] {
    const tag = this.readByte();
    const values: number[] = [];
    for (let i = 0; i < Math.min(count, 8); i++) {
      values.push(tag & (1 << i) ? this.readSignedVb() : 0);
    }
    for (let i = 8; i < count; i++) {
      values.push(this.readSignedVb());
    }
    return values;
  }

  /** tag2_3SVARIABLE: 3 values with asymmetric bit widths depending on the
   * 2-bit tag: 2/2/2, 5/5/4, 8/7/7, or per-field variable byte width. */
  readTag2_3SVariable(): [number, number, number] {
    const header = this.readByte();
    const tag = (header >> 6) & 0x03;

    if (tag === 0) {
      // Same as tag2_3S32's BITS_2.
      let val0 = (header >> 4) & 0x03;
      let val1 = (header >> 2) & 0x03;
      let val2 = header & 0x03;
      if (val0 >= 2) val0 -= 4;
      if (val1 >= 2) val1 -= 4;
      if (val2 >= 2) val2 -= 4;
      return [val0, val1, val2];
    }

    if (tag === 1) {
      // BITS_554: 5 bits + 5 bits + 4 bits across 2 bytes.
      const byte2 = this.readByte();
      let val0 = (header >> 1) & 0x1f;
      let val1 = ((header & 0x01) << 4) | ((byte2 >> 4) & 0x0f);
      let val2 = byte2 & 0x0f;
      if (val0 >= 16) val0 -= 32;
      if (val1 >= 16) val1 -= 32;
      if (val2 >= 8) val2 -= 16;
      return [val0, val1, val2];
    }

    if (tag === 2) {
      // BITS_877: 8 bits + 7 bits + 7 bits across 3 bytes.
      const byte2 = this.readByte();
      const byte3 = this.readByte();
      let val0 = ((header & 0x3f) << 2) | ((byte2 >> 6) & 0x03);
      let val1 = ((byte2 & 0x3f) << 1) | ((byte3 >> 7) & 0x01);
      let val2 = byte3 & 0x7f;
      if (val0 >= 128) val0 -= 256;
      if (val1 >= 64) val1 -= 128;
      if (val2 >= 64) val2 -= 128;
      return [val0, val1, val2];
    }

    // tag === 3: same per-field variable byte width scheme as tag2_3S32.
    return this.readVariableWidthTriplet(header & 0x3f);
  }

  /** Shared "BITS_32"-style per-field variable byte width reader used by
   * both tag2_3S32 (tag=3) and tag2_3SVARIABLE (tag=3): 2 bits per field
   * (0=1 byte, 1=2 bytes, 2=3 bytes, 3=4 bytes), little-endian, sign
   * extended per field. */
  private readVariableWidthTriplet(selector: number): [number, number, number] {
    const values: number[] = [];
    let sel = selector;
    for (let i = 0; i < 3; i++) {
      const width = sel & 0x03;
      sel >>= 2;
      if (width === 0) {
        const b = this.readByte();
        values.push(b < 128 ? b : b - 256);
      } else if (width === 1) {
        const lo = this.readByte();
        const hi = this.readByte();
        let val = lo | (hi << 8);
        if (val >= 0x8000) val -= 0x10000;
        values.push(val);
      } else if (width === 2) {
        const b0 = this.readByte();
        const b1 = this.readByte();
        const b2 = this.readByte();
        let val = b0 | (b1 << 8) | (b2 << 16);
        if (val >= 0x800000) val -= 0x1000000;
        values.push(val);
      } else {
        const b0 = this.readByte();
        const b1 = this.readByte();
        const b2 = this.readByte();
        const b3 = this.readByte();
        // JS's `<<`/`|` already sign-extend a full 32-bit result.
        values.push(b0 | (b1 << 8) | (b2 << 16) | (b3 << 24));
      }
    }
    return [values[0], values[1], values[2]];
  }

  /** Skips forward to the next byte that looks like a frame type marker
   * (I/P/S/E/H), for corrupt-data recovery. Returns the marker byte, or
   * null if the end of the stream was reached first. */
  skipToFrame(): number | null {
    while (this.pos < this.len) {
      const b = this.data[this.pos];
      if (
        b === 0x49 /* I */ ||
        b === 0x50 /* P */ ||
        b === 0x53 /* S */ ||
        b === 0x45 /* E */ ||
        b === 0x48 /* H */
      ) {
        return b;
      }
      this.pos++;
    }
    return null;
  }

  /** Reads one line of ASCII header text up to (and consuming) a trailing
   * '\n', stripping a trailing '\r'. Returns null only at true end of
   * stream with nothing left to read. */
  readLine(): string | null {
    const start = this.pos;
    while (this.pos < this.len) {
      if (this.data[this.pos] === 0x0a) {
        const line = asciiSlice(this.data, start, this.pos);
        this.pos++;
        return line.endsWith('\r') ? line.slice(0, -1) : line;
      }
      this.pos++;
    }
    if (this.pos > start) {
      const line = asciiSlice(this.data, start, this.pos);
      return line.endsWith('\r') ? line.slice(0, -1) : line;
    }
    return null;
  }
}

function asciiSlice(data: Uint8Array, start: number, end: number): string {
  let out = '';
  for (let i = start; i < end; i++) out += String.fromCharCode(data[i]);
  return out;
}
