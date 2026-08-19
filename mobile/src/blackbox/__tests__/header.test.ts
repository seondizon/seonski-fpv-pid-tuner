import { parseHeader } from '../header';
import { BlackboxStreamReader } from '../streamReader';

function headerBytes(lines: string[]): Uint8Array {
  const text = lines.map((l) => l + '\n').join('');
  return new Uint8Array([...text].map((c) => c.charCodeAt(0)));
}

test('parses product, firmware, and craft name fields', () => {
  const reader = new BlackboxStreamReader(
    headerBytes([
      'H Product:Blackbox flight data recorder by Nicholas Sherlock',
      'H Data version:2',
      'H Firmware type:Cleanflight',
      'H Firmware revision:Betaflight 4.5.0 (abcdef123) STM32F411',
      'H Firmware date:Dec  8 2023 12:04:40',
      'H Board information:AIRF4',
      'H Craft name:Chimera7',
      'H I interval:32',
      'H P interval:1/3',
      'H Field I name:loopIteration,time',
      'H Field I signed:0,0',
      'H Field I predictor:0,0',
      'H Field I encoding:1,1',
      'H Field P predictor:6,2',
      'H Field P encoding:9,0',
    ])
  );

  const header = parseHeader(reader);

  expect(header.product).toBe('Blackbox flight data recorder by Nicholas Sherlock');
  expect(header.dataVersion).toBe(2);
  expect(header.firmwareType).toBe('Cleanflight');
  expect(header.firmwareRevision).toBe('Betaflight 4.5.0 (abcdef123) STM32F411');
  expect(header.boardInfo).toBe('AIRF4');
  expect(header.craftName).toBe('Chimera7');
  expect(header.iInterval).toBe(32);
  expect(header.pRatio).toBe(3);
  expect(header.properties['Data version']).toBe('2');
});

test('builds I-frame and P-frame field defs, with P-frames reusing I-frame names/signedness', () => {
  const reader = new BlackboxStreamReader(
    headerBytes([
      'H Product:x',
      'H Field I name:loopIteration,time',
      'H Field I signed:0,1',
      'H Field I predictor:0,0',
      'H Field I encoding:1,1',
      'H Field P predictor:6,2',
      'H Field P encoding:9,0',
    ])
  );

  const header = parseHeader(reader);

  expect(header.iFieldDefs).toEqual([
    { name: 'loopIteration', signed: 0, predictor: 0, encoding: 1 },
    { name: 'time', signed: 1, predictor: 0, encoding: 1 },
  ]);
  expect(header.pFieldDefs).toEqual([
    { name: 'loopIteration', signed: 0, predictor: 6, encoding: 9 },
    { name: 'time', signed: 1, predictor: 2, encoding: 0 },
  ]);
});

test('parses S-frame field defs independently', () => {
  const reader = new BlackboxStreamReader(
    headerBytes([
      'H Product:x',
      'H Field I name:loopIteration',
      'H Field I signed:0',
      'H Field I predictor:0',
      'H Field I encoding:1',
      'H Field S name:flightModeFlags,stateFlags',
      'H Field S signed:0,0',
      'H Field S predictor:0,0',
      'H Field S encoding:1,1',
    ])
  );

  const header = parseHeader(reader);
  expect(header.sFieldDefs).toEqual([
    { name: 'flightModeFlags', signed: 0, predictor: 0, encoding: 1 },
    { name: 'stateFlags', signed: 0, predictor: 0, encoding: 1 },
  ]);
});

test('stops at the first non-header byte, leaving the reader positioned there', () => {
  const header = headerBytes(['H Product:x', 'H Field I name:loopIteration']);
  const frameByte = new Uint8Array([0x49, 0x00]); // 'I' frame marker + data
  const combined = new Uint8Array(header.length + frameByte.length);
  combined.set(header, 0);
  combined.set(frameByte, header.length);

  const reader = new BlackboxStreamReader(combined);
  parseHeader(reader);

  expect(reader.getPos()).toBe(header.length);
  expect(reader.peekByte()).toBe(0x49);
});
