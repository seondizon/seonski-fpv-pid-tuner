/** Betaflight Blackbox (BBL/BFL) binary log format constants.
 *
 * Ported from SmartTune CLI's bbl_parser.py (MIT License, Copyright (c)
 * 2026 Raylan LIN, https://github.com/raylanlin/smarttune-cli), per
 * docs/research/licenses.md's clearance for direct reuse/adaptation with
 * attribution -- see ../../THIRD_PARTY_NOTICES.md for the full license
 * text. This is a clean-room TypeScript port, not a translation of
 * Betaflight's own GPL-3.0 blackbox-tools -- see
 * docs/research/reference-analysis.md section 1 for why that source is off
 * limits.
 *
 * Field/frame/predictor/encoding scheme cross-referenced against
 * betaflight/blackbox-log-viewer and betaflight/betaflight's
 * src/main/blackbox/blackbox.c for terminology only (not code).
 */

// Frame type marker bytes (ASCII).
export const FRAME_TYPE_I = 0x49; // 'I' -- keyframe, complete values
export const FRAME_TYPE_P = 0x50; // 'P' -- delta frame, relative to previous I/P frame
export const FRAME_TYPE_S = 0x53; // 'S' -- slow frame (GPS etc., low frequency)
export const FRAME_TYPE_E = 0x45; // 'E' -- event frame (flight mode changes etc.)
export const FRAME_TYPE_H = 0x48; // 'H' -- header line (also appears mid-stream)

// Event types (from the E-frame's own leading unsigned-VB byte).
export const EVENT_SYNC_BEEP = 0;
export const EVENT_INFLIGHT_ADJUSTMENT = 13;
export const EVENT_LOGGING_RESUME = 14;
export const EVENT_FLIGHT_MODE = 30;
export const EVENT_LOG_END = 255;

// Predictor types -- how an I-frame's raw decoded value maps to its real value.
export const PREDICTOR_0 = 0; // no prediction, value as-is
export const PREDICTOR_PREVIOUS = 1; // previous frame's value
export const PREDICTOR_STRAIGHT_LINE = 2; // linear extrapolation: 2*prev - prevPrev
export const PREDICTOR_AVERAGE_2 = 3; // (prev + prevPrev) / 2
export const PREDICTOR_MINTHROTTLE = 4; // header's minthrottle value
export const PREDICTOR_MOTOR_0 = 5; // this frame's motor[0] value
export const PREDICTOR_INC = 6; // previous value + 1
export const PREDICTOR_HOME_COORD = 7; // GPS home coordinate
export const PREDICTOR_1500 = 8; // constant 1500
export const PREDICTOR_VBATREF = 9; // header's vbatref value
export const PREDICTOR_LAST_MAIN_FRAME_TIME = 10; // previous frame's loopIteration
export const PREDICTOR_MINMOTOR = 11; // header's motorOutput low value (DShot/digital protocols)

// Encoding types -- how to read a raw value off the bit/byte stream.
export const ENCODING_SIGNED_VB = 0;
export const ENCODING_UNSIGNED_VB = 1;
export const ENCODING_NEG_14BIT = 3;
export const ENCODING_TAG8_8SVB = 6;
export const ENCODING_TAG2_3S32 = 7;
export const ENCODING_TAG8_4S16 = 8;
export const ENCODING_NULL = 9;
export const ENCODING_TAG2_3SVARIABLE = 10;

// Betaflight flight-mode flag bits (from BF's runtime_config.h flightModeFlags_e).
export const BF_MODE_FLAGS: Record<number, string> = {
  0: 'ARM',
  1: 'ANGLE',
  2: 'HORIZON',
  3: 'MAG',
  5: 'HEADFREE',
  6: 'HEADADJ',
  10: 'GPS_HOME',
  11: 'GPS_HOLD',
  12: 'PASSTHRU',
  15: 'FAILSAFE',
  19: 'AIR',
  28: '3D',
  36: 'TURTLE',
};
