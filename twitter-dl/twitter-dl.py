#!/usr/bin/env python3

"""
Twitter/X media downloader using yt-dlp.

Features:
- Accepts one or more Tweet URLs
- Downloads attached images or videos
- Saves to a specified output directory (always in root, no subfolders)
- Optional cookies.txt support for private/age-restricted content
- Automatically cleans URLs to remove query parameters and normalize domains

Configuration:
- Edit DEFAULT_OUTPUT_DIR, DEFAULT_URLS_FILE, DEFAULT_COOKIES_PATH below to set your preferred folders.

Examples:
  python3 twitter-dl.py "https://x.com/user/status/123"
  python3 twitter-dl.py "https://x.com/user/status/123" -o /custom/path
  python3 twitter-dl.py urls.txt --cookies cookies.txt

Notes:
- If you pass a file path instead of a URL, the script will read URLs line-by-line from that file (blank lines and # comments ignored).
- Install dependency: pip install yt-dlp
- For best video quality, install ffmpeg: sudo apt install ffmpeg
- The script automatically detects ffmpeg and uses it when available
- All files are saved directly to the output directory without creating subfolders
"""

# === CONFIGURATION (Edit these to your liking) ===
DEFAULT_OUTPUT_DIR   = "/home/flerf/twitter_images"
DEFAULT_URLS_FILE    = "/home/flerf/twitter_images/StuffToDl.txt"
DEFAULT_COOKIES_PATH = ""  # Set to a path if you want to use cookies.txt

# =================================================

import argparse
import os
import re
import shutil
import subprocess
import sys
from typing import Iterable, List
from urllib.parse import urlparse

try:
    import yt_dlp  # type: ignore
except Exception:  # noqa: BLE001
    yt_dlp = None  # Fallback to external binary


def clean_twitter_url(url: str) -> str:
    """
    Clean and normalize Twitter/X URLs.
    - Convert x.com to twitter.com for compatibility
    - Remove query parameters (?t=...&s=... etc.)
    - Ensure proper format: https://twitter.com/username/status/id
    """
    url = url.strip()

    # Replace x.com with twitter.com
    url = re.sub(r'^https?://x\.com/', 'https://twitter.com/', url)

    # Parse URL to remove query parameters
    parsed = urlparse(url)

    # Rebuild URL without query parameters
    clean_url = f"{parsed.scheme}://{parsed.netloc}{parsed.path}"

    # Ensure it starts with https://twitter.com
    if not clean_url.startswith('https://twitter.com/'):
        # Try to fix common variations
        if clean_url.startswith('http://twitter.com/'):
            clean_url = clean_url.replace('http://', 'https://')
        elif 'twitter.com' in clean_url and '/status/' in clean_url:
            # Extract the important parts if the URL is malformed
            match = re.search(r'twitter\.com/([^/]+)/status/(\d+)', clean_url)
            if match:
                username, tweet_id = match.groups()
                clean_url = f"https://twitter.com/{username}/status/{tweet_id}"

    return clean_url


def read_targets(targets: List[str]) -> List[str]:
    """Expand targets where any entry can be a URL or a path to a text file of URLs."""
    expanded: List[str] = []
    for target in targets:
        if is_probable_file(target):
            expanded.extend(read_urls_file(target))
        else:
            expanded.append(target)

    # Clean and filter URLs
    cleaned: List[str] = []
    seen = set()

    for u in expanded:
        u = u.strip()
        if not u or u.startswith("#"):
            continue

        # Clean the URL
        clean_url = clean_twitter_url(u)

        # Skip duplicates
        if clean_url not in seen:
            seen.add(clean_url)
            cleaned.append(clean_url)
            print(f"Cleaned URL: {u} -> {clean_url}")

    return cleaned


def is_probable_file(path: str) -> bool:
    # Treat as file if exists or looks like a local path with typical URL-host disqualifiers
    if os.path.exists(path):
        return os.path.isfile(path)
    # Heuristic: URLs typically contain "://"; if not present and contains path separators, treat as file
    return ("://" not in path) and ("/" in path or "\\" in path)


