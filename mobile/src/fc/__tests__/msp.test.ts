import {
  MSP_API_VERSION,
  MSP_DATAFLASH_READ,
  MSP_DATAFLASH_SUMMARY,
  MSP_FC_VARIANT,
  MSP_FC_VERSION,
  buildDataflashReadRequest,
  buildMspV1Request,
  parseDataflashReadPayload,
  parseDataflashSummaryPayload,
  parseFcVariantPayload,
  parseFcVersionPayload,
  parseMspApiVersionPayload,
  parseMspV1Response,
  parseUidPayload,
  readMspV1Frame,
} from '../msp';

function buildResponseFrame(command: number, payload: Uint8Array): Uint8Array {
  const size = payload.length;
  if (size <= 254) {
    let checksum = size ^ command;
    for (const b of payload) checksum ^= b;
    return new Uint8Array([0x24, 0x4d, 0x3e, size, command, ...payload, checksum & 0xff]);
  }
  const sizeLo = size & 0xff;
  const sizeHi = (size >> 8) & 0xff;
  let checksum = 0xff ^ command ^ sizeLo ^ sizeHi;
  for (const b of payload) checksum ^= b;
  return new Uint8Array([0x24, 0x4d, 0x3e, 0xff, command, sizeLo, sizeHi, ...payload, checksum & 0xff]);
}

function ascii(s: string): Uint8Array {
  return new Uint8Array([...s].map((c) => c.charCodeAt(0)));
}

test('MSP v1 request frame structure', () => {
  const frame = buildMspV1Request(MSP_API_VERSION, new Uint8Array(0));
  expect([frame[0], frame[1], frame[2]]).toEqual([0x24, 0x4d, 0x3c]); // '$M<'
  expect(frame[3]).toBe(0); // size
  expect(frame[4]).toBe(MSP_API_VERSION);
  expect(frame[5]).toBe(1); // checksum of size=0, command=1 => 0^1=1
});

test('MSP v1 roundtrip with no payload', () => {
  const request = buildMspV1Request(MSP_FC_VARIANT);
  expect(request).toEqual(new Uint8Array([0x24, 0x4d, 0x3c, 0, MSP_FC_VARIANT, 0 ^ MSP_FC_VARIANT]));

  const response = buildResponseFrame(MSP_FC_VARIANT, ascii('BTFL'));
  const { command, payload } = parseMspV1Response(response);
  expect(command).toBe(MSP_FC_VARIANT);
  expect(payload).toEqual(ascii('BTFL'));

  const variant = parseFcVariantPayload(payload);
  expect(variant).toEqual({ identifier: 'BTFL' });
});

test('MSP v1 roundtrip with payload', () => {
  const request = buildMspV1Request(0x10, new Uint8Array([0x01, 0x02, 0x03]));
  const expectedChecksum = 3 ^ 0x10 ^ 0x01 ^ 0x02 ^ 0x03;
  expect(request[request.length - 1]).toBe(expectedChecksum);

  const response = buildResponseFrame(MSP_FC_VERSION, new Uint8Array([4, 5, 0]));
  const { command, payload } = parseMspV1Response(response);
  expect(command).toBe(MSP_FC_VERSION);
  expect(parseFcVersionPayload(payload)).toEqual({ major: 4, minor: 5, patch: 0 });
});

test('parseFcVersionPayload reads calver-era firmware (2025.12.1) by its year-since-2000 byte', () => {
  // Real calver payloads also carry a trailing pString version string
  // (length byte + chars) that this parser doesn't need for major/minor/
  // patch extraction -- only the leading 3 bytes matter here.
  const payload = new Uint8Array([25, 12, 1, 9, ...Array.from('2025.12.1', (c) => c.charCodeAt(0))]);
  expect(parseFcVersionPayload(payload)).toEqual({ major: 2025, minor: 12, patch: 1 });
});

