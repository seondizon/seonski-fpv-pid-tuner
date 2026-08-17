"""Tests for the FC client layer (app.fc). None of these require real
hardware or pyserial actually opening a port -- msp/version tests are pure
functions, and cli_client tests inject a fake transport."""

from __future__ import annotations

import pytest

from app.fc.msp import (
    FcVariant,
    FcVersion,
    MSP_API_VERSION,
    MSP_FC_VARIANT,
    MSP_FC_VERSION,
    MspApiVersion,
    build_msp_v1_request,
    parse_fc_variant_payload,
    parse_fc_version_payload,
    parse_msp_api_version_payload,
    parse_msp_v1_response,
)
from app.fc.version import (
    BetaflightVersion,
    parse_betaflight_version,
    parse_version_from_cli_banner,
)
from app.fc.cli_client import BetaflightCliClient


# ---------------------------------------------------------------------------
# msp.py
# ---------------------------------------------------------------------------


def _build_response_frame(command: int, payload: bytes) -> bytes:
    """Manually construct a plausible MSP v1 response frame with a correct
    checksum, mirroring what a real FC would send back."""
    size = len(payload)
    checksum = size ^ command
    for b in payload:
        checksum ^= b
    return b"$M>" + bytes([size, command]) + payload + bytes([checksum & 0xFF])


def test_msp_v1_request_frame_structure():
    frame = build_msp_v1_request(MSP_API_VERSION, b"")
    assert frame[0:3] == b"$M<"
    assert frame[3] == 0  # size
    assert frame[4] == MSP_API_VERSION
    # checksum of size=0, command=1, no payload => 0 ^ 1 = 1
    assert frame[5] == 1


def test_msp_v1_roundtrip_no_payload():
    request = build_msp_v1_request(MSP_FC_VARIANT)
    assert request == b"$M<" + bytes([0, MSP_FC_VARIANT, 0 ^ MSP_FC_VARIANT])

    response = _build_response_frame(MSP_FC_VARIANT, b"BTFL")
    command, payload = parse_msp_v1_response(response)
    assert command == MSP_FC_VARIANT
    assert payload == b"BTFL"

    variant = parse_fc_variant_payload(payload)
    assert variant == FcVariant(identifier="BTFL")


def test_msp_v1_roundtrip_with_payload():
    request = build_msp_v1_request(0x10, b"\x01\x02\x03")
    # verify checksum manually: size=3, command=0x10, payload bytes
    expected_checksum = 3 ^ 0x10 ^ 0x01 ^ 0x02 ^ 0x03
    assert request[-1] == expected_checksum

    response = _build_response_frame(MSP_FC_VERSION, bytes([4, 5, 0]))
    command, payload = parse_msp_v1_response(response)
    assert command == MSP_FC_VERSION
    version = parse_fc_version_payload(payload)
    assert version == FcVersion(major=4, minor=5, patch=0)


def test_msp_api_version_payload_parses():
    response = _build_response_frame(MSP_API_VERSION, bytes([2, 1, 45]))
    command, payload = parse_msp_v1_response(response)
    assert command == MSP_API_VERSION
    api_version = parse_msp_api_version_payload(payload)
    assert api_version == MspApiVersion(protocol_version=2, api_major=1, api_minor=45)


def test_msp_v1_corrupted_checksum_raises_value_error():
    good_frame = _build_response_frame(MSP_FC_VARIANT, b"BTFL")
    corrupted = bytearray(good_frame)
    corrupted[-1] ^= 0xFF  # flip the checksum byte
    with pytest.raises(ValueError, match="checksum"):
        parse_msp_v1_response(bytes(corrupted))


def test_msp_v1_malformed_header_raises_value_error():
    with pytest.raises(ValueError):
        parse_msp_v1_response(b"XX>" + bytes([0, 1, 1]))


