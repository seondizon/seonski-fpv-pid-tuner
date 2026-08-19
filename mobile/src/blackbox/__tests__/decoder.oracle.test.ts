/** Validates decodeBlackboxLog against a real-hardware sample, using the
 * real `blackbox_decode` binary's own CSV output as an external oracle
 * (never embedded/linked into this repo -- see
 * docs/research/reference-analysis.md section 1).
 *
 * fixtures/segment19_small.bbl is a 30KB prefix of one real flight segment
 * pulled from a genuine 16MB Blackbox SPI-flash download over USB-OTG
 * against a real Betaflight 4.5.0 FC (STM32F411) -- see mobile's Phase 1
 * validation screen. The full flash dump contains many flights, and (like
 * most real SPI-flash Blackbox dumps) has real multi-frame gaps that
 * blackbox_decode detects via its own (GPL, uncopied) resync heuristics
 * this project deliberately does not try to reverse-engineer. This fixture
 * is truncated to the clean prefix that precedes any such gap in its
 * source segment, so it validates exact value parity across every logged
 * field -- proof the frame/predictor/encoding scheme itself decodes
 * correctly, which is the part actually worth pinning in a regression test.
 *
 * fixtures/segment19_small_raw.csv was generated once via:
 *   blackbox_decode --unit-rotation raw --unit-acceleration raw \
 *     --unit-vbat raw --unit-amperage raw --unit-flags raw \
 *     --unit-frame-time us --stdout segment19.bbl
 * (all-raw units, to compare directly against this decoder's unconverted
 * output) and is captured DATA describing real flight telemetry, not
 * GPL software -- distributing it carries no GPL obligation.
 *
 * This exact process caught two real bugs in the MIT-licensed reference
 * this module was ported from (SmartTune CLI's bbl_parser.py, itself
 * flagged by its own author as "not yet cross-validated"): tag8_4S16's
 * nibble-packing order was reversed, and PREDICTOR_AVERAGE_2 used floor
 * division instead of the C firmware's truncating division. Both are
 * fixed in streamReader.ts / predictors.ts respectively.
 */
import * as fs from 'fs';
import * as path from 'path';
import { decodeBlackboxLog } from '../decoder';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');

function parseOracleCsv(filePath: string): { columns: string[]; rows: number[][] } {
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split('\n').filter((l) => l.length > 0);
  const columns = lines[0].split(',').map((c) => c.trim());
  const rows = lines.slice(1).map((line) => line.split(',').map((v) => Number(v.trim())));
  return { columns, rows };
}

test('decodeBlackboxLog matches the real blackbox_decode oracle field-for-field', () => {
  const raw = fs.readFileSync(path.join(FIXTURE_DIR, 'segment19_small.bbl'));
  const data = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);

  const segments = decodeBlackboxLog(data);
  expect(segments.length).toBeGreaterThanOrEqual(1);
  const segment = segments[0];

  expect(segment.header.product).toBe('Blackbox flight data recorder by Nicholas Sherlock');
  // "Firmware type" is a legacy field Betaflight hardcodes to "Cleanflight"
  // for historical compatibility -- actual firmware identity lives in
  // "Firmware revision" instead.
  expect(segment.header.firmwareRevision).toContain('Betaflight 4.5.0');

  const oracle = parseOracleCsv(path.join(FIXTURE_DIR, 'segment19_small_raw.csv'));
  const oracleColNames = oracle.columns.map((c) => c.replace(/\s*\([^)]*\)\s*$/, ''));

  expect(segment.frameCount).toBeGreaterThanOrEqual(oracle.rows.length);

  const mismatches: string[] = [];
  for (const fieldName of segment.fieldNames) {
    const oracleIdx = oracleColNames.indexOf(fieldName);
    if (oracleIdx === -1) {
      mismatches.push(`field ${fieldName}: not present in oracle CSV`);
      continue;
    }
    const ours = segment.columns[fieldName];
    for (let row = 0; row < oracle.rows.length; row++) {
      const expected = oracle.rows[row][oracleIdx];
      const actual = ours[row];
      if (expected !== actual) {
        mismatches.push(`field ${fieldName} row ${row}: expected ${expected}, got ${actual}`);
      }
    }
  }

  expect(mismatches).toEqual([]);
});
