import { NativeModule, requireNativeModule } from 'expo';

import type { UsbDeviceInfo } from './UsbSerial.types';

declare class UsbSerialModule extends NativeModule<{}> {
  /** Non-connecting scan of attached USB serial devices -- mirrors
   * app/fc/detect.py's detect_fc_port(), except vendor/product-ID matching
   * happens on the JS side (see src/fc/detect.ts) so this stays a dumb
   * enumerator. */
  listDevices(): UsbDeviceInfo[];

  /** Synchronous check -- true only if the user has already granted USB
   * permission for this device in a previous session (Android remembers
   * grants per app+device). */
  hasPermission(deviceId: number): boolean;

  /** Triggers the Android USB permission dialog if not already granted.
   * Resolves to whether permission was granted -- never rejects, since "the
   * user said no" is an expected outcome, not an error. */
  requestPermission(deviceId: number): Promise<boolean>;

  /** Opens the port at 8N1 with the given baud rate. Throws (via a
   * CodedException surfaced as a JS error) if the device is gone or
   * permission wasn't actually granted. */
  open(deviceId: number, baudRate: number): Promise<void>;

  close(): Promise<void>;

  /** Returns the number of bytes actually written (matches
   * SerialTransport.write's contract on the Python side). */
  write(data: Uint8Array, timeoutMs: number): Promise<number>;

  /** Returns only the bytes actually received within timeoutMs -- never
   * the full maxBytes buffer padded with garbage, and never blocks for the
   * full timeout just because maxBytes wasn't reached. This is the exact
   * behavior msp.py's read_msp_v1_frame relies on; see the Kotlin
   * implementation's docstring for the real-hardware bug this avoids. */
  read(maxBytes: number, timeoutMs: number): Promise<Uint8Array>;
}

export default requireNativeModule<UsbSerialModule>('UsbSerial');
export type { UsbDeviceInfo } from './UsbSerial.types';
