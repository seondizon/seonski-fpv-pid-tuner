"""Blackbox log decoding and parsing.

This package never vendors or links against betaflight/blackbox-tools
(GPL-3.0) source. `decode.py` shells out to a separately-built/installed
`blackbox_decode` binary as an external subprocess; `logdata.py` parses the
CSV that binary produces. See docs/research/licenses.md#betaflight-blackbox-tools
for the licensing rationale.
"""

from app.blackbox.decode import decode_log, find_blackbox_decode_binary
from app.blackbox.logdata import BlackboxLog, load_blackbox_csv

__all__ = [
    "decode_log",
    "find_blackbox_decode_binary",
    "BlackboxLog",
    "load_blackbox_csv",
]
