#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

(async () => {
  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  const IMAGE_DIR = process.env.TWITTER_IMAGE_DIR || "/workspace/twitter_images";
  const COUNTER_FILE = path.join(IMAGE_DIR, ".twitter_post_index");

  // Get (and sort) image and video files
  const files = fs.readdirSync(IMAGE_DIR)
    .filter(f => /\.(jpe?g|png|mp4|mov|avi|webm|mkv|gif)$/i.test(f))
    .sort();

  if (!files.length) {
    console.error('No images or videos to post.');
    process.exit(1);
  }

  // Load counter
  let idx = 0;
  try {
    if (fs.existsSync(COUNTER_FILE)) {
      idx = parseInt(fs.readFileSync(COUNTER_FILE, 'utf-8'), 10);
      if (isNaN(idx) || idx >= files.length) idx = 0;
    }
  } catch (e) {
    idx = 0;
  }

  const fileToPost = files[idx];
  const filePath = path.join(IMAGE_DIR, fileToPost);

  // Increment and save counter for next run
  let nextIdx = idx + 1;
  if (nextIdx >= files.length) nextIdx = 0;
  try {
    fs.writeFileSync(COUNTER_FILE, nextIdx.toString(), 'utf-8');
  } catch (e) {
    console.warn('Could not write counter file:', e);
  }

  console.log(`Posting ${filePath} (file #${idx+1} of ${files.length})…`);

  let browser, page, errorLogs = [];
  try {
    browser = await puppeteer.launch({ args: ['--no-sandbox'], headless: 'new' });
    page = await browser.newPage();

    // Log in
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });
    page.setDefaultTimeout(60000);

    // Prefer the x.com domain, fall back to twitter.com
    let loginUrl = 'https://x.com/i/flow/login';
    await page.goto(loginUrl, { waitUntil: 'networkidle2' }).catch(async () => {
      loginUrl = 'https://twitter.com/i/flow/login';
      await page.goto(loginUrl, { waitUntil: 'networkidle2' });
    });

    async function isAlreadyLoggedIn() {
      try {
        // Heuristics for an authenticated session
        const selector = '[data-testid="SideNav_AccountSwitcher_Button"], a[aria-label="Profile"], [data-testid="AppTabBar_Profile_Link"]';
        return !!(await page.$(selector));
      } catch (_) {
        return false;
      }
    }

    // If we land on a page that indicates we are already logged in, skip login
    if (!(await isAlreadyLoggedIn())) {
      try {
        // Username/email/phone field. Try multiple selectors as X often changes these.
        const usernameSelector = 'input[name="text"], input[autocomplete="username"], input[type="text"][inputmode="email"]';
        await page.waitForSelector(usernameSelector, { visible: true });
        await page.type(usernameSelector, 'memenimals4life', { delay: 50 });
        await page.keyboard.press('Enter');

        // In some flows, X prompts again for username/phone; handle gracefully
        try {
          await page.waitForSelector('input[name="password"], input[type="password"]', { visible: true, timeout: 20000 });
        } catch (_) {
          const maybeSecondUsername = await page.$(usernameSelector);
          if (maybeSecondUsername) {
            await page.evaluate(sel => { const el = document.querySelector(sel); if (el) el.value = ''; }, usernameSelector);
            await page.type(usernameSelector, 'memenimals4life', { delay: 50 });
            await page.keyboard.press('Enter');
          }
          await page.waitForSelector('input[name="password"], input[type="password"]', { visible: true });
        }

        await page.type('input[name="password"], input[type="password"]', 'a19863387A', { delay: 50 });
        await page.keyboard.press('Enter');
        await page.waitForNavigation({ waitUntil: 'networkidle2' });
      } catch (e) {
        try { await page.screenshot({ path: '/tmp/twitter_login_error.png', fullPage: true }); } catch (_) {}
        try { fs.writeFileSync('/tmp/twitter_login_error.html', await page.content(), 'utf-8'); } catch (_) {}
        console.error('Login flow failed. Saved /tmp/twitter_login_error.png and /tmp/twitter_login_error.html');
        throw e;
      }
    }

    // Compose tweet
    await page.goto('https://twitter.com/compose/tweet', { waitUntil: 'networkidle2' });
    await page.waitForSelector('div[data-testid="tweetTextarea_0"]', { visible: true });
    // await page.type('div[data-testid="tweetTextarea_0"]', 'Automated post'); // Optional caption

    // Upload file (image or video)
    const fileInput = await page.waitForSelector('input[type="file"]', { visible: true });
    await fileInput.uploadFile(filePath);
    await sleep(4000);

    let posted = false;
    for (let attempt = 0; attempt < 8; ++attempt) {
      const btnEls = await page.$$('div[role="button"],button');
      let enabledBtn = null;
      for (const btn of btnEls) {
        const text = await page.evaluate(el => el.innerText || '', btn);
        const disabled = await page.evaluate(el => el.disabled || el.getAttribute("aria-disabled") === "true", btn);
        if (/^(Post|Tweet)$/i.test(text.trim()) && !disabled) {
          enabledBtn = btn;
          break;
        }
      }
      if (enabledBtn) {
        await enabledBtn.click();
        posted = true;
        await page.screenshot({path: '/tmp/twitter_after_post_click.png'});
        break;
      }
      console.log(`Attempt ${attempt+1}: No enabled Post/Tweet button found, retrying…`);
      await sleep(2000);
    }

    if (posted) {
      await sleep(5000);
      await page.screenshot({path: '/tmp/twitter_after_wait.png'});
      const modals = await page.$$eval('div[role="alertdialog"],div[role="dialog"]', nodes =>
        nodes.map(n => n.innerText)
      );
      if (modals.length) {
        console.log('Modals/dialogs detected after posting:', modals);
      }
      console.log(`Posted: ${fileToPost}`);
      if (!modals.length) {
        console.log("If no tweet appears, check the screenshot '/tmp/twitter_after_wait.png', your Twitter page, and check for Twitter account security or automation block messages.");
      }
    } else {
      console.error('Did not find an enabled Post/Tweet button after retries.');
      const html = await page.content();
      fs.writeFileSync('/tmp/tweet_compose_latest.html', html, 'utf-8');
      console.error('HTML snapshot for debug at /tmp/tweet_compose_latest.html');
      throw new Error('Failed to find enabled Post/Tweet button after retries');
    }

  } catch (error) {
    console.error('Script execution failed:', error);
    errorLogs.push(`Error: ${error.message}`);
    errorLogs.push(`Stack: ${error.stack}`);

    // Capture additional diagnostics
    const screenshots = [];
    try {
      if (page) {
        const screenshotPath = `/tmp/twitter_error_${Date.now()}.png`;
        await page.screenshot({ path: screenshotPath, fullPage: true });
        screenshots.push(screenshotPath);

        const htmlPath = `/tmp/twitter_error_${Date.now()}.html`;
        fs.writeFileSync(htmlPath, await page.content(), 'utf-8');
        errorLogs.push(`HTML saved to: ${htmlPath}`);
      }
    } catch (e) {
      errorLogs.push(`Failed to capture diagnostics: ${e.message}`);
    }

    // Email removed here - error is only logged.

    throw error; // Re-throw to maintain original behavior
  } finally {
    if (browser) {
      await browser.close();
    }
  }
})();
