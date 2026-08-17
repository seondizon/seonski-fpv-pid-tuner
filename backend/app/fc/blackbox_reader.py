"""Pull a Blackbox log directly off the FC's onboard SPI dataflash over MSP.

This is a read-only operation (no `set`/`save`, no config writes) -- it must
be called OUTSIDE CLI mode, since MSP requests are only served in the FC's
normal operating mode, not while it's intercepting the serial stream as CLI
text commands. Callers are responsible for having already exited CLI mode
(e.g. via BetaflightCliClient.exit_cli()) before calling this.
"""
from __future__ import annotations

from typing import Callable, Optional

from .msp import (
    MSP_DATAFLASH_READ,
    MSP_DATAFLASH_SUMMARY,
    build_dataflash_read_request,
    build_msp_v1_request,
    parse_dataflash_read_payload,
    parse_dataflash_summary_payload,
    parse_msp_v1_response,
)
from .serial_transport import SerialTransport

# Backstop against a malformed/misbehaving FC response looping forever: at a
# generous minimum chunk of 16 bytes per read, this allows for a ~8MB flash
# dump before giving up -- comfortably above any known Betaflight SPI flash
# chip size (typically 2-16MB), used only as a safety net, not an expected
# path.
_MAX_READ_ITERATIONS = 500_000


class BlackboxNotAvailableError(Exception):
    """Raised when the FC's dataflash isn't ready or has no stored log."""


def _msp_request_response(transport: SerialTransport, command: int, payload: bytes = b"", timeout: float = 3.0) -> bytes:
    transport.write(build_msp_v1_request(command, payload))
    # MSP responses aren't newline-terminated like CLI text; read a
    # generously-sized chunk with the given timeout and rely on
    # parse_msp_v1_response's own length/checksum validation to tell us
    # whether we got a complete frame.
    raw = transport.read(4096, timeout=timeout)
    _, response_payload = parse_msp_v1_response(raw)
    return response_payload


def read_blackbox_from_fc(
    transport: SerialTransport,
    on_progress: Optional[Callable[[int, int], None]] = None,
) -> bytes:
    """Read the full Blackbox log currently stored in the FC's SPI dataflash,
    returning the raw bytes in the same binary format `blackbox_decode`
    expects as input (write these bytes to a .bbl file and decode normally).

    Raises BlackboxNotAvailableError if the dataflash isn't ready or is
    empty (used_size_bytes == 0) -- the caller needs to distinguish "nothing
    to download" from "download succeeded with 0 bytes" for the UI's
    "no log available" messaging (see the appliance-UX spec's Connected
    screen: "If no log is available, clearly explain that instead of
    presenting a broken button.").
    """
    summary_payload = _msp_request_response(transport, MSP_DATAFLASH_SUMMARY)
    summary = parse_dataflash_summary_payload(summary_payload)

    if not summary.ready:
        raise BlackboxNotAvailableError("FC's dataflash is not ready")
    if summary.used_size_bytes == 0:
        raise BlackboxNotAvailableError("FC's dataflash has no stored Blackbox log")

    total = summary.used_size_bytes
    chunks: list[bytes] = []
    bytes_read = 0
    iterations = 0

    while bytes_read < total:
        iterations += 1
        if iterations > _MAX_READ_ITERATIONS:
            raise RuntimeError(
                f"Dataflash read exceeded {_MAX_READ_ITERATIONS} iterations "
                f"({bytes_read}/{total} bytes read) -- aborting to avoid an infinite loop"
            )

        request_payload = build_dataflash_read_request(bytes_read)
        response_payload = _msp_request_response(transport, MSP_DATAFLASH_READ, request_payload)
        result = parse_dataflash_read_payload(response_payload)

        if len(result.data) == 0:
            raise RuntimeError(
                f"FC returned 0 bytes reading dataflash at offset {bytes_read} "
                f"(expected more, total used size is {total} bytes)"
            )

        chunks.append(result.data)
        bytes_read += len(result.data)

        if on_progress is not None:
            on_progress(min(bytes_read, total), total)

    # A response can overshoot the requested/expected end if the FC always
    # returns a fixed page size regardless of how much was actually asked
    # for -- trim to the reported used_size_bytes so we don't hand a decoder
    # a dump padded with trailing garbage/erased-flash bytes.
    return b"".join(chunks)[:total]
