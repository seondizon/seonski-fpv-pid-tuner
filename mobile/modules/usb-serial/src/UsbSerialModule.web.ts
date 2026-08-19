import { registerWebModule, NativeModule } from 'expo';

import type { UsbDeviceInfo } from './UsbSerial.types';

const UNSUPPORTED = 'USB serial access requires the Android USB Host API -- not available on web.';

class UsbSerialModule extends NativeModule<{}> {
  listDevices(): UsbDeviceInfo[] {
    return [];
  }
  hasPermission(_deviceId: number): boolean {
    return false;
  }
  async requestPermission(_deviceId: number): Promise<boolean> {
    return false;
  }
  async open(_deviceId: number, _baudRate: number): Promise<void> {
    throw new Error(UNSUPPORTED);
  }
  async close(): Promise<void> {}
  async write(_data: Uint8Array, _timeoutMs: number): Promise<number> {
    throw new Error(UNSUPPORTED);
  }
  async read(_maxBytes: number, _timeoutMs: number): Promise<Uint8Array> {
    throw new Error(UNSUPPORTED);
  }
}

export default registerWebModule(UsbSerialModule, 'UsbSerialModule');
