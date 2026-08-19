import { BlackboxEofError, BlackboxStreamReader } from '../streamReader';

test('reads unsigned VB single-byte values', () => {
  const reader = new BlackboxStreamReader(new Uint8Array([0x00, 0x7f]));
  expect(reader.readUnsignedVb()).toBe(0);
  expect(reader.readUnsignedVb()).toBe(127);
});

test('reads unsigned VB multi-byte values', () => {
  // 300 = 0b1_0010_1100 -> low 7 bits = 0101100 (0x2C) with continuation,
  // remaining bits = 10 (0x02)
  const reader = new BlackboxStreamReader(new Uint8Array([0xac, 0x02]));
  expect(reader.readUnsignedVb()).toBe(300);
});

test('reads unsigned VB values beyond 32 bits without precision loss', () => {
  // 5 bytes, all continuation except the last: encodes a 34-bit value.
  const reader = new BlackboxStreamReader(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x0f]));
  const expected = 0x7f + (0x7f << 7) + (0x7f << 14) + (0x7f << 21) + (0x0f * 2 ** 28);
  expect(reader.readUnsignedVb()).toBe(expected);
});

test('reads signed VB via ZigZag decoding', () => {
  // ZigZag: 0->0, 1->-1, 2->1, 3->-2, 4->2
  const reader = new BlackboxStreamReader(new Uint8Array([0, 1, 2, 3, 4]));
  expect(reader.readSignedVb()).toBe(0);
  expect(reader.readSignedVb()).toBe(-1);
  expect(reader.readSignedVb()).toBe(1);
  expect(reader.readSignedVb()).toBe(-2);
  expect(reader.readSignedVb()).toBe(2);
});

test('reads neg_14bit values', () => {
  // raw=1 (bit13 clear) -> return -1
  expect(new BlackboxStreamReader(new Uint8Array([1])).readNeg14Bit()).toBe(-1);
  // raw=8192 (0x2000, bit13 set, minimal 14-bit negative) -> sign-extends
  // to -8192, negated -> 8192
  const buf = new Uint8Array([0x80, 0x40]); // unsigned VB encoding of 8192
  expect(new BlackboxStreamReader(buf).readNeg14Bit()).toBe(8192);
});

test('reads tag2_3S32 BITS_2 (tag 0)', () => {
  // header: tag=00, val0=1, val1=-1(0b11), val2=0 -> 00_01_11_00 = 0x1C
  const reader = new BlackboxStreamReader(new Uint8Array([0b00_01_11_00]));
  expect(reader.readTag2_3S32()).toEqual([1, -1, 0]);
});

test('reads tag2_3S32 BITS_4 (tag 1)', () => {
  // header bits[7:6]=tag(1), bits[3:0]=val0(3); byte2 bits[7:4]=val1(1), bits[3:0]=val2(-2 as 0b1110)
  const header = (1 << 6) | 3;
  const byte2 = (1 << 4) | 0b1110;
  const reader = new BlackboxStreamReader(new Uint8Array([header, byte2]));
  expect(reader.readTag2_3S32()).toEqual([3, 1, -2]);
});

test('reads tag2_3S32 BITS_6 (tag 2)', () => {
  // header: tag=10, val0=5 (0b000101) -> 10_000101 = 0x85; byte2=val1=-3 (0xFD); byte3=val2=100
  const reader = new BlackboxStreamReader(new Uint8Array([0b10_000101, 0xfd, 100]));
  expect(reader.readTag2_3S32()).toEqual([5, -3, 100]);
});

test('reads tag2_3S32 BITS_32 (tag 3) with per-field widths', () => {
  // selector low 6 bits: field0 width=0(1B), field1 width=3(4B), field2 width=1(2B)
  // selector = (1<<4)|(3<<2)|0 = 0b01_11_00 = 0x1C; header = (3<<6)|0x1C = 0xDC
  const header = (3 << 6) | ((1 << 4) | (3 << 2) | 0);
  const bytes = [header, 42, /* field1: 4 bytes LE for -1000000 */ 0, 0, 0, 0, /* field2: 2 bytes LE */ 0, 0];
  const buf = new Uint8Array(bytes.length);
  buf.set(bytes);
  const view = new DataView(buf.buffer);
  view.setInt32(2, -1000000, true);
  view.setInt16(6, -5000, true);
  const reader = new BlackboxStreamReader(buf);
  expect(reader.readTag2_3S32()).toEqual([42, -1000000, -5000]);
});

test('reads tag8_4S16 with mixed field widths', () => {
  // tag bits (2 per field, field0 lowest): field0=FIELD_ZERO(00), field1=FIELD_4BIT(01),
  // field2=FIELD_8BIT(10), field3=FIELD_16BIT(11)
  // tag = (3<<6)|(2<<4)|(1<<2)|0 = 0b11_10_01_00 = 0xE4
  const tag = (3 << 6) | (2 << 4) | (1 << 2) | 0;
  // field1 (4-bit) is alone in its byte (no adjacent 4-bit field) -- the
  // first (and here only) 4-bit field in a group takes the HIGH nibble,
  // confirmed against real hardware (see streamReader.ts's readTag8_4S16
  // docstring); value=-1 -> nibble 0xF in the high position.
  const nibbleByte = 0xf0;
  // field2 (8-bit): -100 -> 0x9C
  const field2Byte = (-100) & 0xff;
  const buf = new Uint8Array([tag, nibbleByte, field2Byte, 0, 0]);
  new DataView(buf.buffer).setInt16(3, -30000, true);
  const reader = new BlackboxStreamReader(buf);
  expect(reader.readTag8_4S16()).toEqual([0, -1, -100, -30000]);
});

test('reads tag8_8SVB', () => {
  // tag: bit0=1 (read VB), bit1=0 (zero), bit2=1 (read VB)
  const tag = 0b101;
  const reader = new BlackboxStreamReader(new Uint8Array([tag, 4 /* zigzag -> 2 */, 3 /* zigzag -> -2 */]));
  expect(reader.readTag8_8Svb(3)).toEqual([2, 0, -2]);
});

test('skipToFrame finds the next recognizable frame marker', () => {
  const reader = new BlackboxStreamReader(new Uint8Array([0x00, 0x01, 0x50 /* 'P' */, 0x02]));
  expect(reader.skipToFrame()).toBe(0x50);
  expect(reader.getPos()).toBe(2);
});

test('skipToFrame returns null at end of stream', () => {
  const reader = new BlackboxStreamReader(new Uint8Array([0x00, 0x01]));
  expect(reader.skipToFrame()).toBeNull();
});

test('readLine reads up to newline and strips trailing CR', () => {
  const reader = new BlackboxStreamReader(new Uint8Array([...Buffer.from('H Product:Foo\r\n'), ...Buffer.from('next')]));
  expect(reader.readLine()).toBe('H Product:Foo');
  expect(reader.readLine()).toBe('next');
});

test('readByte throws BlackboxEofError past the end of data', () => {
  const reader = new BlackboxStreamReader(new Uint8Array([1]));
  reader.readByte();
  expect(() => reader.readByte()).toThrow(BlackboxEofError);
});
