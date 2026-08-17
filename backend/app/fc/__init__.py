"""Flight controller client layer: serial transport, MSP framing, CLI client,
and Betaflight version handling.

This package is deliberately conservative: it never replays hardware/target
-specific CLI commands or config diffs captured on a different firmware
version without an explicit, version-aware safety check. See
``cli_client.BetaflightCliClient.apply_config_lines`` and
``docs/research/tuning-algorithms.md`` ("Safety Strategies") for the
rationale.
"""
