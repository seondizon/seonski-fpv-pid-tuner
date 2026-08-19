import { BetaflightCliClient } from '../cliClient';
import { getBlackboxStorageType, getCraftName, getPidProfileIndex } from '../info';
import { FakeSerialTransport } from '../testSupport/fakeSerialTransport';

test('getCraftName parses set craft_name (modern firmware, 4.4.0+)', async () => {
  const transport = new FakeSerialTransport({ 'get craft_name': 'craft_name = Chimera7\n' });
  const client = new BetaflightCliClient(transport);
  expect(await getCraftName(client)).toBe('Chimera7');
});

test('getCraftName falls back to legacy name on pre-4.4.0 firmware', async () => {
  const transport = new FakeSerialTransport({
    'get craft_name': '###ERROR IN craft_name: INVALID NAME###\n',
    'get name': 'name = Chimera7\n',
  });
  const client = new BetaflightCliClient(transport);
  expect(await getCraftName(client)).toBe('Chimera7');
});

test('getCraftName returns null when unset', async () => {
  const transport = new FakeSerialTransport({ 'get craft_name': 'craft_name = \n' });
  const client = new BetaflightCliClient(transport);
  expect(await getCraftName(client)).toBeNull();
});

test('getCraftName returns null when neither name nor craft_name resolves', async () => {
  const transport = new FakeSerialTransport({
    'get craft_name': '###ERROR IN craft_name: INVALID NAME###\n',
    'get name': '###ERROR IN name: INVALID NAME###\n',
  });
  const client = new BetaflightCliClient(transport);
  expect(await getCraftName(client)).toBeNull();
});

test('getCraftName tolerates trailing Allowed range line', async () => {
  const transport = new FakeSerialTransport({
    'get craft_name': 'craft_name = Chimera7\nAllowed range: 0 - 16 characters\n',
  });
  const client = new BetaflightCliClient(transport);
  expect(await getCraftName(client)).toBe('Chimera7');
});

test('getBlackboxStorageType spiflash', async () => {
  const transport = new FakeSerialTransport({ 'get blackbox_device': 'blackbox_device = SPIFLASH\n' });
  const client = new BetaflightCliClient(transport);
  expect(await getBlackboxStorageType(client)).toBe('SPIFLASH');
});

test('getBlackboxStorageType sdcard', async () => {
  const transport = new FakeSerialTransport({ 'get blackbox_device': 'blackbox_device = SDCARD\n' });
  const client = new BetaflightCliClient(transport);
  expect(await getBlackboxStorageType(client)).toBe('SDCARD');
});

test('getBlackboxStorageType unparseable returns null', async () => {
  const transport = new FakeSerialTransport({ 'get blackbox_device': 'garbage\n' });
  const client = new BetaflightCliClient(transport);
  expect(await getBlackboxStorageType(client)).toBeNull();
});

test('getPidProfileIndex parses the dedicated `profile` command reply', async () => {
  const transport = new FakeSerialTransport({ profile: 'profile 2\n' });
  const client = new BetaflightCliClient(transport);
  expect(await getPidProfileIndex(client)).toBe(2);
});

test('getPidProfileIndex not found returns null', async () => {
  const transport = new FakeSerialTransport({ profile: 'no profile info here' });
  const client = new BetaflightCliClient(transport);
  expect(await getPidProfileIndex(client)).toBeNull();
});
