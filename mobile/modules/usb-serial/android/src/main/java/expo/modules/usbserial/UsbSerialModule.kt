package expo.modules.usbserial

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.util.Log
import androidx.core.content.ContextCompat
import com.hoho.android.usbserial.driver.UsbSerialDriver
import com.hoho.android.usbserial.driver.UsbSerialPort
import com.hoho.android.usbserial.driver.UsbSerialProber
import com.hoho.android.usbserial.util.SerialInputOutputManager
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

private const val ACTION_USB_PERMISSION = "expo.modules.usbserial.USB_PERMISSION"

/**
 * Thin wrapper around usb-serial-for-android exposing exactly what the FC
 * protocol layer (ported from the Python reference's backend/app/fc module)
 * needs: enumerate CDC-ACM devices, request the runtime USB permission,
 * open/close a port, write bytes, read bytes.
 *
 * Deliberately mirrors SerialTransport's shape (open/close/read/write with a
 * per-call timeout) so the TS port of msp.py/cli_client.py can be a faithful
 * translation rather than a redesign.
 *
 * IMPORTANT, found against real hardware: calling UsbSerialPort.read()
 * directly (a blocking bulkTransfer call) reliably returned 0 bytes almost
 * instantly for our test FC's CDC-ACM interface, regardless of the timeout
 * passed in or whether the FC had already sent a reply -- this is a
 * documented limitation of usb-serial-for-android's synchronous read path
 * on some Android USB host controllers/CDC-ACM devices. The library's own
 * recommended fix is its asynchronous API: a background-thread
 * SerialInputOutputManager that delivers incoming bytes via an
 * onNewData(ByteArray) callback. This module buffers those callback bytes
 * into `incomingBuffer` and has `read()` wait on it instead of calling
 * UsbSerialPort.read() directly. Do not revert to the direct blocking read
 * -- it silently doesn't work for this class of device.
 */
class UsbSerialModule : Module() {
  private var port: UsbSerialPort? = null
  private var ioManager: SerialInputOutputManager? = null
  private var pendingPermissionContinuation: ((Boolean) -> Unit)? = null

  private val bufferLock = java.lang.Object()
  private val incomingBuffer = java.util.ArrayDeque<Byte>()

  private val ioListener = object : SerialInputOutputManager.Listener {
    override fun onNewData(data: ByteArray) {
      Log.d("UsbSerialDiag", "onNewData: ${data.size} bytes")
      synchronized(bufferLock) {
        for (b in data) incomingBuffer.addLast(b)
        bufferLock.notifyAll()
      }
    }

    override fun onRunError(e: Exception) {
      Log.e("UsbSerialDiag", "onRunError: ${e.message}", e)
      // The port likely disconnected -- nothing to do here; the next
      // read()/write() call will surface a clear error once the caller
      // notices the transport is dead.
    }
  }

  private val usbManager: UsbManager
    get() {
      val context = appContext.reactContext
        ?: throw CodedException("E_NO_CONTEXT", "React context is not available", null)
      return context.getSystemService(Context.USB_SERVICE) as UsbManager
    }

