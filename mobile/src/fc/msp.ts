/** MSP (MultiWii Serial Protocol) v1 basics.
 *
 * Ported from backend/app/fc/msp.py. Only enough of MSP is implemented here
 * to (a) build/parse a generic MSP v1 frame and (b) decode the commands
 * needed for version detection at connect time and Blackbox dataflash
 * access. Command IDs match Betaflight's src/main/msp/msp_protocol.h.
 *
 * MSP v1 frame format (request):
 *   '$' 'M' '<' <size:u8> <command:u8> <payload bytes> <checksum:u8>
 * MSP v1 frame format (response):
 *   '$' 'M' '>' <size:u8> <command:u8> <payload bytes> <checksum:u8>
 * Error response uses '!' as the direction byte in place of '>'.
 *
 * Checksum = XOR of the size byte, the command byte, and every payload byte.
 */
import { concatBytes, asciiDecode } from './bytes';

export const MSP_API_VERSION = 1;
export const MSP_FC_VARIANT = 2;
export const MSP_FC_VERSION = 3;

// Betaflight src/main/msp/msp_protocol.h: MSP_UID = 160. Returns the STM32's
// factory-programmed 96-bit unique device ID (three 32-bit words read
// directly from the chip's UID register) -- the same value Betaflight
// Configurator uses to distinguish physical boards. Used here as the
// authoritative per-craft identity key (see paramCompat.ts's neighbor,
// controller/useTunerController.ts's craft-identity logic): unlike the
// user-editable craft name, this is stable across renames and never
// collides between two different physical FCs, which matters once someone
// is tuning more than one quad with this app.
export const MSP_UID = 160;

// Betaflight src/main/msp/msp_protocol.h: MSP_DATAFLASH_SUMMARY = 70,
// MSP_DATAFLASH_READ = 71. Used to pull a Blackbox log directly off the FC's
// onboard SPI dataflash over MSP.
export const MSP_DATAFLASH_SUMMARY = 70;
export const MSP_DATAFLASH_READ = 71;

const HEADER_0 = 0x24; // '$'
const HEADER_1 = 0x4d; // 'M'
const DIRECTION_TO_FC = 0x3c; // '<'
const DIRECTION_FROM_FC = 0x3e; // '>'
const DIRECTION_ERROR = 0x21; // '!'

function checksum(size: number, command: number, payload: Uint8Array): number {
  let chk = size ^ command;
  for (const b of payload) chk ^= b;
  return chk & 0xff;
}

export function buildMspV1Request(command: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  if (command < 0 || command > 0xff) {
    throw new Error(`MSP command must fit in a u8: ${command}`);
  }
  const size = payload.length;
  if (size > 0xff) {
    throw new Error(`MSP v1 payload too large for u8 size field: ${size} bytes`);
  }
  const chk = checksum(size, command, payload);
  const frame = new Uint8Array(5 + size + 1);
  frame[0] = HEADER_0;
  frame[1] = HEADER_1;
  frame[2] = DIRECTION_TO_FC;
  frame[3] = size;
  frame[4] = command;
  frame.set(payload, 5);
  frame[5 + size] = chk;
  return frame;
}

export interface MspResponse {
  command: number;
  payload: Uint8Array;
}

/** Parse an MSP v1 response frame from the FC, including the "jumbo frame"
 * extension used for payloads too large for the 1-byte size field (confirmed
 * via a real Betaflight FC: Betaflight Configurator's dataflash-read path
 * specifically uses jumbo frames, since the plain 255-byte cap makes chunked
 * flash reads impractically slow).
 *
 * Layout (plain): '$' 'M' '>' <size:u8, 0-254> <command:u8> <payload> <checksum:u8>
 * Layout (jumbo): '$' 'M' '>' <0xFF> <command:u8> <size:u16 LE> <payload> <checksum:u8>
 *
 * Throws on any malformed frame or checksum mismatch. */
