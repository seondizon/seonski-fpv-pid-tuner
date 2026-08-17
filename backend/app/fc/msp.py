"""MSP (MultiWii Serial Protocol) v1 basics.

Only enough of MSP is implemented here to (a) build/parse a generic MSP v1
frame and (b) decode the three commands needed for version detection at
connect time: MSP_API_VERSION, MSP_FC_VARIANT, MSP_FC_VERSION. This is a
foundation for later live telemetry, not the full MSP command set.

Command IDs below match Betaflight's ``src/main/msp/msp_protocol.h``:
MSP_API_VERSION = 1, MSP_FC_VARIANT = 2, MSP_FC_VERSION = 3. These are
long-stable, low-numbered MSP v1 command IDs from the original MultiWii
protocol lineage that Betaflight has never renumbered (they're queried
before feature negotiation even happens), so confidence here is high.

MSP v1 frame format (request):
    '$' 'M' '<' <size:u8> <command:u8> <payload bytes> <checksum:u8>
MSP v1 frame format (response):
    '$' 'M' '>' <size:u8> <command:u8> <payload bytes> <checksum:u8>
Error response uses '!' as the direction byte in place of '>'.

Checksum = XOR of the size byte, the command byte, and every payload byte.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass
from typing import Optional

MSP_API_VERSION = 1
MSP_FC_VARIANT = 2
MSP_FC_VERSION = 3

# Betaflight src/main/msp/msp_protocol.h: MSP_DATAFLASH_SUMMARY = 70,
# MSP_DATAFLASH_READ = 71. Used to pull a Blackbox log directly off the FC's
# onboard SPI dataflash over MSP, rather than requiring the user to extract
# the file some other way. Like the version-detection commands above, these
# are long-stable, low-numbered MSP v1 IDs.
MSP_DATAFLASH_SUMMARY = 70
MSP_DATAFLASH_READ = 71

_HEADER = b"$M"
_DIRECTION_TO_FC = b"<"
_DIRECTION_FROM_FC = b">"
_DIRECTION_ERROR = b"!"


def _checksum(size: int, command: int, payload: bytes) -> int:
    chk = size ^ command
    for b in payload:
        chk ^= b
    return chk & 0xFF


def build_msp_v1_request(command: int, payload: bytes = b"") -> bytes:
    """Build an MSP v1 request frame targeting the FC.

    Layout: '$' 'M' '<' <size:u8> <command:u8> <payload> <checksum:u8>
    """
    if not 0 <= command <= 0xFF:
        raise ValueError(f"MSP command must fit in a u8: {command!r}")
    size = len(payload)
    if not 0 <= size <= 0xFF:
        raise ValueError(f"MSP v1 payload too large for u8 size field: {size} bytes")
    checksum = _checksum(size, command, payload)
    return _HEADER + _DIRECTION_TO_FC + bytes([size, command]) + payload + bytes([checksum])


def parse_msp_v1_response(data: bytes) -> tuple[int, bytes]:
    """Parse an MSP v1 response frame from the FC.

    Layout: '$' 'M' '>' <size:u8> <command:u8> <payload> <checksum:u8>

    Returns (command, payload). Raises ValueError on any malformed frame or
    checksum mismatch, with a message describing what was wrong.
    """
    if len(data) < 6:
        raise ValueError(f"MSP frame too short: need at least 6 bytes, got {len(data)}")
    if data[0:2] != _HEADER:
        raise ValueError(f"MSP frame missing '$M' header, got {data[0:2]!r}")
    direction = data[2:3]
    if direction == _DIRECTION_ERROR:
        raise ValueError("MSP frame indicates an FC-side error response ('$M!')")
    if direction != _DIRECTION_FROM_FC:
        raise ValueError(f"MSP frame has unexpected direction byte {direction!r}, expected '>'")

    size = data[3]
    command = data[4]
    expected_len = 5 + size + 1  # header fields already consumed (5) + payload + checksum
    if len(data) < expected_len:
        raise ValueError(
            f"MSP frame truncated: declared payload size {size} requires {expected_len} "
            f"total bytes, got {len(data)}"
        )
    payload = data[5 : 5 + size]
    checksum_byte = data[5 + size]
    expected_checksum = _checksum(size, command, payload)
    if checksum_byte != expected_checksum:
        raise ValueError(
            f"MSP checksum mismatch for command {command}: expected {expected_checksum:#04x}, "
            f"got {checksum_byte:#04x}"
        )
    return command, payload


@dataclass
class MspApiVersion:
    protocol_version: int
    api_major: int
    api_minor: int


def parse_msp_api_version_payload(payload: bytes) -> MspApiVersion:
    """Per MSP_API_VERSION response: 3 bytes - protocolVersion, major, minor."""
    if len(payload) < 3:
        raise ValueError(f"MSP_API_VERSION payload too short: expected 3 bytes, got {len(payload)}")
    return MspApiVersion(protocol_version=payload[0], api_major=payload[1], api_minor=payload[2])


@dataclass
class FcVariant:
    identifier: str  # 4-char ASCII, e.g. "BTFL" for Betaflight


def parse_fc_variant_payload(payload: bytes) -> FcVariant:
    """Per MSP_FC_VARIANT response: 4 raw ASCII bytes identifying the firmware
    (e.g. b"BTFL" for Betaflight, b"CLFL" for Cleanflight, b"INAV" for iNav)."""
    if len(payload) < 4:
        raise ValueError(f"MSP_FC_VARIANT payload too short: expected 4 bytes, got {len(payload)}")
    identifier = payload[0:4].decode("ascii", errors="replace")
    return FcVariant(identifier=identifier)


@dataclass
class FcVersion:
    major: int
    minor: int
    patch: int


def parse_fc_version_payload(payload: bytes) -> FcVersion:
    """Per MSP_FC_VERSION response: 3 bytes - major, minor, patchLevel.

    NOTE: each field is a single unsigned byte (0-255). This is fine for the
    legacy semver scheme (e.g. 4, 5, 0) but cannot represent a calendar-
    versioned year like 2025 (>255). If/when Betaflight updates this MSP
    field for calver builds, this parsing will need revisiting; until then,
    prefer `version.py`'s CLI-banner-based parsing (`parse_version_from_cli_banner`)
    as the authoritative source for calver-era firmware, and treat this MSP
    field as a semver-only fast path / sanity check.
    """
    if len(payload) < 3:
        raise ValueError(f"MSP_FC_VERSION payload too short: expected 3 bytes, got {len(payload)}")
    return FcVersion(major=payload[0], minor=payload[1], patch=payload[2])


@dataclass
class DataflashSummary:
    ready: bool
    total_size_bytes: int
    used_size_bytes: int


def parse_dataflash_summary_payload(payload: bytes) -> DataflashSummary:
    """Per Betaflight's MSP_DATAFLASH_SUMMARY (src/main/msp/msp.c):
        flags: 1 byte (bit 0 = ready)
        totalSize: uint32 LE
        usedSize: uint32 LE
    Some firmware versions append more fields after this (e.g. sector/page
    info) -- only the first 9 bytes are parsed; anything beyond that is
    ignored rather than requiring an exact length match, since only
    ready/total/used are needed here.
    """
    if len(payload) < 9:
        raise ValueError(f"MSP_DATAFLASH_SUMMARY payload too short: expected >= 9 bytes, got {len(payload)}")
    flags = payload[0]
    total_size, used_size = struct.unpack_from("<II", payload, 1)
    return DataflashSummary(ready=bool(flags & 0x01), total_size_bytes=total_size, used_size_bytes=used_size)


def build_dataflash_read_request(address: int, read_length: Optional[int] = None) -> bytes:
    """Per Betaflight's MSP_DATAFLASH_READ: request payload is
        address: uint32 LE
    Newer firmware also accepts an optional
        readLength: uint16 LE
        useLegacyFormat: uint8 (0)
    appended, to request a specific chunk size. For maximum compatibility
    across Betaflight versions (see docs/research/reference-analysis.md
    section 2 on CLI/MSP not being stable across versions), this builds the
    minimal 4-byte-address-only request by default (read_length=None), which
    every version that implements MSP_DATAFLASH_READ at all is expected to
    accept -- the FC decides how much to send back per call in that case.
    The extra fields are only appended when read_length is explicitly given.
    """
    if address < 0 or address > 0xFFFFFFFF:
        raise ValueError(f"address must fit in a uint32: {address!r}")
    payload = struct.pack("<I", address)
    if read_length is not None:
        if not 0 <= read_length <= 0xFFFF:
            raise ValueError(f"read_length must fit in a uint16: {read_length!r}")
        payload += struct.pack("<HB", read_length, 0)  # useLegacyFormat=0
    return payload


@dataclass
class DataflashReadResult:
    address: int
    data: bytes


def parse_dataflash_read_payload(payload: bytes) -> DataflashReadResult:
    """Response payload: address (uint32 LE) followed by the raw flash bytes
    read starting at that address. The number of bytes returned varies by
    firmware/MSP version and by how much data was actually available at that
    address -- callers must use len(result.data), never assume a fixed chunk
    size."""
    if len(payload) < 4:
        raise ValueError(f"MSP_DATAFLASH_READ payload too short: expected >= 4 bytes, got {len(payload)}")
    (address,) = struct.unpack_from("<I", payload, 0)
    return DataflashReadResult(address=address, data=payload[4:])
