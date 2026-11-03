#!/usr/bin/env bash
# Native SQLite + loopback listeners + Chromium require an environment allowing them.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH:?Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to installed Chromium}"
: "${YOURWIKI_PERFORMANCE_PYTHON:=python3}"
export YOURWIKI_PERFORMANCE_SERVER_PREFIX='["systemd-run","--user","--scope","--quiet","-p","CPUQuota=200%","-p","MemoryMax=4G"]'
export YOURWIKI_PERFORMANCE_REQUIRE_LIMITS=1
"$YOURWIKI_PERFORMANCE_PYTHON" apps/web/test/browser/performance.py
