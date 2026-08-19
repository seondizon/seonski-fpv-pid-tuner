/** Predictor application -- maps an I/P-frame's raw decoded value to its
 * real value using history + header-derived constants. Ported from
 * SmartTune CLI's bbl_parser.py (see constants.ts for attribution).
 */
import {
  PREDICTOR_0,
  PREDICTOR_1500,
  PREDICTOR_AVERAGE_2,
  PREDICTOR_HOME_COORD,
  PREDICTOR_INC,
  PREDICTOR_LAST_MAIN_FRAME_TIME,
  PREDICTOR_MINMOTOR,
  PREDICTOR_MINTHROTTLE,
  PREDICTOR_MOTOR_0,
  PREDICTOR_PREVIOUS,
  PREDICTOR_STRAIGHT_LINE,
  PREDICTOR_VBATREF,
} from './constants';
import type { BlackboxHeader } from './header';

export type ValueMap = Record<string, number>;

/** `allPrev` is the frame's own in-progress values dict when decoding an
 * I-frame (PREDICTOR_MOTOR_0 reads this same frame's already-decoded
 * motor[0]), or the previous frame's values when decoding a P-frame or
 * S-frame -- this asymmetry is intentional and ported unchanged from the
 * Python reference. */
export function applyPredictor(
  predictor: number,
  rawValue: number,
  prevValues: ValueMap,
  fieldName: string,
  allPrev: ValueMap,
  header: BlackboxHeader,
  prevPrevValues: ValueMap | null
): number {
  switch (predictor) {
    case PREDICTOR_0:
      return rawValue;

    case PREDICTOR_PREVIOUS:
      return rawValue + (prevValues[fieldName] ?? 0);

    case PREDICTOR_STRAIGHT_LINE: {
      // predicted = 2 * prev[n-1] - prev[n-2]
      const prevVal = prevValues[fieldName] ?? 0;
      if (prevPrevValues !== null) {
        const prevPrevVal = prevPrevValues[fieldName] ?? prevVal;
        return rawValue + 2 * prevVal - prevPrevVal;
      }
      return rawValue + prevVal;
    }

    case PREDICTOR_AVERAGE_2: {
      const prevVal = prevValues[fieldName] ?? 0;
      if (prevPrevValues !== null) {
        const prevPrevVal = prevPrevValues[fieldName] ?? prevVal;
        // Confirmed against real hardware: Betaflight's C firmware computes
        // this with truncating (toward-zero) integer division, not floor
        // division -- they differ whenever the sum is negative and odd.
        return rawValue + Math.trunc((prevVal + prevPrevVal) / 2);
      }
      return rawValue + prevVal;
    }

    case PREDICTOR_MINTHROTTLE: {
      const minthrottle = parseInt(header.properties['minthrottle'] ?? '1070', 10);
      return rawValue + minthrottle;
    }

    case PREDICTOR_MOTOR_0:
      return rawValue + (allPrev['motor[0]'] ?? 0);

    case PREDICTOR_INC:
      return (prevValues[fieldName] ?? 0) + 1 + rawValue;

    case PREDICTOR_1500:
      return rawValue + 1500;

    case PREDICTOR_VBATREF: {
      const vbatref = parseInt(header.properties['vbatref'] ?? '0', 10);
      return rawValue + vbatref;
    }

    case PREDICTOR_LAST_MAIN_FRAME_TIME:
      return rawValue + (prevValues['loopIteration'] ?? 0);

    case PREDICTOR_MINMOTOR: {
      const motorOutput = header.properties['motorOutput'] ?? '';
      let minMotor: number;
      if (motorOutput.includes(',')) {
        minMotor = parseInt(motorOutput.split(',')[0], 10) || 0;
      } else {
        minMotor = parseInt(header.properties['minthrottle'] ?? '1070', 10);
      }
      return rawValue + minMotor;
    }

    case PREDICTOR_HOME_COORD:
      // GPS home coordinate prediction is only meaningful for GPS fields,
      // which this decoder does not surface (see decoder.ts's scope note).
      return rawValue;

    default:
      return rawValue;
  }
}
