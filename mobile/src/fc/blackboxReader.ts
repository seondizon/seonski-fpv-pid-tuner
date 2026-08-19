/** Pull a Blackbox log directly off the FC's onboard SPI dataflash over MSP.
 *
 * Ported from backend/app/fc/blackbox_reader.py. This is a read-only
 * operation (no `set`/`save`, no config writes) -- it must be called
 * OUTSIDE CLI mode, since MSP requests are only served in the FC's normal
 * operating mode. Callers are responsible for having already exited CLI
 * mode (BetaflightCliClient.exitCli()) before calling this.
 */
import {
  ByteReader,
  MSP_DATAFLASH_READ,
  MSP_DATAFLASH_SUMMARY,
  buildDataflashReadRequest,
  buildMspV1Request,
  parseDataflashReadPayload,
  parseDataflashSummaryPayload,
  parseMspV1Response,
  readMspV1Frame,
} from './msp';
import { concatBytes } from './bytes';

// Backstop against a malformed/misbehaving FC response looping forever: at a
// generous minimum chunk of 16 bytes per read, this allows for a ~8MB flash
// dump before giving up -- comfortably above any known Betaflight SPI flash
// chip size (typically 2-16MB), used only as a safety net.
const MAX_READ_ITERATIONS = 500_000;

// Requested per-chunk size for MSP_DATAFLASH_READ, via the jumbo-frame
// extension (confirmed Betaflight Configurator itself uses jumbo frames for
// this exact command, since the plain MSP v1 255-byte payload cap makes
// chunked multi-megabyte flash reads impractically slow). 2048 bytes keeps
// well under MSP v1's 16-bit jumbo size field limit while cutting the
// round-trip count by roughly 16x.
const REQUESTED_CHUNK_SIZE = 2048;

export class BlackboxNotAvailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlackboxNotAvailableError';
  }
}

export interface MspTransport extends ByteReader {
  write(data: Uint8Array): Promise<void>;
}

async function mspRequestResponse(
  transport: MspTransport,
  command: number,
  payload: Uint8Array = new Uint8Array(0),
  timeoutMs: number = 3000
): Promise<Uint8Array> {
  await transport.write(buildMspV1Request(command, payload));
  const raw = await readMspV1Frame(transport, timeoutMs);
  const { payload: responsePayload } = parseMspV1Response(raw);
  return responsePayload;
}

export type ProgressCallback = (bytesRead: number, total: number) => void;

/** Read the full Blackbox log currently stored in the FC's SPI dataflash,
 * returning the raw bytes in the same binary format a Blackbox decoder
 * expects as input.
 *
 * Throws BlackboxNotAvailableError if the dataflash isn't ready or is empty
 * (usedSizeBytes === 0) -- callers need to distinguish "nothing to
 * download" from "download succeeded with 0 bytes". */
export async function readBlackboxFromFc(
  transport: MspTransport,
  onProgress?: ProgressCallback
): Promise<Uint8Array> {
  const summaryPayload = await mspRequestResponse(transport, MSP_DATAFLASH_SUMMARY);
  const summary = parseDataflashSummaryPayload(summaryPayload);

  if (!summary.ready) {
    throw new BlackboxNotAvailableError("FC's dataflash is not ready");
  }
  if (summary.usedSizeBytes === 0) {
    throw new BlackboxNotAvailableError("FC's dataflash has no stored Blackbox log");
  }

  const total = summary.usedSizeBytes;
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  let iterations = 0;

  while (bytesRead < total) {
    iterations += 1;
    if (iterations > MAX_READ_ITERATIONS) {
      throw new Error(
        `Dataflash read exceeded ${MAX_READ_ITERATIONS} iterations (${bytesRead}/${total} bytes read) -- aborting to avoid an infinite loop`
      );
    }

    const requestPayload = buildDataflashReadRequest(bytesRead, REQUESTED_CHUNK_SIZE);
    const responsePayload = await mspRequestResponse(transport, MSP_DATAFLASH_READ, requestPayload);
    const result = parseDataflashReadPayload(responsePayload);

    if (result.data.length === 0) {
      throw new Error(
        `FC returned 0 bytes reading dataflash at offset ${bytesRead} (expected more, total used size is ${total} bytes)`
      );
    }

    chunks.push(result.data);
    bytesRead += result.data.length;

    onProgress?.(Math.min(bytesRead, total), total);
  }

  // A response can overshoot the requested/expected end if the FC always
  // returns a fixed page size regardless of how much was actually asked for
  // -- trim to the reported usedSizeBytes so we don't hand a decoder a dump
  // padded with trailing garbage/erased-flash bytes.
  return concatBytes(chunks).subarray(0, total);
}
