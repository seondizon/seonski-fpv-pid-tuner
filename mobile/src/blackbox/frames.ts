/** I/P/S/E frame decoding. Ported from SmartTune CLI's bbl_parser.py (see
 * constants.ts for attribution).
 */
import {
  ENCODING_NEG_14BIT,
  ENCODING_NULL,
  ENCODING_SIGNED_VB,
  ENCODING_TAG2_3S32,
  ENCODING_TAG2_3SVARIABLE,
  ENCODING_TAG8_4S16,
  ENCODING_TAG8_8SVB,
  ENCODING_UNSIGNED_VB,
  EVENT_FLIGHT_MODE,
  EVENT_INFLIGHT_ADJUSTMENT,
  EVENT_LOGGING_RESUME,
  EVENT_LOG_END,
  EVENT_SYNC_BEEP,
} from './constants';
import type { BlackboxHeader, FrameFieldDef } from './header';
import { applyPredictor, ValueMap } from './predictors';
import { BlackboxStreamReader } from './streamReader';

export interface BlackboxEvent {
  eventType: number;
  data: Record<string, number>;
}

function readSingleValue(reader: BlackboxStreamReader, encoding: number): number {
  switch (encoding) {
    case ENCODING_SIGNED_VB:
      return reader.readSignedVb();
    case ENCODING_UNSIGNED_VB:
      return reader.readUnsignedVb();
    case ENCODING_NEG_14BIT:
      return reader.readNeg14Bit();
    case ENCODING_NULL:
      return 0;
    default:
      // Unknown encoding: fall back to signed VB, matching the Python
      // reference's behavior.
      return reader.readSignedVb();
  }
}

/** Decodes one frame's worth of fields (I, P, or S -- they share this exact
 * multi-value-encoding-grouping logic, differing only in which "previous
 * values" and "in-progress vs. previous frame" context gets passed to the
 * predictor).
 *
 * `useInProgressAsAllPrev` mirrors the Python reference's asymmetry: I-frame
 * decoding passes its own in-progress `values` object as PREDICTOR_MOTOR_0's
 * lookup source (so a field can reference this same frame's already-decoded
 * motor[0]); P/S-frame decoding instead passes the previous frame's
 * `prevValues` for that lookup. This is intentional, not an inconsistency
 * -- see predictors.ts's applyPredictor docstring.
 */
function decodeFrameFields(
  reader: BlackboxStreamReader,
  fieldDefs: FrameFieldDef[],
  prevValues: ValueMap,
  header: BlackboxHeader,
  prevPrevValues: ValueMap | null,
  useInProgressAsAllPrev: boolean
): ValueMap {
  const values: ValueMap = {};
  const allPrev = useInProgressAsAllPrev ? values : prevValues;

  let i = 0;
  while (i < fieldDefs.length) {
    const fdef = fieldDefs[i];
    const encoding = fdef.encoding;

    if (encoding === ENCODING_TAG2_3S32 || encoding === ENCODING_TAG2_3SVARIABLE) {
      const rawValues =
        encoding === ENCODING_TAG2_3S32 ? reader.readTag2_3S32() : reader.readTag2_3SVariable();
      for (let j = 0; j < rawValues.length; j++) {
        if (i + j < fieldDefs.length) {
          const fd = fieldDefs[i + j];
          values[fd.name] = applyPredictor(
            fd.predictor,
            rawValues[j],
            prevValues,
            fd.name,
            allPrev,
            header,
            prevPrevValues
          );
        }
      }
      i += rawValues.length;
    } else if (encoding === ENCODING_TAG8_4S16) {
      const rawValues = reader.readTag8_4S16();
      for (let j = 0; j < rawValues.length; j++) {
        if (i + j < fieldDefs.length) {
          const fd = fieldDefs[i + j];
          values[fd.name] = applyPredictor(
            fd.predictor,
            rawValues[j],
            prevValues,
            fd.name,
            allPrev,
            header,
            prevPrevValues
          );
        }
      }
      i += rawValues.length;
    } else if (encoding === ENCODING_TAG8_8SVB) {
      // Consecutive same-encoding fields are decoded together from a
      // single tag byte.
      let count = 0;
      while (i + count < fieldDefs.length && fieldDefs[i + count].encoding === ENCODING_TAG8_8SVB) {
        count++;
      }
      const rawValues = reader.readTag8_8Svb(count);
      for (let j = 0; j < rawValues.length; j++) {
        if (i + j < fieldDefs.length) {
          const fd = fieldDefs[i + j];
          values[fd.name] = applyPredictor(
            fd.predictor,
            rawValues[j],
            prevValues,
            fd.name,
            allPrev,
            header,
            prevPrevValues
          );
        }
      }
      i += count;
    } else {
      const raw = readSingleValue(reader, encoding);
      values[fdef.name] = applyPredictor(
        fdef.predictor,
        raw,
        prevValues,
        fdef.name,
        allPrev,
        header,
        prevPrevValues
      );
      i += 1;
    }
  }

  return values;
}

