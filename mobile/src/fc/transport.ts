/** Serial transport wrapper around the native UsbSerial module.
 *
 * Ported from backend/app/fc/serial_transport.py's SerialTransport, with one
 * deliberate behavioral addition documented on `read()` below: the native
 * module's own read() does NOT accumulate to an exact byte count the way
 * pyserial's Serial.read(n) does, so this class does that accumulation
 * itself. The rest of the FC protocol layer (msp.ts's readMspV1Frame in
 * particular) is a faithful, byte-for-byte port of the Python reference and
 * depends on read(size, timeoutMs) returning up to `size` bytes, blocking up
 * to `timeoutMs` total -- exactly like the Python original.
 */
import UsbSerial from '../../modules/usb-serial/src/UsbSerialModule';
import { SerialTransportError } from './errors';

export { SerialTransportError } from './errors';

export class SerialTransport {
  private _isOpen = false;

  constructor(
    public readonly deviceId: number,
    public readonly baud: number = 115200
  ) {}

  get isOpen(): boolean {
    return this._isOpen;
  }

  async open(): Promise<void> {
    if (this._isOpen) return;
    try {
      const alreadyGranted = UsbSerial.hasPermission(this.deviceId);
      const granted = alreadyGranted || (await UsbSerial.requestPermission(this.deviceId));
      if (!granted) {
        throw new SerialTransportError(
          `USB permission was not granted for device ${this.deviceId}. The user must accept the Android USB permission dialog.`
        );
      }
      await UsbSerial.open(this.deviceId, this.baud);
      this._isOpen = true;
    } catch (exc) {
      if (exc instanceof SerialTransportError) throw exc;
      throw new SerialTransportError(
        `Could not open USB serial device ${this.deviceId} at ${this.baud} baud: ${(exc as Error).message}. ` +
          'Check that the FC is plugged in via USB-OTG and that USB debugging/permission was granted.'
      );
    }
  }

  async close(): Promise<void> {
    if (!this._isOpen) return;
    try {
      await UsbSerial.close();
    } finally {
      this._isOpen = false;
    }
  }

  private requireOpen(): void {
    if (!this._isOpen) {
      throw new SerialTransportError(
        'Serial transport is not open. Call open() before reading/writing.'
      );
    }
  }

  async write(data: Uint8Array): Promise<void> {
    this.requireOpen();
    try {
      await UsbSerial.write(data, 2000);
    } catch (exc) {
      throw new SerialTransportError(`Error writing to USB serial device: ${(exc as Error).message}`);
    }
  }

  /** Reads up to `size` bytes, blocking (via repeated native reads) up to
   * `timeoutMs` total. Returns fewer than `size` bytes if the timeout
   * elapses first -- callers (msp.ts's readMspV1Frame in particular) rely on
   * this to detect a truncated/timed-out read, exactly as the Python
   * reference's read_msp_v1_frame does against pyserial. */
  async read(size: number, timeoutMs: number): Promise<Uint8Array> {
    this.requireOpen();
    const out = new Uint8Array(size);
    let filled = 0;
    const deadline = Date.now() + timeoutMs;
    while (filled < size) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      let chunk: Uint8Array;
      try {
        chunk = await UsbSerial.read(size - filled, remainingMs);
      } catch (exc) {
        throw new SerialTransportError(`Error reading from USB serial device: ${(exc as Error).message}`);
      }
      if (chunk.length === 0) break;
      out.set(chunk, filled);
      filled += chunk.length;
    }
    return out.subarray(0, filled);
  }
}
