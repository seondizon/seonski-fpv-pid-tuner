import { BlackboxNotAvailableError, readBlackboxFromFc } from '../blackboxReader';
import { MSP_DATAFLASH_READ, MSP_DATAFLASH_SUMMARY } from '../msp';

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

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Understands raw MSP v1 request frames and returns scripted binary
 * responses -- mirrors the Python reference's FakeMspTransport in
 * test_blackbox_reader.py, including serving from an internal buffer a few
 * bytes at a time so the real incremental readMspV1Frame code path (header,
 * size/command, payload as separate reads) is actually exercised. */
class FakeMspTransport {
  protected buffer: Uint8Array = new Uint8Array(0);
  readRequests: number[] = [];

  constructor(
    private totalSize: number,
    private usedSize: number,
    private flashData: Uint8Array,
    private chunkSize: number,
    private ready: boolean = true
  ) {}

  async write(data: Uint8Array): Promise<void> {
    if (!(data[0] === 0x24 && data[1] === 0x4d && data[2] === 0x3c)) {
      throw new Error('expected an MSP v1 request frame ($M<)');
    }
    const command = data[4];
    const size = data[3];
    const payload = data.slice(5, 5 + size);

    if (command === MSP_DATAFLASH_SUMMARY) {
      const flags = this.ready ? 0x01 : 0x00;
      const responsePayload = new Uint8Array(13);
      responsePayload[0] = flags;
      const view = new DataView(responsePayload.buffer);
      view.setUint32(1, 1, true);
      view.setUint32(5, this.totalSize, true);
      view.setUint32(9, this.usedSize, true);
      this.buffer = concat([this.buffer, buildResponseFrame(MSP_DATAFLASH_SUMMARY, responsePayload)]);
    } else if (command === MSP_DATAFLASH_READ) {
      const address = new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0, true);
      this.readRequests.push(address);
      const chunk = this.flashData.slice(address, address + this.chunkSize);
      const responsePayload = new Uint8Array(4 + chunk.length);
      new DataView(responsePayload.buffer).setUint32(0, address, true);
      responsePayload.set(chunk, 4);
      this.buffer = concat([this.buffer, buildResponseFrame(MSP_DATAFLASH_READ, responsePayload)]);
    } else {
      throw new Error(`unexpected MSP command in test: ${command}`);
    }
  }

  async read(size: number, _timeoutMs?: number): Promise<Uint8Array> {
    const chunk = this.buffer.slice(0, size);
    this.buffer = this.buffer.slice(size);
    return chunk;
  }
}

class StuckTransport extends FakeMspTransport {
  async write(data: Uint8Array): Promise<void> {
    const command = data[4];
    if (command === MSP_DATAFLASH_READ) {
      const payload = new Uint8Array(4);
      new DataView(payload.buffer).setUint32(0, 0, true);
      this.buffer = concat([this.buffer, buildResponseFrame(MSP_DATAFLASH_READ, payload)]);
    } else {
      await super.write(data);
    }
  }
}

test('assembles chunks in order', async () => {
  const flashData = new Uint8Array(1024);
  for (let i = 0; i < flashData.length; i++) flashData[i] = i % 256;
  const transport = new FakeMspTransport(4096, flashData.length, flashData, 100);

  const result = await readBlackboxFromFc(transport);

  expect(result).toEqual(flashData);
  expect(transport.readRequests[0]).toBe(0);
  expect(transport.readRequests[1]).toBe(100);
});

test('reports progress monotonically', async () => {
  const flashData = new Uint8Array(250).fill('x'.charCodeAt(0));
  const transport = new FakeMspTransport(1000, flashData.length, flashData, 100);

  const progressCalls: Array<[number, number]> = [];
  const result = await readBlackboxFromFc(transport, (done, total) => progressCalls.push([done, total]));

  expect(result).toEqual(flashData);
  expect(progressCalls[progressCalls.length - 1]).toEqual([250, 250]);
  expect(progressCalls.every(([, total]) => total === 250)).toBe(true);
  const doneValues = progressCalls.map(([done]) => done);
  expect(doneValues).toEqual([...doneValues].sort((a, b) => a - b));
});

test('trims overshoot from the last chunk', async () => {
  // chunk_size doesn't evenly divide used_size, and the fake overshoots by
  // serving flash_data past used_size on the final read -- result must be
  // trimmed to exactly used_size, not padded with the overshoot bytes.
  const flashData = concat([new Uint8Array(90).fill('A'.charCodeAt(0)), new Uint8Array(20).fill('B'.charCodeAt(0))]);
  const transport = new FakeMspTransport(1000, 90, flashData, 40);

  const result = await readBlackboxFromFc(transport);
  expect(result).toEqual(new Uint8Array(90).fill('A'.charCodeAt(0)));
  expect([...result].some((b) => b === 'B'.charCodeAt(0))).toBe(false);
});

test('not ready throws BlackboxNotAvailableError', async () => {
  const transport = new FakeMspTransport(1000, 500, new Uint8Array(500).fill(1), 100, false);
  await expect(readBlackboxFromFc(transport)).rejects.toBeInstanceOf(BlackboxNotAvailableError);
});

test('empty dataflash throws BlackboxNotAvailableError', async () => {
  const transport = new FakeMspTransport(1000, 0, new Uint8Array(0), 100);
  await expect(readBlackboxFromFc(transport)).rejects.toBeInstanceOf(BlackboxNotAvailableError);
});

test('zero-byte response raises rather than hangs', async () => {
  const transport = new StuckTransport(1000, 500, new Uint8Array(500).fill(1), 100);
  await expect(readBlackboxFromFc(transport)).rejects.toThrow(/0 bytes/);
});

test('uses jumbo chunks and the real chunk size', async () => {
  // Regression test: readBlackboxFromFc requests large (>254-byte) chunks
  // via the MSP jumbo-frame extension.
  const flashData = new Uint8Array(5000);
  for (let i = 0; i < flashData.length; i++) flashData[i] = i % 256;
  const transport = new FakeMspTransport(100_000, flashData.length, flashData, 2048);

  const result = await readBlackboxFromFc(transport);

  expect(result).toEqual(flashData);
  // 5000 bytes at 2048/chunk needs 3 requests (2048, 2048, 904), not 40+
  // requests the way a 128-byte-chunk assumption would have needed.
  expect(transport.readRequests).toHaveLength(3);
});
