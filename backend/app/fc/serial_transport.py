"""Low-level serial transport wrapper around pyserial.

This module isolates all direct pyserial usage so the rest of the FC client
layer (MSP parsing, CLI client) can be unit-tested without a real serial
port or a connected flight controller.

Designed to run on a Raspberry Pi 2B where the FC may be attached at a path
like ``/dev/ttyACM0`` that might not exist yet at development time, or where
pyserial itself might not be installed in a given environment. Both failure
modes are turned into a single, clearly-named exception
(:class:`SerialTransportError`) instead of letting an opaque
``ModuleNotFoundError``/``serial.SerialException`` traceback bubble up.
"""

from __future__ import annotations

from typing import Optional

try:
    import serial as _pyserial  # type: ignore
    from serial import SerialException as _PySerialException  # type: ignore

    _PYSERIAL_IMPORT_ERROR: Optional[Exception] = None
except Exception as exc:  # pragma: no cover - exercised only when pyserial is absent
    _pyserial = None
    _PySerialException = Exception
    _PYSERIAL_IMPORT_ERROR = exc


class SerialTransportError(Exception):
    """Raised for any serial connection failure: missing pyserial, missing
    device path, permission errors, or a transport used before/after
    open()/close()."""


class SerialTransport:
    """Thin wrapper around ``serial.Serial`` with clear error handling and
    context-manager support.

    Example::

        with SerialTransport("/dev/ttyACM0") as t:
            t.write(b"version\\n")
            print(t.readline())
    """

    def __init__(self, port: str, baud: int = 115200, timeout: float = 2.0):
        self.port = port
        self.baud = baud
        self.timeout = timeout
        self._serial: Optional["_pyserial.Serial"] = None

    def open(self) -> None:
        if _pyserial is None:
            raise SerialTransportError(
                "pyserial is not installed in this environment. Install it with "
                "'pip install pyserial' (it is already listed in backend/requirements.txt). "
                f"Original import error: {_PYSERIAL_IMPORT_ERROR!r}"
            )
        if self._serial is not None and self._serial.is_open:
            return
        try:
            self._serial = _pyserial.Serial(
                port=self.port,
                baudrate=self.baud,
                timeout=self.timeout,
                write_timeout=self.timeout,
            )
        except _PySerialException as exc:
            raise SerialTransportError(
                f"Could not open serial port {self.port!r} at {self.baud} baud: {exc}. "
                "On a Raspberry Pi, check that the FC is plugged in and the device path "
                "exists (e.g. via 'ls /dev/tty*'), and that the user has permission "
                "(usually needs to be in the 'dialout' group)."
            ) from exc
        except OSError as exc:
            raise SerialTransportError(
                f"OS error opening serial port {self.port!r}: {exc}. "
                "The device path may not exist yet on this machine."
            ) from exc

    def close(self) -> None:
        if self._serial is not None:
            try:
                self._serial.close()
            except _PySerialException:
                pass
            finally:
                self._serial = None

    def _require_open(self) -> "_pyserial.Serial":
        if self._serial is None or not self._serial.is_open:
            raise SerialTransportError(
                "Serial transport is not open. Call open() (or use as a context manager) "
                "before reading/writing."
            )
        return self._serial

    def write(self, data: bytes) -> None:
        ser = self._require_open()
        try:
            ser.write(data)
            ser.flush()
        except _PySerialException as exc:
            raise SerialTransportError(f"Error writing to serial port {self.port!r}: {exc}") from exc

    def read(self, size: int, timeout: Optional[float] = None) -> bytes:
        ser = self._require_open()
        original_timeout = ser.timeout
        try:
            if timeout is not None:
                ser.timeout = timeout
            return ser.read(size)
        except _PySerialException as exc:
            raise SerialTransportError(f"Error reading from serial port {self.port!r}: {exc}") from exc
        finally:
            ser.timeout = original_timeout

    def readline(self, timeout: Optional[float] = None) -> bytes:
        ser = self._require_open()
        original_timeout = ser.timeout
        try:
            if timeout is not None:
                ser.timeout = timeout
            return ser.readline()
        except _PySerialException as exc:
            raise SerialTransportError(f"Error reading a line from serial port {self.port!r}: {exc}") from exc
        finally:
            ser.timeout = original_timeout

    @property
    def is_open(self) -> bool:
        return self._serial is not None and self._serial.is_open

    def __enter__(self) -> "SerialTransport":
        self.open()
        return self

    def __exit__(self, *args) -> None:
        self.close()
