/** BBL header parsing -- the "H " text lines preceding each segment's binary
 * frame data. Ported from SmartTune CLI's bbl_parser.py (see constants.ts
 * for attribution).
 */
import { BlackboxStreamReader } from './streamReader';

export interface FrameFieldDef {
  name: string;
  signed: number;
  predictor: number;
  encoding: number;
}

export interface BlackboxHeader {
  product: string;
  dataVersion: number;
  firmwareType: string;
  firmwareRevision: string;
  firmwareDate: string;
  boardInfo: string;
  craftName: string;
  iFieldDefs: FrameFieldDef[];
  pFieldDefs: FrameFieldDef[];
  sFieldDefs: FrameFieldDef[];
  properties: Record<string, string>;
  iInterval: number;
  pRatio: number;
}

function parseIntList(s: string): number[] {
  return s
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const n = parseInt(part, 10);
      return Number.isNaN(n) ? 0 : n;
    });
}

function buildFieldDefs(
  names: string[],
  signed: number[],
  predictor: number[],
  encoding: number[]
): FrameFieldDef[] {
  return names.map((name, i) => ({
    name,
    signed: signed[i] ?? 0,
    predictor: predictor[i] ?? 0,
    encoding: encoding[i] ?? 0,
  }));
}

/** Parses all "H " lines at the current reader position -- the header
 * region ends at the first byte that isn't the start of an "H " line (i.e.
 * the first I/P/E frame marker). Leaves the reader positioned right after
 * the last header line. */
export function parseHeader(reader: BlackboxStreamReader): BlackboxHeader {
  const properties: Record<string, string> = {};
  let product = '';
  let dataVersion = 0;
  let firmwareType = '';
  let firmwareRevision = '';
  let firmwareDate = '';
  let boardInfo = '';
  let craftName = '';
  let iInterval = 32;
  let pRatio = 1;

  let iFieldNames: string[] = [];
  let iFieldSigned: number[] = [];
  let iFieldPredictor: number[] = [];
  let iFieldEncoding: number[] = [];

  let pFieldPredictor: number[] = [];
  let pFieldEncoding: number[] = [];

  let sFieldNames: string[] = [];
  let sFieldSigned: number[] = [];
  let sFieldPredictor: number[] = [];
  let sFieldEncoding: number[] = [];

  while (reader.hasData()) {
    if (reader.peekByte() !== 0x48 /* 'H' */) break;

    const line = reader.readLine();
    if (line === null) break;
    if (!line.startsWith('H ')) continue;

    const content = line.slice(2);
    const colonIndex = content.indexOf(':');
    if (colonIndex === -1) continue;

    const key = content.slice(0, colonIndex).trim();
    const value = content.slice(colonIndex + 1).trim();
    properties[key] = value;

    switch (key) {
      case 'Product':
        product = value;
        break;
      case 'Data version':
        dataVersion = parseInt(value, 10) || 0;
        break;
      case 'Firmware type':
        firmwareType = value;
        break;
      case 'Firmware revision':
        firmwareRevision = value;
        break;
      case 'Firmware date':
        firmwareDate = value;
        break;
      case 'Board information':
        boardInfo = value;
        break;
      case 'Craft name':
        craftName = value;
        break;
      case 'I interval':
        iInterval = parseInt(value, 10) || iInterval;
        break;
      case 'P interval':
        if (value.includes('/')) {
          const parts = value.split('/');
          pRatio = parseInt(parts[1], 10) || pRatio;
        } else {
          pRatio = parseInt(value, 10) || pRatio;
        }
        break;
      case 'Field I name':
        iFieldNames = value.split(',');
        break;
      case 'Field I signed':
        iFieldSigned = parseIntList(value);
        break;
      case 'Field I predictor':
        iFieldPredictor = parseIntList(value);
        break;
      case 'Field I encoding':
        iFieldEncoding = parseIntList(value);
        break;
      case 'Field P predictor':
        pFieldPredictor = parseIntList(value);
        break;
      case 'Field P encoding':
        pFieldEncoding = parseIntList(value);
        break;
      case 'Field S name':
        sFieldNames = value.split(',');
        break;
      case 'Field S signed':
        sFieldSigned = parseIntList(value);
        break;
      case 'Field S predictor':
        sFieldPredictor = parseIntList(value);
        break;
      case 'Field S encoding':
        sFieldEncoding = parseIntList(value);
        break;
      default:
        break;
    }
  }

  // P-frame fields reuse the I-frame's names/signedness (only predictor and
  // encoding differ between the two frame types).
  const iFieldDefs = buildFieldDefs(iFieldNames, iFieldSigned, iFieldPredictor, iFieldEncoding);
  const pFieldDefs = buildFieldDefs(iFieldNames, iFieldSigned, pFieldPredictor, pFieldEncoding);
  const sFieldDefs = buildFieldDefs(sFieldNames, sFieldSigned, sFieldPredictor, sFieldEncoding);

  return {
    product,
    dataVersion,
    firmwareType,
    firmwareRevision,
    firmwareDate,
    boardInfo,
    craftName,
    iFieldDefs,
    pFieldDefs,
    sFieldDefs,
    properties,
    iInterval,
    pRatio,
  };
}
