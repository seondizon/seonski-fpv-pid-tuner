"""Tests for app.fc.blackbox_reader -- uses a binary-frame-aware fake
transport (distinct from test_fc.py's FakeSerialTransport, which is
text/CLI-command-oriented and not suitable for raw MSP frame bytes)."""
from __future__ import annotations

import struct

import pytest

from app.fc.blackbox_reader import BlackboxNotAvailableError, read_blackbox_from_fc
from app.fc.msp import MSP_DATAFLASH_READ, MSP_DATAFLASH_SUMMARY


def _build_response_frame(command: int, payload: bytes) -> bytes:
    """Builds a plain MSP v1 frame, or a jumbo frame (per msp.py's
    parse_msp_v1_response) when payload exceeds the 254-byte plain limit --
    real FCs use jumbo frames for exactly this (large dataflash-read
    chunks), so the fake must be able to produce them too."""
    size = len(payload)
    if size <= 254:
        checksum = size ^ command
        for b in payload:
            checksum ^= b
        return b"$M>" + bytes([size, command]) + payload + bytes([checksum & 0xFF])
    size_lo, size_hi = size & 0xFF, (size >> 8) & 0xFF
    checksum = 0xFF ^ command ^ size_lo ^ size_hi
    for b in payload:
        checksum ^= b
    return b"$M>" + bytes([0xFF, command, size_lo, size_hi]) + payload + bytes([checksum & 0xFF])


class FakeMspTransport:
    """Understands raw MSP v1 request frames and returns scripted binary
    responses -- used_size_bytes worth of fake flash content, served back in
    fixed-size chunks to exercise the read-loop's chunking/termination
    logic, exactly like a real FC would (chunk size decided by the FC, not
    assumed by the client).

    `.read(n, timeout=...)` serves incrementally from an internal buffer,
    exactly `n` bytes at a time (or fewer if the buffer is short) -- this
    matters because read_blackbox_from_fc uses msp.read_msp_v1_frame, which
    issues several small reads per frame (header, size/command, payload)
    rather than one big read; a fake that dumped the whole response on the
    first call (as an earlier version of this fixture did) would silently
    stop exercising the real incremental-read code path.
    """

    def __init__(self, total_size: int, used_size: int, flash_data: bytes, chunk_size: int, ready: bool = True):
        self.total_size = total_size
        self.used_size = used_size
        self.flash_data = flash_data
        self.chunk_size = chunk_size
        self.ready = ready
        self._buffer = b""
        self.read_requests: list[int] = []  # addresses requested, for assertions

    def write(self, data: bytes) -> None:
        assert data[0:3] == b"$M<"
        command = data[4]
        size = data[3]
        payload = data[5 : 5 + size]

        if command == MSP_DATAFLASH_SUMMARY:
            flags = 0x01 if self.ready else 0x00
            response_payload = bytes([flags]) + struct.pack("<III", 1, self.total_size, self.used_size)
            self._buffer += _build_response_frame(MSP_DATAFLASH_SUMMARY, response_payload)
        elif command == MSP_DATAFLASH_READ:
            (address,) = struct.unpack_from("<I", payload, 0)
            self.read_requests.append(address)
            chunk = self.flash_data[address : address + self.chunk_size]
            response_payload = struct.pack("<I", address) + chunk
            self._buffer += _build_response_frame(MSP_DATAFLASH_READ, response_payload)
        else:
            raise AssertionError(f"unexpected MSP command in test: {command}")

    def read(self, size: int, timeout: float | None = None) -> bytes:
        chunk, self._buffer = self._buffer[:size], self._buffer[size:]
        return chunk


def test_read_blackbox_from_fc_assembles_chunks_in_order():
    flash_data = bytes(range(256)) * 4  # 1024 bytes of deterministic content
    transport = FakeMspTransport(total_size=4096, used_size=len(flash_data), flash_data=flash_data, chunk_size=100)

    result = read_blackbox_from_fc(transport)

    assert result == flash_data
    # Verify it actually advanced by however much each response returned,
    # not by an assumed fixed stride unrelated to the response.
    assert transport.read_requests[0] == 0
    assert transport.read_requests[1] == 100


def test_read_blackbox_from_fc_reports_progress():
    flash_data = b"x" * 250
    transport = FakeMspTransport(total_size=1000, used_size=len(flash_data), flash_data=flash_data, chunk_size=100)

    progress_calls = []
    result = read_blackbox_from_fc(transport, on_progress=lambda done, total: progress_calls.append((done, total)))

    assert result == flash_data
    assert progress_calls[-1] == (250, 250)
    assert all(total == 250 for _, total in progress_calls)
    assert progress_calls == sorted(progress_calls)  # monotonically increasing


def test_read_blackbox_from_fc_trims_overshoot_from_last_chunk():
    # chunk_size doesn't evenly divide used_size, and the fake overshoots by
    # serving flash_data past used_size on the final read -- result must be
    # trimmed to exactly used_size, not padded with the overshoot bytes.
    flash_data = b"A" * 90 + b"B" * 20  # 110 bytes available, only 90 "used"
    transport = FakeMspTransport(total_size=1000, used_size=90, flash_data=flash_data, chunk_size=40)

    result = read_blackbox_from_fc(transport)
    assert result == b"A" * 90
    assert b"B" not in result


def test_read_blackbox_from_fc_not_ready_raises():
    transport = FakeMspTransport(total_size=1000, used_size=500, flash_data=b"x" * 500, chunk_size=100, ready=False)
    with pytest.raises(BlackboxNotAvailableError):
        read_blackbox_from_fc(transport)


def test_read_blackbox_from_fc_empty_raises():
    transport = FakeMspTransport(total_size=1000, used_size=0, flash_data=b"", chunk_size=100)
    with pytest.raises(BlackboxNotAvailableError):
        read_blackbox_from_fc(transport)


def test_read_blackbox_from_fc_zero_byte_response_raises_rather_than_hangs():
    class StuckTransport(FakeMspTransport):
        def write(self, data):
            command = data[4]
            if command == MSP_DATAFLASH_READ:
                # Simulate a misbehaving FC that returns 0 bytes instead of
                # more data or a clean end -- must raise, not loop forever.
                payload = struct.pack("<I", 0)
                self._buffer += _build_response_frame(MSP_DATAFLASH_READ, payload)
            else:
                super().write(data)

    transport = StuckTransport(total_size=1000, used_size=500, flash_data=b"x" * 500, chunk_size=100)
    with pytest.raises(RuntimeError, match="0 bytes"):
        read_blackbox_from_fc(transport)


def test_read_blackbox_from_fc_uses_jumbo_chunks_and_real_chunk_size():
    """Regression test: read_blackbox_from_fc now requests large
    (>254-byte) chunks via the MSP jumbo-frame extension (matching real
    Betaflight Configurator behavior -- plain MSP v1's 255-byte payload cap
    would make a multi-megabyte download take an impractical number of
    round trips). This exercises a chunk size large enough to force
    FakeMspTransport's jumbo-frame response path."""
    flash_data = bytes((i % 256) for i in range(5000))
    transport = FakeMspTransport(total_size=100_000, used_size=len(flash_data), flash_data=flash_data, chunk_size=2048)

    result = read_blackbox_from_fc(transport)

    assert result == flash_data
    # 5000 bytes at 2048/chunk needs 3 requests (2048, 2048, 904), not 40+
    # requests the way a 128-byte-chunk assumption would have needed.
    assert len(transport.read_requests) == 3
