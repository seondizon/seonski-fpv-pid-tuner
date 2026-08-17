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

from dataclasses import dataclass

MSP_API_VERSION = 1
MSP_FC_VARIANT = 2
MSP_FC_VERSION = 3

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
