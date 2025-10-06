#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

// Add stealth plugin
puppeteer.use(StealthPlugin());

(async () => {
  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  const HOME = process.env.HOME;
  const IMAGE_DIR = path.join(HOME, 'twitter_images');
  const COUNTER_FILE = path.join(IMAGE_DIR, '.twitter_post_index');
  const COOKIES_FILE = path.join(__dirname, 'twitter_cookies_corrected.json');

  // Load cookies
  let cookies = [];
  try {
    if (fs.existsSync(COOKIES_FILE)) {
      cookies = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf-8'));
      console.log(`Loaded ${cookies.length} cookies from ${COOKIES_FILE}`);
    } else {
      console.error(`Cookie file not found: ${COOKIES_FILE}`);
      console.error('Please make sure twitter_cookies_corrected.json is in the same directory as this script');
      process.exit(1);
    }
  } catch (e) {
    console.error('Error loading cookies:', e.message);
    process.exit(1);
  }

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

  // Launch browser with stealth mode
  const browser = await puppeteer.launch({ 
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    headless: false  // Set to 'new' for headless mode
  });

  const page = await browser.newPage();

  // Set realistic viewport and user agent
  await page.setViewport({ width: 1280, height: 800 });
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');

  // Set longer timeout
  page.setDefaultTimeout(60000);

  try {
    // Navigate to X/Twitter first
    console.log('Navigating to X.com...');
    await page.goto('https://x.com', { waitUntil: 'networkidle2' });

    // Set cookies for both x.com and twitter.com domains
    console.log('Setting cookies...');
    for (const cookie of cookies) {
      try {
        await page.setCookie(cookie);
      } catch (e) {
        console.warn(`Failed to set cookie ${cookie.name}:`, e.message);
      }
    }

    // Also set cookies for twitter.com domain
    await page.goto('https://twitter.com', { waitUntil: 'networkidle2' });
    for (const cookie of cookies) {
      try {
        // Modify domain for twitter.com
        const twitterCookie = { ...cookie, domain: cookie.domain.replace('x.com', 'twitter.com') };
        await page.setCookie(twitterCookie);
      } catch (e) {
        // Ignore errors for twitter.com cookies
      }
    }

    // Navigate to home to verify login
    console.log('Checking login status...');
    await page.goto('https://x.com/home', { waitUntil: 'networkidle2' });

    // Check if we're logged in
    const isLoggedIn = await page.evaluate(() => {
      // Look for common indicators of being logged in
      return !!(
        document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]') ||
        document.querySelector('[aria-label="Profile"]') ||
        document.querySelector('[data-testid="AppTabBar_Profile_Link"]') ||
        document.querySelector('[data-testid="tweetTextarea_0"]') ||
        document.querySelector('[data-testid="toolBar"]')
      );
    });

    if (!isLoggedIn) {
      console.error('Login failed - could not detect logged in state');
      await page.screenshot({ path: '/tmp/login_failed.png', fullPage: true });
      console.error('Screenshot saved to /tmp/login_failed.png');
      process.exit(1);
    }

    console.log('Successfully logged in!');

    // Navigate to compose tweet
    console.log('Navigating to compose...');
    await page.goto('https://x.com/compose/post', { waitUntil: 'networkidle2' });

    // Wait for tweet textarea
    await page.waitForSelector('[data-testid="tweetTextarea_0"]', { visible: true });
    console.log('Compose page loaded');

    // Optional: Add text to tweet (uncomment if needed)
    // await page.type('[data-testid="tweetTextarea_0"]', 'Check this out! 🔥');

    // Upload file
    console.log('Uploading file...');
    const fileInput = await page.waitForSelector('input[type="file"]');
    await fileInput.uploadFile(filePath);

    // Wait for upload to process
    await sleep(5000);

    // Look for upload confirmation or progress
    await page.waitForSelector('[data-testid="attachments"]', { timeout: 30000 });
    console.log('File uploaded successfully');

    // Find and click Post button
    console.log('Looking for Post button...');
    let posted = false;
    for (let attempt = 0; attempt < 10; ++attempt) {
      // Try different selectors for the post button
      const postSelectors = [
        '[data-testid="tweetButton"]',
        '[data-testid="tweetButtonInline"]', 
        'div[role="button"][aria-label*="Post"]',
        'div[role="button"]:has-text("Post")',
        'button:has-text("Post")'
      ];

      let postButton = null;
      for (const selector of postSelectors) {
        try {
          postButton = await page.$(selector);
          if (postButton) {
            const isEnabled = await page.evaluate(btn => {
              return !btn.disabled && btn.getAttribute('aria-disabled') !== 'true';
            }, postButton);

            if (isEnabled) {
              console.log(`Found enabled post button with selector: ${selector}`);
              break;
            }
          }
        } catch (e) {
          // Continue to next selector
        }
        postButton = null;
      }

      if (postButton) {
        await postButton.click();
        posted = true;
        console.log('Post button clicked!');
        await page.screenshot({ path: '/tmp/twitter_after_post_click.png' });
        break;
      }

      console.log(`Attempt ${attempt + 1}: No enabled Post button found, waiting...`);
      await sleep(2000);
    }

    if (posted) {
      await sleep(5000);
      console.log(`Successfully posted: ${fileToPost}`);
      await page.screenshot({ path: '/tmp/twitter_final_state.png' });

      // Check for any error modals
      const errorModals = await page.$$eval('[role="alertdialog"], [role="dialog"]', nodes =>
        nodes.map(n => n.innerText).filter(text => 
          text.toLowerCase().includes('error') || 
          text.toLowerCase().includes('failed') ||
          text.toLowerCase().includes('try again')
        )
      );

      if (errorModals.length > 0) {
        console.warn('Possible errors detected:', errorModals);
      } else {
        console.log('Post completed successfully!');
      }
    } else {
      console.error('Failed to find enabled Post button after retries');
      await page.screenshot({ path: '/tmp/post_button_search_failed.png' });
    }

  } catch (error) {
    console.error('Script error:', error.message);
    await page.screenshot({ path: '/tmp/script_error.png', fullPage: true });
    const html = await page.content();
    fs.writeFileSync('/tmp/script_error.html', html, 'utf-8');
    console.error('Error screenshot and HTML saved to /tmp/');
  } finally {
    await browser.close();
  }
})();