test('parseUidPayload hex-encodes the 12-byte factory UID, stable per chip', () => {
  const payload = new Uint8Array([0x00, 0x1a, 0x00, 0x2b, 0x30, 0x03, 0x50, 0x45, 0xff, 0x00, 0xab, 0xcd]);
  expect(parseUidPayload(payload)).toBe('001a002b30035045ff00abcd');
});

test('parseUidPayload produces different strings for different chips', () => {
  const a = parseUidPayload(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
  const b = parseUidPayload(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13]));
  expect(a).not.toBe(b);
});

test('parseUidPayload throws on a too-short payload rather than returning a bogus id', () => {
  expect(() => parseUidPayload(new Uint8Array([1, 2, 3]))).toThrow();
});

test('MSP_API_VERSION payload parses', () => {
  const response = buildResponseFrame(MSP_API_VERSION, new Uint8Array([2, 1, 45]));
  const { command, payload } = parseMspV1Response(response);
  expect(command).toBe(MSP_API_VERSION);
  expect(parseMspApiVersionPayload(payload)).toEqual({ protocolVersion: 2, apiMajor: 1, apiMinor: 45 });
});

test('MSP v1 corrupted checksum throws', () => {
  const goodFrame = buildResponseFrame(MSP_FC_VARIANT, ascii('BTFL'));
  const corrupted = new Uint8Array(goodFrame);
  corrupted[corrupted.length - 1] ^= 0xff;
  expect(() => parseMspV1Response(corrupted)).toThrow(/checksum/);
});

test('MSP v1 malformed header throws', () => {
  expect(() => parseMspV1Response(new Uint8Array([0x58, 0x58, 0x3e, 0, 1, 1]))).toThrow();
});

test('MSP v1 truncated frame throws', () => {
  expect(() => parseMspV1Response(new Uint8Array([0x24, 0x4d, 0x3e]))).toThrow();
});

// ---------------------------------------------------------------------------
// Blackbox dataflash commands
// ---------------------------------------------------------------------------

test('dataflash summary payload parses ready with sizes', () => {
  const buf = new Uint8Array(13);
  buf[0] = 0x01;
  new DataView(buf.buffer).setUint32(1, 32, true);
  new DataView(buf.buffer).setUint32(5, 2 * 1024 * 1024, true);
  new DataView(buf.buffer).setUint32(9, 123456, true);
  expect(parseDataflashSummaryPayload(buf)).toEqual({
    ready: true,
    totalSizeBytes: 2 * 1024 * 1024,
    usedSizeBytes: 123456,
  });
});

test('dataflash summary payload matches real hardware capture', () => {
  // 16MB flash, 256 sectors -- regression test for the field-offset bug
  // (missing `sectors` field shifted totalSize/usedSize by 4 bytes).
  const payload = new Uint8Array([0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01]);
  const summary = parseDataflashSummaryPayload(payload);
  expect(summary.ready).toBe(true);
  expect(summary.totalSizeBytes).toBe(16 * 1024 * 1024);
  expect(summary.usedSizeBytes).toBe(16 * 1024 * 1024);
});

test('dataflash summary payload not ready', () => {
  const buf = new Uint8Array(13);
  buf[0] = 0x00;
  new DataView(buf.buffer).setUint32(1, 32, true);
  new DataView(buf.buffer).setUint32(5, 2 * 1024 * 1024, true);
  new DataView(buf.buffer).setUint32(9, 0, true);
  const summary = parseDataflashSummaryPayload(buf);
  expect(summary.ready).toBe(false);
  expect(summary.usedSizeBytes).toBe(0);
});

test('dataflash summary payload tolerates extra trailing bytes', () => {
  const buf = new Uint8Array(16);
  buf[0] = 0x01;
  new DataView(buf.buffer).setUint32(1, 4, true);
  new DataView(buf.buffer).setUint32(5, 100, true);
  new DataView(buf.buffer).setUint32(9, 50, true);
  buf.set([1, 2, 3], 13);
  const summary = parseDataflashSummaryPayload(buf);
  expect(summary.totalSizeBytes).toBe(100);
  expect(summary.usedSizeBytes).toBe(50);
});

