import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

LOG_UPLOAD_DIR = Path(os.environ.get("FPV_TUNER_LOG_DIR", BASE_DIR / "data" / "logs"))
DECODE_OUTPUT_DIR = Path(os.environ.get("FPV_TUNER_DECODE_DIR", BASE_DIR / "data" / "decoded"))

BLACKBOX_DECODE_BIN = os.environ.get("FPV_TUNER_BLACKBOX_DECODE_BIN")

FC_SERIAL_PORT = os.environ.get("FPV_TUNER_FC_PORT")
FC_SERIAL_BAUD = int(os.environ.get("FPV_TUNER_FC_BAUD", "115200"))

LOG_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
DECODE_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