def test_msp_v1_truncated_frame_raises_value_error():
    with pytest.raises(ValueError):
        parse_msp_v1_response(b"$M>")


# ---------------------------------------------------------------------------
# version.py
# ---------------------------------------------------------------------------


def test_parse_semver_style_version():
    v = parse_betaflight_version("4.5.0")
    assert v.scheme == "semver"
    assert v.major == 4
    assert v.minor == 5
    assert v.patch == 0
    assert v.raw == "4.5.0"


def test_parse_calver_style_version():
    v = parse_betaflight_version("2025.12.0")
    assert v.scheme == "calver"
    assert v.major == 2025
    assert v.minor == 12
    assert v.patch == 0


def test_parse_betaflight_version_invalid_raises():
    with pytest.raises(ValueError):
        parse_betaflight_version("not-a-version")
    with pytest.raises(ValueError):
        parse_betaflight_version("4.5")


def test_supports_feature_semver_gate():
    v43 = parse_betaflight_version("4.3.0")
    v44 = parse_betaflight_version("4.4.0")
    assert v43.supports_feature("pid_profile_count_4") is False
    assert v44.supports_feature("pid_profile_count_4") is True


def test_supports_feature_save_noreboot():
    v43 = parse_betaflight_version("4.3.0")
    v_calver = parse_betaflight_version("2025.12.0")
    v_calver_older_month = parse_betaflight_version("2025.6.0")

    assert v43.supports_feature("save_noreboot") is False
    assert v_calver.supports_feature("save_noreboot") is True
    # calver but before the 2025.12 cutoff should not support it
    assert v_calver_older_month.supports_feature("save_noreboot") is False


def test_supports_feature_cross_scheme_assumptions():
    # A semver 4.x version predates calver entirely -> never satisfies a
    # calver-gated feature.
    v45 = parse_betaflight_version("4.5.0")
    assert v45.supports_feature("save_noreboot") is False

    # A calver version is always newer than any semver-gated feature.
    v_calver = parse_betaflight_version("2025.12.0")
    assert v_calver.supports_feature("resource_syntax_v2") is True


def test_parse_version_from_cli_banner_semver():
    banner = (
        "# Betaflight / STM32F7X2 4.5.0 Jan  1 2024 / 12:00:00 "
        "(abcdef1234) MSP API: 1.45"
    )
    version = parse_version_from_cli_banner(banner)
    assert version is not None
    assert version.scheme == "semver"
    assert (version.major, version.minor, version.patch) == (4, 5, 0)


def test_parse_version_from_cli_banner_calver():
    banner = (
        "# Betaflight / STM32F405 2025.12.0 Dec 10 2025 / 09:00:00 "
        "(0123456789abcd) MSP API: 1.47"
    )
    version = parse_version_from_cli_banner(banner)
    assert version is not None
    assert version.scheme == "calver"
    assert (version.major, version.minor, version.patch) == (2025, 12, 0)


def test_parse_version_from_cli_banner_garbage_returns_none():
    assert parse_version_from_cli_banner("not a version banner at all") is None
    assert parse_version_from_cli_banner("") is None


# ---------------------------------------------------------------------------
# cli_client.py
# ---------------------------------------------------------------------------


class FakeSerialTransport:
    """Stand-in for SerialTransport used in tests: records every command
    written to it and returns a scripted response per command, so we never
    need real pyserial hardware."""

    def __init__(self, responses: dict[str, str] | None = None):
        # maps a command string (without trailing newline) -> response text
        self.responses = responses or {}
        self.sent_commands: list[str] = []
        self._pending_response = b""

    def write(self, data: bytes) -> None:
        text = data.decode("utf-8")
        command = text.rstrip("\n")
        self.sent_commands.append(command)
        response_text = self.responses.get(command, "")
        self._pending_response = response_text.encode("utf-8")

    def read(self, size: int, timeout: float | None = None) -> bytes:
        # Return the whole pending response on first read, then signal
        # "nothing more" on subsequent reads so _read_until_quiet stops.
        chunk, self._pending_response = self._pending_response, b""
        return chunk

    def readline(self, timeout: float | None = None) -> bytes:
        return self.read(4096, timeout)

    def open(self) -> None:
        pass

    def close(self) -> None:
        pass