def read_urls_file(path: str) -> List[str]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            lines = [line.strip() for line in f]
        return [line for line in lines if line and not line.startswith("#")]
    except OSError as exc:
        print(f"Failed to read URLs file '{path}': {exc}", file=sys.stderr)
        return []


def check_ffmpeg_available() -> bool:
    """Check if ffmpeg is available in the system PATH."""
    return shutil.which("ffmpeg") is not None


def download_items(
    urls: Iterable[str],
    output_dir: str,
    cookies_path: str = "",
    merge_audio: bool = True,
    write_info_json: bool = False,
    write_thumbnail: bool = False,
    keep_fragments: bool = False
) -> int:
    """Download media for the given URLs using yt-dlp, fall back to gallery-dl for images."""
    os.makedirs(output_dir, exist_ok=True)

    # Modified output template to avoid subfolders and use tweet ID + title
    # This ensures files go directly to the root output directory
    outtmpl = os.path.join(output_dir, "%(id)s_%(title).100B.%(ext)s")
    format_str = "bestvideo+bestaudio/best" if merge_audio else "best"
    success_count = 0

    if yt_dlp is not None:
        ydl_opts = {
            "outtmpl": outtmpl,
            "format": format_str,
            "quiet": False,
            "no_warnings": False,
            "retries": 5,
            "fragment_retries": 10,
            "skip_unavailable_fragments": True,
            "writeinfojson": write_info_json,
            "writethumbnail": write_thumbnail,
            "keep_fragments": keep_fragments,
            # Prevent yt-dlp from creating subdirectories
            "restrictfilenames": True,
            "windowsfilenames": True,
        }
        if cookies_path:
            ydl_opts["cookiefile"] = cookies_path

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:  # type: ignore[attr-defined]
            for url in urls:
                try:
                    print(f"\n=== Downloading: {url}")
                    result = ydl.download([url])
                    if result == 0:
                        success_count += 1
                        continue  # Success, skip to next URL
                except Exception as exc:  # noqa: BLE001
                    error_msg = str(exc)
                    print(f"Download error for {url}: {error_msg}", file=sys.stderr)
                    # If yt-dlp indicates no video, try gallery-dl for images
                    if "No video could be found in this tweet" in error_msg:
                        print(f"=== No video found, trying gallery-dl (image): {url}")
                        # Use gallery-dl with flat directory structure
                        gd_args = ["gallery-dl", url, "-d", output_dir, "--filename", "{tweet_id}_{num}.{extension}"]
                        if cookies_path:
                            gd_args.extend(["--cookies", cookies_path])
                        gd_result = subprocess.run(gd_args, check=False)
                        if gd_result.returncode == 0:
                            success_count += 1
                        else:
                            print(f"Download failed for images with gallery-dl for {url}", file=sys.stderr)
        return success_count

    # Fallback: external yt-dlp binary
    script_dir = os.path.dirname(os.path.abspath(__file__))
    local_bin = os.path.join(script_dir, "bin")
    yt_dlp_path = shutil.which("yt-dlp", path=os.pathsep.join([local_bin, os.environ.get("PATH", "")]))
    if yt_dlp_path is None:
        print("Error: yt-dlp module missing and external 'yt-dlp' not found in PATH or local bin/.", file=sys.stderr)
        print("Hint: run the installer script to set up local yt-dlp and ffmpeg.", file=sys.stderr)
        return 0

    env = os.environ.copy()
    env["PATH"] = f"{local_bin}:{env.get('PATH', '')}"

    base_args = [
        yt_dlp_path,
        "--format", format_str,
        "--output", outtmpl,
        "--retries", "5",
        "--fragment-retries", "10",
        "--skip-unavailable-fragments",
        "--restrict-filenames",  # Prevent special characters that might create folders
        "--windows-filenames",   # Additional safety for filename restrictions
    ]
    if write_info_json:
        base_args.append("--write-info-json")
    if write_thumbnail:
        base_args.append("--write-thumbnail")
    if keep_fragments:
        base_args.append("--keep-fragments")
    if cookies_path:
        base_args.extend(["--cookies", cookies_path])

    for url in urls:
        print(f"\n=== Downloading (external yt-dlp): {url}")
        cmd = base_args + [url]
        try:
            result = subprocess.run(cmd, env=env, check=False, capture_output=True, text=True)
            if result.returncode == 0:
                success_count += 1
            else:
                print(f"Download failed with code {result.returncode} for {url}", file=sys.stderr)
                if "No video could be found in this tweet" in result.stderr:
                    print(f"=== No video found, trying gallery-dl (image): {url}")
                    # Use gallery-dl with flat directory structure
                    gd_args = ["gallery-dl", url, "-d", output_dir, "--filename", "{tweet_id}_{num}.{extension}"]
                    if cookies_path:
                        gd_args.extend(["--cookies", cookies_path])
                    gd_result = subprocess.run(gd_args, check=False)
                    if gd_result.returncode == 0:
                        success_count += 1
                    else:
                        print(f"Download failed for images with gallery-dl for {url}", file=sys.stderr)
        except Exception as exc:  # noqa: BLE001
            print(f"Unexpected error invoking yt-dlp for {url}: {exc}", file=sys.stderr)
    return success_count



