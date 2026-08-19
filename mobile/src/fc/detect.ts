/** Passive USB detection of a likely Betaflight flight controller.
 *
 * Ported from backend/app/fc/detect.py. Deliberately non-connecting: it
 * only enumerates already-attached USB serial devices and matches known
 * VID:PID pairs, without opening the port.
 */
import UsbSerial from '../../modules/usb-serial/src/UsbSerialModule';
import type { UsbDeviceInfo } from '../../modules/usb-serial/src/UsbSerial.types';

/** (vendorId, productId) pairs for USB-serial chips commonly found on
 * Betaflight flight controllers. Confirmed LIVE against our real test FC
 * (STM32F411, Betaflight 4.5.1): 0x0483/0x5740 -- STMicroelectronics'
 * standard "Virtual COM Port" USB CDC-ACM vendor/product ID, used by most
 * STM32-based Betaflight targets regardless of manufacturer. The CP210x/
 * FTDI entries are lower-confidence fallbacks for boards using a discrete
 * USB-serial bridge chip instead of the MCU's built-in USB peripheral --
 * unverified against real hardware. */
const KNOWN_FC_VID_PID: ReadonlyArray<readonly [number, number]> = [
  [0x0483, 0x5740], // STMicroelectronics STM32 Virtual COM Port -- confirmed live
  [0x10c4, 0xea60], // Silicon Labs CP210x USB-UART bridge -- unverified fallback
  [0x0403, 0x6001], // FTDI FT232 USB-UART bridge -- unverified fallback
];

export function looksLikeFc(device: UsbDeviceInfo): boolean {
  return KNOWN_FC_VID_PID.some(([vid, pid]) => device.vendorId === vid && device.productId === pid);
}

/** Returns the first attached USB device matching a known flight-controller
 * VID:PID, or null if nothing matches. Does NOT open the port -- callers
 * still need SerialTransport.open() to actually talk to it. */
export function detectFcDevice(): UsbDeviceInfo | null {
  return UsbSerial.listDevices().find(looksLikeFc) ?? null;
}
