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

# 3) Ensure pip is installed
if ! command -v pip3 >/dev/null 2>&1; then
  echo "Installing pip3 ..."
  apt-get update
  apt-get install -y python3-pip
fi

# 4) Install gallery-dl via pip
echo "Installing gallery-dl via pip3 ..."
pip3 install --upgrade --user gallery-dl

# Optional: Add gallery-dl to ./bin for local usage (symlink)
GDL_BIN="$(python3 -m site --user-base)/bin/gallery-dl"
if [[ -f "$GDL_BIN" ]]; then
  ln -sf "$GDL_BIN" "$BIN_DIR/gallery-dl"
fi
"$BIN_DIR/gallery-dl" --version || true

echo "Done. Local tools installed in $BIN_DIR"
echo "To use them automatically, the Python script already checks ./bin first."
echo "You can also add to PATH in this shell: export PATH=\"$BIN_DIR:$PATH\""
echo ""
echo "Usage:"
echo "  python3 twitter-dl.py \"https://x.com/username/status/123\""
echo "  python3 twitter-dl.py urls.txt --cookies cookies.txt"
