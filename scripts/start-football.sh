#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
command -v node >/dev/null || { echo 'Use Cloud Shell or install Node.js 22 or later.' >&2; exit 1; }
env_dir=.firebase/football-env
if [[ ! -x "$env_dir/bin/python" ]]; then
  python3 -m venv "$env_dir"
fi
if ! "$env_dir/bin/python" -c 'import yt_dlp, imageio_ffmpeg' 2>/dev/null; then
  "$env_dir/bin/python" -m pip install --disable-pip-version-check 'yt-dlp[default]' imageio-ffmpeg
fi
if [[ ${1:-} == --preview ]]; then
  shift
  preview_log=$("$env_dir/bin/python" scripts/hosting.py preview --channel football)
  echo "$preview_log"
  studio_url=${preview_log##*release verified: }
  exec "$env_dir/bin/python" scripts/football_server.py --studio "$studio_url" "$@"
fi
exec "$env_dir/bin/python" scripts/football_server.py "$@"
