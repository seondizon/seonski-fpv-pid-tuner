"""Configuration for the Python reference implementation.

This backend is no longer a deployed server -- see the top-level README for
the mobile/ (Expo/React Native) app that's now the actively developed
product. What remains here exists purely as (a) the reference implementation
every TS port is checked against and (b) a dev-machine cross-validation
oracle (e.g. running the real `blackbox_decode` binary to diff against the
new TS decoder's output). Only the config these two roles actually need is
kept -- no server ports, no upload directories, no live FC serial settings.
"""
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

# Where app/tuning/store.py persists per-craft iteration history when its
# tests (or any future dev-machine cross-validation script) run.
TUNING_STORE_DIR = Path(os.environ.get("FPV_TUNER_TUNING_STORE_DIR", BASE_DIR / "data" / "tuning"))

# Path to a locally-built blackbox_decode binary (see scripts/build_blackbox_decode.sh),
# used by app/blackbox/decode.py for dev-machine cross-validation only.
BLACKBOX_DECODE_BIN = os.environ.get("FPV_TUNER_BLACKBOX_DECODE_BIN")

TUNING_STORE_DIR.mkdir(parents=True, exist_ok=True)
