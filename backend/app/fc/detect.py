"""Passive USB/serial detection of a likely Betaflight flight controller.

This is deliberately non-connecting: it only enumerates already-attached USB
serial devices and matches known VID:PID pairs, so it's safe to poll
continuously from a background loop to drive the touchscreen UI's
IDLE -> FC_DETECTED transition, without opening the port (and therefore
without ever needing to negotiate/interfere with anything already talking to
it) until the user explicitly taps CONNECT.
"""
from __future__ import annotations

from typing import Optional

try:
    from serial.tools import list_ports as _list_ports  # type: ignore

    _PYSERIAL_TOOLS_IMPORT_ERROR: Optional[Exception] = None
except Exception as exc:  # pragma: no cover - exercised only when pyserial is absent
    _list_ports = None
    _PYSERIAL_TOOLS_IMPORT_ERROR = exc

# (vendor_id, product_id) pairs for USB-serial chips commonly found on
# Betaflight flight controllers. Confirmed LIVE against our real test FC
# (STM32F411, Betaflight 4.5.1): vid=0x0483, pid=0x5740 -- this is
# STMicroelectronics' standard "Virtual COM Port" USB CDC-ACM
# vendor/product ID, used by the large majority of STM32-based Betaflight
# targets regardless of manufacturer. The CP210x/FTDI entries are lower-
# confidence fallbacks for the (much rarer) boards that use a discrete
# USB-serial bridge chip instead of the MCU's built-in USB peripheral --
# unverified against real hardware, included because they're the next most
# common USB-serial chips in this space, not because we've confirmed a
# Betaflight board using them.
_KNOWN_FC_VID_PID = (
    (0x0483, 0x5740),  # STMicroelectronics STM32 Virtual COM Port -- confirmed live
    (0x10C4, 0xEA60),  # Silicon Labs CP210x USB-UART bridge -- unverified fallback
    (0x0403, 0x6001),  # FTDI FT232 USB-UART bridge -- unverified fallback
)


def detect_fc_port() -> Optional[str]:
    """Return the device path (e.g. "/dev/ttyACM0") of the first attached
    USB serial device matching a known flight-controller VID:PID, or None
    if nothing matches or pyserial's `serial.tools` isn't available.

    Does NOT open the port. Callers still need SerialTransport.open() (or
    the full CONNECT flow) to actually talk to it -- this only answers
    "is something that looks like an FC plugged in right now?"
    """
    if _list_ports is None:
        return None
    for port_info in _list_ports.comports():
        if port_info.vid is None or port_info.pid is None:
            continue
        if (port_info.vid, port_info.pid) in _KNOWN_FC_VID_PID:
            return port_info.device
    return None
