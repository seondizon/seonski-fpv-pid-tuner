"""Tests for app.fc.info -- craft name / blackbox storage / PID profile
parsing, using the existing text-based FakeSerialTransport from test_fc.py
(these are CLI text commands, not raw MSP frames)."""
from __future__ import annotations

from app.fc.cli_client import BetaflightCliClient
from app.fc.info import get_blackbox_storage_type, get_craft_name, get_pid_profile_index
from tests.test_fc import FakeSerialTransport


def test_get_craft_name_parses_set_name():
    transport = FakeSerialTransport({"get name": "name = Chimera7\n"})
    client = BetaflightCliClient(transport)
    assert get_craft_name(client) == "Chimera7"


def test_get_craft_name_returns_none_when_unset():
    transport = FakeSerialTransport({"get name": "name = \n"})
    client = BetaflightCliClient(transport)
    assert get_craft_name(client) is None


def test_get_craft_name_returns_none_when_unparseable():
    transport = FakeSerialTransport({"get name": "unexpected garbage response\n"})
    client = BetaflightCliClient(transport)
    assert get_craft_name(client) is None


def test_get_craft_name_tolerates_trailing_allowed_range_line():
    transport = FakeSerialTransport(
        {"get name": "name = Chimera7\nAllowed range: 0 - 16 characters\n"}
    )
    client = BetaflightCliClient(transport)
    assert get_craft_name(client) == "Chimera7"


def test_get_blackbox_storage_type_spiflash():
    transport = FakeSerialTransport({"get blackbox_device": "blackbox_device = SPIFLASH\n"})
    client = BetaflightCliClient(transport)
    assert get_blackbox_storage_type(client) == "SPIFLASH"


def test_get_blackbox_storage_type_sdcard():
    transport = FakeSerialTransport({"get blackbox_device": "blackbox_device = SDCARD\n"})
    client = BetaflightCliClient(transport)
    assert get_blackbox_storage_type(client) == "SDCARD"


def test_get_blackbox_storage_type_unparseable_returns_none():
    transport = FakeSerialTransport({"get blackbox_device": "garbage\n"})
    client = BetaflightCliClient(transport)
    assert get_blackbox_storage_type(client) is None


def test_get_pid_profile_index_parses_status_output():
    transport = FakeSerialTransport(
        {"status": "MCU F411, clock 96MHz\nPID profile: 1\nrateprofile: 0\n"}
    )
    client = BetaflightCliClient(transport)
    assert get_pid_profile_index(client) == 1


def test_get_pid_profile_index_alternate_wording():
    transport = FakeSerialTransport({"status": "System Uptime: 5s\nprofile 2\n"})
    client = BetaflightCliClient(transport)
    assert get_pid_profile_index(client) == 2


def test_get_pid_profile_index_not_found_returns_none():
    transport = FakeSerialTransport({"status": "no profile info here"})
    client = BetaflightCliClient(transport)
    assert get_pid_profile_index(client) is None