test('dataflash summary payload too short throws', () => {
  expect(() => parseDataflashSummaryPayload(new Uint8Array([0x01, 0x02]))).toThrow();
});

test('build dataflash read request, address only', () => {
  const request = buildDataflashReadRequest(4096);
  const expected = new Uint8Array(4);
  new DataView(expected.buffer).setUint32(0, 4096, true);
  expect(request).toEqual(expected);
});

test('build dataflash read request with length', () => {
  const request = buildDataflashReadRequest(0, 512);
  const expected = new Uint8Array(7);
  const view = new DataView(expected.buffer);
  view.setUint32(0, 0, true);
  view.setUint16(4, 512, true);
  expected[6] = 0;
  expect(request).toEqual(expected);
});

test('dataflash read roundtrip via MSP frame', () => {
  const request = buildDataflashReadRequest(1024);
  const frame = buildMspV1Request(MSP_DATAFLASH_READ, request);
  expect(frame[4]).toBe(MSP_DATAFLASH_READ);

  const responsePayload = new Uint8Array(8);
  new DataView(responsePayload.buffer).setUint32(0, 1024, true);
  responsePayload.set([0xde, 0xad, 0xbe, 0xef], 4);
  const response = buildResponseFrame(MSP_DATAFLASH_READ, responsePayload);
  const { command, payload } = parseMspV1Response(response);
  expect(command).toBe(MSP_DATAFLASH_READ);

  const result = parseDataflashReadPayload(payload);
  expect(result.address).toBe(1024);
  expect(result.data).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
});

test('dataflash read payload too short throws', () => {
  expect(() => parseDataflashReadPayload(new Uint8Array([0x01, 0x02]))).toThrow();
});

// ---------------------------------------------------------------------------
// readMspV1Frame (incremental reader)
// ---------------------------------------------------------------------------

class BufferedFakeTransport {
  private buffer: Uint8Array;
  readCalls: number[] = [];

  constructor(data: Uint8Array) {
    this.buffer = data;
  }

  async read(size: number, _timeoutMs?: number): Promise<Uint8Array> {
    this.readCalls.push(size);
    const chunk = this.buffer.slice(0, size);
    this.buffer = this.buffer.slice(size);
    return chunk;
  }
}

test('readMspV1Frame plain reads exact sizes, never oversized', async () => {
  const frame = buildResponseFrame(MSP_FC_VARIANT, ascii('BTFL'));
  const transport = new BufferedFakeTransport(frame);

  const result = await readMspV1Frame(transport);

  expect(result).toEqual(frame);
  expect(transport.readCalls).toEqual([3, 2, 5]); // header(3), size+command(2), payload+checksum(4+1)
  expect(Math.max(...transport.readCalls)).toBeLessThan(4096);
});

test('readMspV1Frame jumbo reads extra size field', async () => {
  const payload = new Uint8Array(300).fill('x'.charCodeAt(0));
  const frame = buildResponseFrame(MSP_DATAFLASH_READ, payload);
  const transport = new BufferedFakeTransport(frame);

  const result = await readMspV1Frame(transport);

  expect(result).toEqual(frame);
  const { command, payload: parsedPayload } = parseMspV1Response(result);
  expect(command).toBe(MSP_DATAFLASH_READ);
  expect(parsedPayload).toEqual(payload);
});

test('readMspV1Frame throws on truncated header', async () => {
  const transport = new BufferedFakeTransport(new Uint8Array([0x24, 0x4d])); // only 2 of 3 header bytes
  await expect(readMspV1Frame(transport)).rejects.toThrow(/header/);
});

test('readMspV1Frame throws on truncated payload', async () => {
  const frame = buildResponseFrame(MSP_FC_VARIANT, ascii('BTFL'));
  const transport = new BufferedFakeTransport(frame.slice(0, frame.length - 2));
  await expect(readMspV1Frame(transport)).rejects.toThrow(/payload\/checksum/);
});