export function decodeIFrame(
  reader: BlackboxStreamReader,
  header: BlackboxHeader,
  prevValues: ValueMap,
  prevPrevValues: ValueMap | null
): ValueMap {
  return decodeFrameFields(reader, header.iFieldDefs, prevValues, header, prevPrevValues, true);
}

export function decodePFrame(
  reader: BlackboxStreamReader,
  header: BlackboxHeader,
  prevValues: ValueMap,
  prevPrevValues: ValueMap | null
): ValueMap {
  return decodeFrameFields(reader, header.pFieldDefs, prevValues, header, prevPrevValues, false);
}

export function decodeSFrame(
  reader: BlackboxStreamReader,
  header: BlackboxHeader,
  prevSlow: ValueMap
): ValueMap {
  return decodeFrameFields(reader, header.sFieldDefs, prevSlow, header, null, false);
}

export function decodeEvent(reader: BlackboxStreamReader): BlackboxEvent {
  const eventType = reader.readUnsignedVb();
  const data: Record<string, number> = {};

  if (eventType === EVENT_SYNC_BEEP) {
    data.time = reader.readUnsignedVb();
  } else if (eventType === EVENT_FLIGHT_MODE) {
    data.flags = reader.readUnsignedVb();
    data.lastFlags = reader.readUnsignedVb();
  } else if (eventType === EVENT_INFLIGHT_ADJUSTMENT) {
    const adjFunc = reader.readUnsignedVb();
    data.function = adjFunc;
    if (adjFunc > 127) {
      const raw = reader.readBytes(4);
      data.value = new DataView(raw.buffer, raw.byteOffset, 4).getFloat32(0, true);
    } else {
      data.value = reader.readSignedVb();
    }
  } else if (eventType === EVENT_LOGGING_RESUME) {
    data.iteration = reader.readUnsignedVb();
    data.time = reader.readUnsignedVb();
  } else if (eventType === EVENT_LOG_END) {
    // End of log marker -- no fixed payload to read here.
  }
  // Other event types are intentionally not decoded (mirrors the Python
  // reference's scope).

  return { eventType, data };
}

/** Betaflight's accSmooth/gyroADC raw ADC values normally sit within
 * ±32767 (16-bit signed). A far larger value means the parser lost sync --
 * most likely it used the wrong field definitions to decode a new flight
 * segment's data (a corrupted/partial segment boundary in flash). Returns
 * true when this loss-of-sync is detected. */
export function hasCorruptedImuValues(values: ValueMap): boolean {
  for (let i = 0; i < 3; i++) {
    const acc = values[`accSmooth[${i}]`];
    if (acc !== undefined && Math.abs(acc) > 32768) return true;
    const gyro = values[`gyroADC[${i}]`];
    if (gyro !== undefined && Math.abs(gyro) > 65536) return true;
    const accData = values[`accData[${i}]`];
    if (accData !== undefined && Math.abs(accData) > 32768) return true;
  }
  return false;
}
