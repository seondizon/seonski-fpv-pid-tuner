jest.mock('../../../modules/usb-serial/src/UsbSerialModule', () => ({
  __esModule: true,
  default: {
    hasPermission: jest.fn(),
    requestPermission: jest.fn(),
    open: jest.fn(),
    close: jest.fn(),
    write: jest.fn(),
    read: jest.fn(),
  },
}));

import UsbSerialImport from '../../../modules/usb-serial/src/UsbSerialModule';
import { SerialTransport, SerialTransportError } from '../transport';

const mockUsbSerial = UsbSerialImport as unknown as {
  hasPermission: jest.Mock;
  requestPermission: jest.Mock;
  open: jest.Mock;
  close: jest.Mock;
  write: jest.Mock;
  read: jest.Mock;
};

beforeEach(() => {
  jest.clearAllMocks();
  mockUsbSerial.hasPermission.mockReturnValue(true);
  mockUsbSerial.open.mockResolvedValue(undefined);
  mockUsbSerial.close.mockResolvedValue(undefined);
  mockUsbSerial.write.mockResolvedValue(0);
});

test('open() opens at the given baud once permission is already granted', async () => {
  const transport = new SerialTransport(7, 115200);
  await transport.open();
  expect(mockUsbSerial.requestPermission).not.toHaveBeenCalled();
  expect(mockUsbSerial.open).toHaveBeenCalledWith(7, 115200);
  expect(transport.isOpen).toBe(true);
});

test('open() requests permission when not already granted', async () => {
  mockUsbSerial.hasPermission.mockReturnValue(false);
  mockUsbSerial.requestPermission.mockResolvedValue(true);
  const transport = new SerialTransport(7);
  await transport.open();
  expect(mockUsbSerial.requestPermission).toHaveBeenCalledWith(7);
  expect(mockUsbSerial.open).toHaveBeenCalled();
});

test('open() throws SerialTransportError when permission is denied', async () => {
  mockUsbSerial.hasPermission.mockReturnValue(false);
  mockUsbSerial.requestPermission.mockResolvedValue(false);
  const transport = new SerialTransport(7);
  await expect(transport.open()).rejects.toBeInstanceOf(SerialTransportError);
  expect(mockUsbSerial.open).not.toHaveBeenCalled();
});

test('read()/write() before open() throw SerialTransportError', async () => {
  const transport = new SerialTransport(7);
  await expect(transport.read(4, 100)).rejects.toBeInstanceOf(SerialTransportError);
  await expect(transport.write(new Uint8Array([1]))).rejects.toBeInstanceOf(SerialTransportError);
});

test('read() accumulates across multiple native reads to reach the requested size', async () => {
  // The native module's own read() does NOT accumulate to an exact byte
  // count -- it returns as soon as any data is available. This is the
  // behavior transport.ts's read() must compensate for, since the rest of
  // the FC protocol layer (msp.ts's readMspV1Frame) depends on getting
  // exactly the requested number of bytes when they're actually available.
  mockUsbSerial.read
    .mockResolvedValueOnce(new Uint8Array([0x24])) // '$' arrives alone
    .mockResolvedValueOnce(new Uint8Array([0x4d, 0x3e])); // 'M>' arrives together

  const transport = new SerialTransport(7);
  await transport.open();
  const result = await transport.read(3, 1000);

  expect(result).toEqual(new Uint8Array([0x24, 0x4d, 0x3e]));
  expect(mockUsbSerial.read).toHaveBeenCalledTimes(2);
});

test('read() returns fewer than requested bytes if the native module never delivers the rest', async () => {
  mockUsbSerial.read.mockResolvedValue(new Uint8Array(0));

  const transport = new SerialTransport(7);
  await transport.open();
  const result = await transport.read(3, 50);

  expect(result.length).toBe(0);
});
