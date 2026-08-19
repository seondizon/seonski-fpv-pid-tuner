/** Top-level Blackbox (BBL/BFL) binary log decoder.
 *
 * Ported from SmartTune CLI's bbl_parser.py's parse_bbl_columnar (MIT
 * License, Copyright (c) 2026 Raylan LIN, see constants.ts for full
 * attribution). Produces one row per logged I/P frame per field, in time
 * order -- the same shape as `blackbox_decode`'s CSV output, which this
 * module's test suite validates against as an external oracle (never
 * embedded/linked -- see docs/research/reference-analysis.md section 1).
 *
 * Scope note: GPS/G-frame fields are not decoded (this project's tuning
 * workflow has no use for GPS data); S-frames are decoded only far enough
 * to keep P-frame history correct where a predictor references slow-frame
 * state, and are not included in the returned columns.
 */
import { FRAME_TYPE_E, FRAME_TYPE_H, FRAME_TYPE_I, FRAME_TYPE_P, FRAME_TYPE_S } from './constants';
import { decodeEvent, decodeIFrame, decodePFrame, decodeSFrame, hasCorruptedImuValues, BlackboxEvent } from './frames';
import { BlackboxHeader, parseHeader } from './header';
import { BlackboxStreamReader } from './streamReader';

const MAX_FRAMES_PER_SEGMENT = 500_000;
const MAX_CONSECUTIVE_CORRUPT_FRAMES = 5;

export interface BlackboxSegment {
  header: BlackboxHeader;
  fieldNames: string[];
  columns: Record<string, number[]>;
  frameTypes: Uint8Array; // FRAME_TYPE_I or FRAME_TYPE_P per row
  frameCount: number;
  events: BlackboxEvent[];
}

function looksLikeHeaderLine(reader: BlackboxStreamReader): boolean {
  return reader.peekByteAt(1) === 0x20 /* ' ' */;
}

/** True if the reader is positioned at a genuine new-segment "H Product:"
 * header line (not just a coincidental 'H' byte inside frame data), without
 * consuming anything on a false read. */
function atNewSegmentHeader(reader: BlackboxStreamReader): boolean {
  if (reader.peekByte() !== FRAME_TYPE_H) return false;
  if (!reader.hasData(2) || !looksLikeHeaderLine(reader)) return false;
  const savePos = reader.getPos();
  const line = reader.readLine();
  reader.setPos(savePos);
  return line !== null && line.includes('H Product:');
}

/** Decodes every parseable segment in `data`. A BBL file can contain
 * multiple flight recordings (segments), each starting with its own
 * "H Product:" header -- the FC's SPI dataflash is a circular buffer, so a
 * single download commonly contains many past flights. */
export function decodeBlackboxLog(data: Uint8Array, maxSegments: number = Infinity): BlackboxSegment[] {
  const segments: BlackboxSegment[] = [];
  const reader = new BlackboxStreamReader(data);

  while (reader.hasData() && segments.length < maxSegments) {
    if (!findNextSegmentStart(reader)) break;

    const header = parseHeader(reader);
    if (header.iFieldDefs.length === 0) {
      // No I-frame field definitions parsed -- header itself is
      // incomplete/corrupted (e.g. the segment was partially overwritten
      // in flash). Nothing usable to decode; move on rather than throwing,
      // matching blackbox_decode's own "missing field name definitions"
      // handling for the same real-world condition.
      continue;
    }

    const fieldNames = header.iFieldDefs.map((f) => f.name);
    const columns: Record<string, number[]> = {};
    for (const name of fieldNames) columns[name] = [];
    const frameTypes: number[] = [];
    const events: BlackboxEvent[] = [];

    let prevValues: Record<string, number> = {};
    let prevPrevValues: Record<string, number> | null = null;
    let prevSlow: Record<string, number> = {};
    let frameCount = 0;
    let consecutiveCorruptFrames = 0;

    while (reader.hasData() && frameCount < MAX_FRAMES_PER_SEGMENT) {
      if (reader.peekByte() === FRAME_TYPE_H) {
        if (reader.hasData(2) && looksLikeHeaderLine(reader)) {
          if (atNewSegmentHeader(reader)) break;
          // A supplementary header line embedded mid-stream -- consume and
          // move on rather than trying to reparse it as frame data.
          reader.readLine();
          continue;
        }
        // A 0x48 byte that isn't followed by a space is frame data that
        // happens to coincide with 'H' -- fall through to normal decoding.
      }

      const frameMarker = reader.readByte();

      try {
        if (frameMarker === FRAME_TYPE_I) {
          const values = decodeIFrame(reader, header, prevValues, prevPrevValues);
          // Reset history so the first P-frame after this I-frame predicts
          // via STRAIGHT_LINE as 2*prev - prev == prev (equivalent to
          // PREDICTOR_PREVIOUS), matching the real decoder's behavior of
          // resetting frame history on every I-frame.
          prevPrevValues = { ...values };
          prevValues = { ...values };

          if (hasCorruptedImuValues(values)) {
            consecutiveCorruptFrames++;
            if (consecutiveCorruptFrames >= MAX_CONSECUTIVE_CORRUPT_FRAMES) break;
            continue;
          }
          consecutiveCorruptFrames = 0;

          for (const name of fieldNames) columns[name].push(values[name] ?? 0);
          frameTypes.push(FRAME_TYPE_I);
          frameCount++;
        } else if (frameMarker === FRAME_TYPE_P) {
          if (Object.keys(prevValues).length === 0) {
            if (reader.skipToFrame() === null) break;
            continue;
          }
          const values = decodePFrame(reader, header, prevValues, prevPrevValues);
          prevPrevValues = { ...prevValues };
          prevValues = { ...values };

          for (const name of fieldNames) columns[name].push(values[name] ?? 0);
          frameTypes.push(FRAME_TYPE_P);
          frameCount++;
        } else if (frameMarker === FRAME_TYPE_S) {
          prevSlow = decodeSFrame(reader, header, prevSlow);
        } else if (frameMarker === FRAME_TYPE_E) {
          events.push(decodeEvent(reader));
        } else {
          if (reader.skipToFrame() === null) break;
        }
      } catch {
        // Malformed frame (truncated stream, bad encoding for this
        // position, etc.) -- attempt to resynchronize on the next
        // recognizable frame marker rather than aborting the whole segment.
        if (reader.skipToFrame() === null) break;
      }
    }

    segments.push({
      header,
      fieldNames,
      columns,
      frameTypes: Uint8Array.from(frameTypes),
      frameCount,
      events,
    });
  }

  return segments;
}

/** Advances the reader to the start of the next "H Product:" line, or
 * returns false (reader left at end of data) if none remains. */
function findNextSegmentStart(reader: BlackboxStreamReader): boolean {
  while (reader.hasData()) {
    if (reader.peekByte() === FRAME_TYPE_H) {
      const savePos = reader.getPos();
      const line = reader.readLine();
      if (line !== null && line.includes('H Product:')) {
        reader.setPos(savePos);
        return true;
      }
    } else {
      reader.setPos(reader.getPos() + 1);
    }
  }
  return false;
}