def parse_args(argv: List[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Download images/videos from Twitter/X using yt-dlp")
    parser.add_argument(
        "targets", nargs="+",
        help=f"Tweet URLs or a text file containing URLs (one per line). Default: {DEFAULT_URLS_FILE}"
    )
    parser.add_argument(
        "-o", "--output",
        default=DEFAULT_OUTPUT_DIR,
        help=f"Output directory (default: {DEFAULT_OUTPUT_DIR})"
    )
    parser.add_argument(
        "--cookies",
        default=DEFAULT_COOKIES_PATH,
        help=f"Path to cookies.txt for authenticated/age-restricted content (default: {DEFAULT_COOKIES_PATH})"
    )
    parser.add_argument("--no-merge-audio", action="store_true", help="Do not merge best video+audio; use single best format (overrides ffmpeg detection)")
    parser.add_argument("--write-info-json", action="store_true", help="Write yt-dlp info JSON alongside media")
    parser.add_argument("--write-thumbnail", action="store_true", help="Write thumbnails if available")
    parser.add_argument("--keep-fragments", action="store_true", help="Keep intermediate fragments (debugging)")
    return parser.parse_args(argv)


def main(argv: List[str]) -> int:
    args = parse_args(argv)
    urls = read_targets(args.targets)
    if not urls:
        print("No URLs to process.", file=sys.stderr)
        return 2

    print(f"\nProcessing {len(urls)} cleaned URLs...")
    print(f"All files will be saved to: {args.output}")

    # Determine merge_audio setting
    merge_audio = not args.no_merge_audio

    # If user explicitly disabled merging, respect that
    if args.no_merge_audio:
        print("Info: Audio/video merging disabled by user.")
    elif merge_audio:
        # Check ffmpeg availability for automatic detection
        ffmpeg_available = check_ffmpeg_available()
        if not ffmpeg_available:
            print("Warning: ffmpeg not found. Audio/video merging disabled. Install ffmpeg for best quality.")
            print("  Install with: sudo apt install ffmpeg")
            merge_audio = False
        else:
            print("Info: ffmpeg detected. Will merge best video+audio for optimal quality.")

    successes = download_items(
        urls=urls,
        output_dir=args.output,
        cookies_path=args.cookies,
        merge_audio=merge_audio,
        write_info_json=args.write_info_json,
        write_thumbnail=args.write_thumbnail,
        keep_fragments=args.keep_fragments,
    )

    print(f"\nCompleted. Successful items: {successes} / {len(urls)}")
    return 0 if successes > 0 else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))