def test_apply_config_lines_blocks_on_version_mismatch():
    transport = FakeSerialTransport()
    client = BetaflightCliClient(transport)

    detected = parse_betaflight_version("4.3.0")
    target = parse_betaflight_version("4.5.0")

    config_text = "set gyro_lpf1_static_hz = 250\nresource MOTOR 1 A08\n"
    result = client.apply_config_lines(config_text, detected, target)

    assert result["blocked_version_mismatch"] is True
    assert result["applied"] == []
    # Nothing should have been sent to the FC at all when blocked.
    assert transport.sent_commands == []
    # Hardware-specific line is still classified/skipped even when blocked.
    assert any("resource" in line for line in result["skipped_hardware_specific"])
    assert any("gyro_lpf1_static_hz" in line for line in result["lines_requiring_review"])


def test_apply_config_lines_blocks_on_scheme_crossing():
    transport = FakeSerialTransport()
    client = BetaflightCliClient(transport)

    detected = parse_betaflight_version("4.5.0")
    target = parse_betaflight_version("2025.12.0")

    result = client.apply_config_lines("set foo = 1\n", detected, target)
    assert result["blocked_version_mismatch"] is True
    assert transport.sent_commands == []


def test_apply_config_lines_skips_hardware_specific_and_sends_set_lines():
    transport = FakeSerialTransport(
        responses={"set gyro_lpf1_static_hz = 250": "gyro_lpf1_static_hz set to 250"}
    )
    client = BetaflightCliClient(transport)

    same_version_a = parse_betaflight_version("4.5.0")
    same_version_b = parse_betaflight_version("4.5.2")  # same major.minor -> matches

    config_text = (
        "resource MOTOR 1 A08\n"
        "set gyro_lpf1_static_hz = 250\n"
        "timer A08 AF3\n"
    )
    result = client.apply_config_lines(config_text, same_version_a, same_version_b)

    assert result["blocked_version_mismatch"] is False
    assert "set gyro_lpf1_static_hz = 250" in result["applied"]
    assert "resource MOTOR 1 A08" in result["skipped_hardware_specific"]
    assert "timer A08 AF3" in result["skipped_hardware_specific"]

    # The hardware-specific lines must never have been sent to the FC.
    assert not any("resource" in cmd for cmd in transport.sent_commands)
    assert not any(cmd.startswith("timer") for cmd in transport.sent_commands)
    # The set line must have been sent.
    assert "set gyro_lpf1_static_hz = 250" in transport.sent_commands


def test_apply_config_lines_records_fc_rejections():
    transport = FakeSerialTransport(
        responses={"set bogus_param = 1": "ERROR IN COMMAND bogus_param"}
    )
    client = BetaflightCliClient(transport)
    v = parse_betaflight_version("4.5.0")

    result = client.apply_config_lines("set bogus_param = 1\n", v, v)

    assert result["blocked_version_mismatch"] is False
    assert result["applied"] == []
    assert len(result["rejected"]) == 1
    rejected_line, error_text = result["rejected"][0]
    assert rejected_line == "set bogus_param = 1"
    assert "ERROR IN COMMAND" in error_text


def test_get_version_uses_cli_banner_parsing():
    banner = (
        "# Betaflight / STM32F7X2 4.5.0 Jan  1 2024 / 12:00:00 "
        "(abcdef1234) MSP API: 1.45"
    )
    transport = FakeSerialTransport(responses={"version": banner})
    client = BetaflightCliClient(transport)

    version = client.get_version()
    assert version is not None
    assert version.raw == "4.5.0"
    assert version.scheme == "semver"
