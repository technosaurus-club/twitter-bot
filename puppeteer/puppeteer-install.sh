#!/usr/bin/env bash
set -euo pipefail

# Detect distro
if ! command -v apt-get >/dev/null 2>&1; then
  echo "This script targets Debian/Ubuntu (apt). For other distros, install Node.js, Chromium, and Puppeteer deps accordingly."
  exit 1
fi

# Update base system
export DEBIAN_FRONTEND=noninteractive
apt-get update -y && apt-get upgrade -y  # keep system current
apt-get install -y curl ca-certificates gnupg git build-essential  # basics for Node/npm builds [web:10]

# Install modern Node.js from NodeSource (v22 LTS/current)
curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh  # NodeSource setup [web:10]
bash /tmp/nodesource_setup.sh  # adds apt repo [web:10]
apt-get install -y nodejs  # installs node + npm [web:10]

# Verify Node and npm
node -v
npm -v

# Install Chromium and all common Puppeteer runtime deps
# Installing system chromium also ensures all required shared libs exist. [web:10]
apt-get install -y chromium-browser || apt-get install -y chromium  # one of these exists depending on Ubuntu version [web:10]
apt-get install -y \
  libx11-xcb1 libxcomposite1 libasound2 libatk1.0-0 libatk-bridge2.0-0 \
  libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgbm1 libglib2.0-0 \
  libgtk-3-0 libnspr4 libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 libx11-6 \
  libxcb1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 \
  libxss1 libxtst6  # common headless Chrome deps [web:6][web:11][web:15]

# Create a project folder beside this script if not running inside one
PROJECT_DIR="${PROJECT_DIR:-/opt/twitter-poster}"
mkdir -p "$PROJECT_DIR"
cd "$PROJECT_DIR"

# Initialize Node project if needed
if [ ! -f package.json ]; then
  npm init -y  # bare package.json
fi

# Install puppeteer (bundles a Chromium) and puppeteer-extra + stealth plugin
# Using full puppeteer ensures executablePath() is available and avoids "puppeteer-core requires executablePath" pitfalls. [web:1][web:5]
npm install puppeteer puppeteer-extra puppeteer-extra-plugin-stealth --save  # core libs [web:5][web:1]

# Ensure a runnable entrypoint that uses the system/bundled Chromium path automatically.
# If your script filename differs, adjust SCRIPT_FILE.
SCRIPT_FILE="post_to_twitter.js"
if [ ! -f "$SCRIPT_FILE" ]; then
  echo "Place your Node script as $PROJECT_DIR/$SCRIPT_FILE before running the wrapper, or rename SCRIPT_FILE in this installer."  # guidance
fi

# Create a wrapper that sets an explicit executablePath and standard args
# This avoids env differences where puppeteer-core or cron can’t find Chromium. [web:1][web:2]
tee twitter_post_wrapper.js >/dev/null <<'JS'
#!/usr/bin/env node
const { existsSync } = require('fs');
const path = require('path');

// Prefer Puppeteer’s bundled Chromium; fallback to typical distro paths.
const pptr = require('puppeteer'); // full puppeteer (has executablePath) [web:1]
const puppeteer = require('puppeteer-extra'); // plugin wrapper [web:5]
const StealthPlugin = require('puppeteer-extra-plugin-stealth'); // stealth [web:5]
puppeteer.use(StealthPlugin());

function chromiumPath() {
  // Puppeteer-bundled Chromium
  try {
    const { executablePath } = require('puppeteer'); // available with full puppeteer [web:1]
    const p = executablePath();
    if (p && existsSync(p)) return p;
  } catch (_) {}
  // System locations (Ubuntu/Debian)
  const candidates = [
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable'
  ];
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c;
    } catch (_) {}
  }
  return null;
}

(async () => {
  // Load the user’s original script module in the same process so it can use puppeteer-extra already configured here.
  const scriptPath = path.resolve(__dirname, 'post_to_twitter.js'); // adjust if different
  if (!existsSync(scriptPath)) {
    console.error(`Cannot find Node script at ${scriptPath}`);
    process.exit(1);
  }

  // Patch global require to return our configured puppeteer instance if user script requires('puppeteer-extra').
  const Module = require('module');
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'puppeteer-extra') return puppeteer; // hand back configured instance [web:5]
    return originalLoad(request, parent, isMain);
  };

  // Launch once here and expose via global so script can reuse if desired.
  const execPath = chromiumPath();
  const launchOpts = {
    headless: false, // can switch to 'new' for headless mode
    executablePath: execPath || undefined, // let Puppeteer pick if bundled present [web:1]
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage'
    ] // common in container/CI [web:15][web:11]
  };

  // Expose a helper so the script can import it if needed, else the script can still create its own browser.
  global.__PUPPETEER_EXTRA__ = { puppeteer, launchOpts };

  // Execute user script
  require(scriptPath);
})();
JS

chmod +x twitter_post_wrapper.js

# Create a helper runner for convenience
tee run-twitter-poster.sh >/dev/null <<'SH'
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
# Ensure HOME has twitter_images
mkdir -p "$HOME/twitter_images"
# Run the wrapper which prepares puppeteer-extra + stealth and sensible launch options
node twitter_post_wrapper.js
SH
chmod +x run-twitter-poster.sh
apt-get install -y xvfb

echo
echo "Installation complete."
echo "Next steps:"
echo "1) Copy your original Node script into: $PROJECT_DIR/post_to_twitter.js"
echo "   (Paste your provided code there; it currently requires twitter_cookies_corrected.json beside it.)"
echo "2) Put media files into: ~/twitter_images"
echo "3) Copy your cookie file into: $PROJECT_DIR/twitter_cookies_corrected.json"
echo "4) Run: $PROJECT_DIR/run-twitter-poster.sh"
echo
echo "Troubleshooting:"
echo "- If Chromium fails to launch, this system now has the common shared-library deps installed."
echo "  You can also set PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser explicitly."
echo "- For cron, use a full PATH and HOME, and consider DISPLAY/Xvfb if running with a visible browser."