export function parseMspV1Response(data: Uint8Array): MspResponse {
  if (data.length < 6) {
    throw new Error(`MSP frame too short: need at least 6 bytes, got ${data.length}`);
  }
  if (data[0] !== HEADER_0 || data[1] !== HEADER_1) {
    throw new Error(`MSP frame missing '$M' header`);
  }
  const direction = data[2];
  if (direction === DIRECTION_ERROR) {
    throw new Error("MSP frame indicates an FC-side error response ('$M!')");
  }
  if (direction !== DIRECTION_FROM_FC) {
    throw new Error(`MSP frame has unexpected direction byte ${direction}, expected '>'`);
  }

  const sizeByte = data[3];
  const command = data[4];

  let size: number;
  let checksumFields: number[];
  let payloadStart: number;

  if (sizeByte === 0xff) {
    if (data.length < 7) {
      throw new Error('MSP jumbo frame too short to contain its 16-bit size field');
    }
    size = data[5] | (data[6] << 8);
    checksumFields = [sizeByte, command, data[5], data[6]];
    payloadStart = 7;
  } else {
    size = sizeByte;
    checksumFields = [sizeByte, command];
    payloadStart = 5;
  }

  const expectedLen = payloadStart + size + 1;
  if (data.length < expectedLen) {
    throw new Error(
      `MSP frame truncated: declared payload size ${size} requires ${expectedLen} total bytes, got ${data.length}`
    );
  }
  const payload = data.slice(payloadStart, payloadStart + size);
  const checksumByte = data[payloadStart + size];

  let chk = 0;
  for (const b of checksumFields) chk ^= b;
  for (const b of payload) chk ^= b;
  if (checksumByte !== (chk & 0xff)) {
    throw new Error(
      `MSP checksum mismatch for command ${command}: expected 0x${(chk & 0xff).toString(16).padStart(2, '0')}, got 0x${checksumByte.toString(16).padStart(2, '0')}`
    );
  }
  return { command, payload };
}

export interface ByteReader {
  read(size: number, timeoutMs: number): Promise<Uint8Array>;
}

/** Incrementally read exactly one MSP v1 (or jumbo) frame from `transport`.
 *
 * BUG FOUND against a real FC (see transport.ts / the native module's
 * docstring): naively requesting an oversized buffer for a response that's
 * only ~20-140 bytes stalls for the full timeout on every call. This reads
 * exactly the number of bytes the MSP framing declares at each stage, so
 * each read completes as soon as its expected bytes actually arrive. */
export async function readMspV1Frame(transport: ByteReader, timeoutMs: number = 3000): Promise<Uint8Array> {
  const header = await transport.read(3, timeoutMs);
  if (header.length < 3) {
    throw new Error(`MSP frame header read timed out or was truncated (got ${header.length}/3 bytes)`);
  }
  const sizeAndCommand = await transport.read(2, timeoutMs);
  if (sizeAndCommand.length < 2) {
    throw new Error('MSP frame size/command read timed out or was truncated');
  }
  const sizeByte = sizeAndCommand[0];
  let jumboSizeBytes: Uint8Array = new Uint8Array(0);
  let realSize: number;
  if (sizeByte === 0xff) {
    jumboSizeBytes = await transport.read(2, timeoutMs);
    if (jumboSizeBytes.length < 2) {
      throw new Error('MSP jumbo frame size field read timed out or was truncated');
    }
    realSize = jumboSizeBytes[0] | (jumboSizeBytes[1] << 8);
  } else {
    realSize = sizeByte;
  }
  const rest = await transport.read(realSize + 1, timeoutMs); // payload + checksum
  if (rest.length < realSize + 1) {
    throw new Error(`MSP frame payload/checksum read timed out: expected ${realSize + 1} bytes, got ${rest.length}`);
  }
  return concatBytes([header, sizeAndCommand, jumboSizeBytes, rest]);
}

export interface MspApiVersion {
  protocolVersion: number;
  apiMajor: number;
  apiMinor: number;
}

/** Per MSP_API_VERSION response: 3 bytes - protocolVersion, major, minor. */
export function parseMspApiVersionPayload(payload: Uint8Array): MspApiVersion {
  if (payload.length < 3) {
    throw new Error(`MSP_API_VERSION payload too short: expected 3 bytes, got ${payload.length}`);
  }
  return { protocolVersion: payload[0], apiMajor: payload[1], apiMinor: payload[2] };
}

export interface FcVariant {
  identifier: string; // 4-char ASCII, e.g. "BTFL" for Betaflight
}

/** Per MSP_FC_VARIANT response: 4 raw ASCII bytes identifying the firmware
 * (e.g. "BTFL" for Betaflight, "CLFL" for Cleanflight, "INAV" for iNav). */
export function parseFcVariantPayload(payload: Uint8Array): FcVariant {
  if (payload.length < 4) {
    throw new Error(`MSP_FC_VARIANT payload too short: expected 4 bytes, got ${payload.length}`);
  }
  return { identifier: asciiDecode(payload.slice(0, 4)) };
}

export interface FcVersion {
  major: number;
  minor: number;
  patch: number;
}

/** Per MSP_FC_VERSION response, format differs by era (confirmed against
 * Betaflight's own msp.c source at tags spanning 4.2.0 through the
 * post-calver-transition releases):
 *
 * - Semver-era firmware (pre-2025.12.0): 3 bytes, `[major, minor, patch]`
 *   as literal small integers (e.g. 4, 5, 0 for "4.5.0").
 * - Calver-era firmware (2025.12.0-RC1 onward): `[yearSince2000, month,
 *   patchLevel, ...pString]` -- a 1-byte year offset (25 = 2025) followed
 *   by month and patch-level bytes, then the FULL version string as a
 *   length-prefixed ASCII string (which may carry a pre-release suffix
 *   like "-RC1" that the 3 leading integer bytes alone can't represent).
 *
 * Distinguishing the two: Betaflight Configurator itself (the reference
 * client) byte-sniffs on the first byte -- a real semver major version
 * has never reached double digits, while a calver year-since-2000 value
 * starts at 25 -- so `payload[0] < 10` reliably means "legacy 3-byte
 * format", matching the same heuristic here rather than guessing from
 * MSP_API_VERSION (which isn't correlated with the calver switch). */