  private val permissionReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      if (ACTION_USB_PERMISSION != intent.action) return
      val granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)
      pendingPermissionContinuation?.invoke(granted)
      pendingPermissionContinuation = null
    }
  }

  override fun definition() = ModuleDefinition {
    Name("UsbSerial")

    OnCreate {
      val context = appContext.reactContext ?: return@OnCreate
      ContextCompat.registerReceiver(
        context,
        permissionReceiver,
        IntentFilter(ACTION_USB_PERMISSION),
        ContextCompat.RECEIVER_NOT_EXPORTED
      )
    }

    OnDestroy {
      try {
        appContext.reactContext?.unregisterReceiver(permissionReceiver)
      } catch (e: IllegalArgumentException) {
        // already unregistered -- fine
      }
      closePortQuietly()
    }

    // Non-connecting device scan -- mirrors app/fc/detect.py's
    // detect_fc_port(): enumerate what's plugged in, match known
    // vendor/product IDs, without opening anything. VID:PID matching
    // itself happens on the JS side against the same list detect.py
    // documents, so this module stays a dumb enumerator.
    Function("listDevices") {
      UsbSerialProber.getDefaultProber().findAllDrivers(usbManager).map { driver ->
        val device = driver.device
        mapOf(
          "deviceId" to device.deviceId,
          "vendorId" to device.vendorId,
          "productId" to device.productId,
          "deviceName" to device.deviceName
        )
      }
    }

    Function("hasPermission") { deviceId: Int ->
      findDevice(deviceId)?.let { usbManager.hasPermission(it) } ?: false
    }

    AsyncFunction("requestPermission") Coroutine { deviceId: Int ->
      val device = findDevice(deviceId) ?: return@Coroutine false
      if (usbManager.hasPermission(device)) return@Coroutine true

      val context = appContext.reactContext ?: return@Coroutine false
      suspendCancellableCoroutine<Boolean> { continuation ->
        pendingPermissionContinuation = { granted ->
          if (continuation.isActive) continuation.resume(granted)
        }
        val permissionIntent = PendingIntent.getBroadcast(
          context, 0, Intent(ACTION_USB_PERMISSION), PendingIntent.FLAG_MUTABLE
        )
        usbManager.requestPermission(device, permissionIntent)
      }
    }

    AsyncFunction("open") { deviceId: Int, baudRate: Int ->
      val driver = findDriver(deviceId)
        ?: throw CodedException("E_NO_DEVICE", "No USB serial device with id $deviceId", null)
      val connection = usbManager.openDevice(driver.device)
        ?: throw CodedException(
          "E_NO_PERMISSION",
          "Could not open device $deviceId -- permission not granted, or the OS reclaimed the device",
          null
        )

      // Most FCs (and every one we've tested against) expose a single
      // CDC-ACM port; multi-port adapters would need a port index param,
      // not needed for our use case.
      val newPort = driver.ports[0]
      Log.d("UsbSerialDiag", "driver=${driver.javaClass.simpleName} ports=${driver.ports.size}")
      try {
        newPort.open(connection)
        newPort.setParameters(baudRate, 8, UsbSerialPort.STOPBITS_1, UsbSerialPort.PARITY_NONE)
        Log.d("UsbSerialDiag", "port opened + parameters set (baud=$baudRate)")
        // usb-serial-for-android does NOT assert these automatically (unlike
        // pyserial, which asserts DTR by default) -- STM32's CDC-ACM VCP
        // firmware (used by most Betaflight FCs) gates serial output on DTR
        // being asserted, so without this the port can open successfully but
        // the FC never sends anything back.
        try {
          newPort.setDTR(true)
          newPort.setRTS(true)
          Log.d("UsbSerialDiag", "DTR+RTS asserted OK")
        } catch (e: java.io.IOException) {
          // Some drivers/devices don't support control lines -- not fatal.
          Log.e("UsbSerialDiag", "setDTR/setRTS threw: ${e.message}", e)
        }
      } catch (e: Exception) {
        Log.e("UsbSerialDiag", "open/setParameters threw: ${e.message}", e)
        try { newPort.close() } catch (_: Exception) {}
        throw CodedException("E_OPEN_FAILED", e.message ?: "Failed to open port $deviceId", e)
      }
      closePortQuietly() // in case a previous port was left open
      port = newPort
      synchronized(bufferLock) { incomingBuffer.clear() }
      ioManager = SerialInputOutputManager(newPort, ioListener).also { it.start() }
      null
    }

    AsyncFunction("close") {
      closePortQuietly()
      null
    }

    // `data` arrives as a Uint8Array from JS -- the Expo Modules API maps
    // this to a Kotlin ByteArray automatically, no base64 round trip needed.
    AsyncFunction("write") { data: ByteArray, timeoutMs: Int ->
      val activePort = port ?: throw CodedException("E_NOT_OPEN", "Port is not open", null)
      try {
        activePort.write(data, timeoutMs)
        Log.d("UsbSerialDiag", "write OK: ${data.size} bytes = ${String(data, Charsets.ISO_8859_1)}")
      } catch (e: Exception) {
        Log.e("UsbSerialDiag", "write threw: ${e.message}", e)
        throw CodedException("E_WRITE_FAILED", e.message ?: "Write failed", e)
      }
      data.size
    }

    // Waits (up to timeoutMs) for at least one byte to have arrived via the
    // SerialInputOutputManager listener, then returns whatever is currently
    // buffered, trimmed to at most maxBytes -- never the full maxBytes
    // padded with garbage, and never a forced wait for maxBytes to fully
    // fill. transport.ts's accumulate loop calls this repeatedly to build up
    // an exact byte count.
    AsyncFunction("read") { maxBytes: Int, timeoutMs: Int ->
      if (port == null) throw CodedException("E_NOT_OPEN", "Port is not open", null)
      val deadline = System.currentTimeMillis() + timeoutMs
      val out: ByteArray
      synchronized(bufferLock) {
        while (incomingBuffer.isEmpty()) {
          val remaining = deadline - System.currentTimeMillis()
          if (remaining <= 0) break
          bufferLock.wait(remaining)
        }
        val n = minOf(maxBytes, incomingBuffer.size)
        out = ByteArray(n) { incomingBuffer.removeFirst() }
      }
      out
    }
  }

  private fun closePortQuietly() {
    try {
      ioManager?.stop()
    } catch (e: Exception) {
      // already stopped -- fine
    }
    ioManager = null
    try {
      port?.close()
    } catch (e: Exception) {
      // already closed / device gone -- not an error worth surfacing here
    }
    port = null
  }

  private fun findDevice(deviceId: Int): UsbDevice? =
    usbManager.deviceList.values.firstOrNull { it.deviceId == deviceId }

  private fun findDriver(deviceId: Int): UsbSerialDriver? =
    UsbSerialProber.getDefaultProber().findAllDrivers(usbManager)
      .firstOrNull { it.device.deviceId == deviceId }
}
