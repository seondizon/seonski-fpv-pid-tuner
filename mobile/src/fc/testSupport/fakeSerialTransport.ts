import { decodeUtf8, encodeUtf8 } from '../bytes';
import { SerialTransportError } from '../errors';
import type { CliTransport } from '../cliClient';

/** Stand-in for SerialTransport used in cliClient/info tests: records every
 * command written to it and returns a scripted response per command, so
 * tests never need a real USB device. Mirrors the Python reference's
 * FakeSerialTransport in test_fc.py exactly, including the "whole response
 * on first read, then nothing" behavior that readUntilQuiet's loop
 * depends on to terminate. */
export class FakeSerialTransport implements CliTransport {
  sentCommands: string[] = [];
  private pendingResponse: Uint8Array = new Uint8Array(0);

  constructor(private responses: Record<string, string> = {}) {}

  async write(data: Uint8Array): Promise<void> {
    const text = decodeUtf8(data);
    const command = text.replace(/\n$/, '');
    this.sentCommands.push(command);
    const responseText = this.responses[command] ?? '';
    this.pendingResponse = encodeUtf8(responseText);
  }

  async read(_size: number, _timeoutMs?: number): Promise<Uint8Array> {
    const chunk = this.pendingResponse;
    this.pendingResponse = new Uint8Array(0);
    return chunk;
  }
}

/** Stand-in for a transport that raises on a specific command's write --
 * used to reproduce the real-hardware finding that `exit` can drop the
 * FC's USB CDC-ACM connection. */
export class RaisingOnExitTransport extends FakeSerialTransport {
  async write(data: Uint8Array): Promise<void> {
    const text = decodeUtf8(data).replace(/\n$/, '');
    if (text === 'exit') {
      throw new SerialTransportError("Could not configure port: (5, 'Input/output error')");
    }
    await super.write(data);
  }
}
