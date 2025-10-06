#!/usr/bin/env bash
set -euo pipefail

# Portable installer for local yt-dlp and ffmpeg into ./bin next to this script.
# Usage: sudo bash install_local_tooling.sh   (admin rights suggested to fetch packages on some systems)
# After install, use: python3 twitter-dl.py "https://x.com/..."

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN_DIR="$SCRIPT_DIR/bin"
mkdir -p "$BIN_DIR"

echo "Installing into: $BIN_DIR"

# 1) Install yt-dlp standalone
YTDLP_URL="https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp"
echo "Downloading yt-dlp ..."
curl -L "$YTDLP_URL" -o "$BIN_DIR/yt-dlp"
chmod +x "$BIN_DIR/yt-dlp"
"$BIN_DIR/yt-dlp" --version || true

# 2) Install static ffmpeg build
# Use John Van Sickle's static build for Linux x86_64
FFMPEG_TARBALL_URL="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz"
TMP_DIR="$(mktemp -d)"
echo "Downloading static ffmpeg ..."
curl -L "$FFMPEG_TARBALL_URL" -o "$TMP_DIR/ffmpeg.tar.xz"
echo "Extracting ffmpeg ..."
tar -xf "$TMP_DIR/ffmpeg.tar.xz" -C "$TMP_DIR"
FFMPEG_EXTRACT_DIR="$(find "$TMP_DIR" -maxdepth 1 -type d -name 'ffmpeg-*amd64-static' | head -n1)"
if [[ -z "$FFMPEG_EXTRACT_DIR" ]]; then
  echo "Failed to locate extracted ffmpeg dir" >&2
  exit 1
fi
cp "$FFMPEG_EXTRACT_DIR/ffmpeg" "$BIN_DIR/ffmpeg"
cp "$FFMPEG_EXTRACT_DIR/ffprobe" "$BIN_DIR/ffprobe"
chmod +x "$BIN_DIR/ffmpeg" "$BIN_DIR/ffprobe"

echo "ffmpeg version: $($BIN_DIR/ffmpeg -version | head -n1)"

# 3) Python tooling (optional but recommended for module mode and gallery-dl fallback)
apt-get update -y
apt-get install -y python3-pip python3-venv  # provides pip and venv [web:52]

# Use a project-local virtualenv to avoid system Python pollution
VENV_DIR="$SCRIPT_DIR/.venv"
python3 -m venv "$VENV_DIR"
# shellcheck disable=SC1090
source "$VENV_DIR/bin/activate"
python3 -m pip install --upgrade pip setuptools wheel  # keep tooling current
python3 -m pip install yt-dlp gallery-dl  # Python modules for module-mode + image fallback [web:40][web:46]

# Provide shims so calls find local tools first when invoked by scripts
# Note: Your Python script already prefers ./bin first for external binaries.
echo 'export PATH="'"$BIN_DIR"':$PATH"' > "$SCRIPT_DIR/env.sh"
echo "Created $SCRIPT_DIR/env.sh. Source it to prefer local binaries:  source \"$SCRIPT_DIR/env.sh\""
echo "Done. Local tools installed in $BIN_DIR"
echo "To use them automatically, the Python script already checks ./bin first."
echo "You can also add to PATH in this shell: export PATH=\"$BIN_DIR:$PATH\""
echo ""
echo "Usage:"
echo "  python3 twitter-dl.py \"https://x.com/username/status/123\""
echo "  python3 twitter-dl.py urls.txt --cookies cookies.txt"