export function parseFcVersionPayload(payload: Uint8Array): FcVersion {
  if (payload.length < 3) {
    throw new Error(`MSP_FC_VERSION payload too short: expected 3 bytes, got ${payload.length}`);
  }
  if (payload[0] < 10) {
    return { major: payload[0], minor: payload[1], patch: payload[2] };
  }
  // Calver era: report the actual (year, month, patchLevel) triple rather
  // than the raw year-since-2000 byte, so a caller comparing `major` against
  // a real year (e.g. 2025) gets the number they'd expect.
  return { major: 2000 + payload[0], minor: payload[1], patch: payload[2] };
}

/** Per MSP_UID response: 12 raw bytes (three 32-bit words, but this app only
 * needs a stable, unique-per-chip string -- not the individual word values
 * or Betaflight's own display formatting -- so the bytes are hex-encoded
 * directly in wire order rather than reassembled into u_id_0/1/2 integers.
 * Two different physical FCs will always produce two different strings;
 * the same physical FC always produces the same string, regardless of
 * craft name, firmware version, or how many times it's been reflashed. */
export function parseUidPayload(payload: Uint8Array): string {
  if (payload.length < 12) {
    throw new Error(`MSP_UID payload too short: expected 12 bytes, got ${payload.length}`);
  }
  let hex = '';
  for (let i = 0; i < 12; i++) hex += payload[i].toString(16).padStart(2, '0');
  return hex;
}

export interface DataflashSummary {
  ready: boolean;
  totalSizeBytes: number;
  usedSizeBytes: number;
}

/** Per Betaflight's MSP_DATAFLASH_SUMMARY reply (confirmed against a real FC
 * and cross-checked against betaflight-configurator's MSPHelper.js parsing):
 *   flags: 1 byte (bit 0 = ready, bit 1 = supported)
 *   sectors: uint32 LE   (number of erase sectors)
 *   totalSize: uint32 LE
 *   usedSize: uint32 LE
 */
export function parseDataflashSummaryPayload(payload: Uint8Array): DataflashSummary {
  if (payload.length < 13) {
    throw new Error(`MSP_DATAFLASH_SUMMARY payload too short: expected >= 13 bytes, got ${payload.length}`);
  }
  const flags = payload[0];
  const view = new DataView(payload.buffer, payload.byteOffset + 1, 12);
  const totalSize = view.getUint32(4, true);
  const usedSize = view.getUint32(8, true);
  return { ready: (flags & 0x01) !== 0, totalSizeBytes: totalSize, usedSizeBytes: usedSize };
}

/** Per Betaflight's MSP_DATAFLASH_READ: request payload is
 *   address: uint32 LE
 * Newer firmware also accepts an optional
 *   readLength: uint16 LE
 *   useLegacyFormat: uint8 (0)
 * appended, to request a specific chunk size. For maximum compatibility
 * across Betaflight versions, this builds the minimal 4-byte-address-only
 * request by default (readLength omitted). */
export function buildDataflashReadRequest(address: number, readLength?: number): Uint8Array {
  if (address < 0 || address > 0xffffffff) {
    throw new Error(`address must fit in a uint32: ${address}`);
  }
  if (readLength === undefined) {
    const buf = new Uint8Array(4);
    new DataView(buf.buffer).setUint32(0, address, true);
    return buf;
  }
  if (readLength < 0 || readLength > 0xffff) {
    throw new Error(`readLength must fit in a uint16: ${readLength}`);
  }
  const buf = new Uint8Array(7);
  const view = new DataView(buf.buffer);
  view.setUint32(0, address, true);
  view.setUint16(4, readLength, true);
  buf[6] = 0; // useLegacyFormat
  return buf;
}

export interface DataflashReadResult {
  address: number;
  data: Uint8Array;
}

/** Response payload: address (uint32 LE) followed by the raw flash bytes
 * read starting at that address. The number of bytes returned varies by
 * firmware/MSP version -- callers must use data.length, never assume a
 * fixed chunk size. */
export function parseDataflashReadPayload(payload: Uint8Array): DataflashReadResult {
  if (payload.length < 4) {
    throw new Error(`MSP_DATAFLASH_READ payload too short: expected >= 4 bytes, got ${payload.length}`);
  }
  const address = new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0, true);
  return { address, data: payload.slice(4) };
}
