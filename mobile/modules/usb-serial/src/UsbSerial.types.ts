/**
 * A USB device as seen by usb-serial-for-android's device prober -- one of
 * these exists per attached device that looks like a serial adapter,
 * whether or not we've matched its vendor/product ID against our known FC
 * list yet (that matching happens in detect.ts, not here).
 */
export type UsbDeviceInfo = {
  deviceId: number;
  vendorId: number;
  productId: number;
  deviceName: string;
};
