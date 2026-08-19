/** Shared error type for the FC protocol layer. Kept in its own module (no
 * native-module import) so pure-logic pieces (cliClient.ts, info.ts) don't
 * pull in the native UsbSerial dependency just to catch/throw this. */
export class SerialTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SerialTransportError';
  }
}
