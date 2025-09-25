#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const https = require('https');
const tls = require('tls');
const querystring = require('querystring');
const { spawn } = require('child_process');

(async () => {
  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
  
  // Email configuration - Set these environment variables or modify here
  const EMAIL_CONFIG = {
    to: process.env.EMAIL_TO || 'your-email@gmail.com',
    from: process.env.EMAIL_FROM || 'your-email@gmail.com',
    password: process.env.EMAIL_PASSWORD || 'your-app-password', // Use Gmail App Password
    smtp: {
      host: 'smtp.gmail.com',
      port: 587
    }
  };

  // Email helper function - Simple implementation using curl/system command
  async function sendErrorEmail(error, logs = '', screenshots = []) {
    if (!EMAIL_CONFIG.to || !EMAIL_CONFIG.from || !EMAIL_CONFIG.password) {
      console.log('Email not configured. Set EMAIL_TO, EMAIL_FROM, and EMAIL_PASSWORD environment variables.');
      return;
    }

    const subject = `Twitter Bot Error - ${new Date().toISOString()}`;
    const errorDetails = `
Error: ${error.message}
Stack: ${error.stack}

Logs:
${logs}

Screenshots: ${screenshots.join(', ')}

File being posted: ${fileToPost || 'Unknown'}
Timestamp: ${new Date().toISOString()}
    `.trim();

    // Use curl to send email via Gmail SMTP
    const emailData = querystring.stringify({
      to: EMAIL_CONFIG.to,
      from: EMAIL_CONFIG.from,
      subject: subject,
      text: errorDetails
    });

    return new Promise((resolve, reject) => {
      
      // Create a temporary file with the email content
      const tempFile = `/tmp/email_${Date.now()}.txt`;
      const emailContent = `To: ${EMAIL_CONFIG.to}
From: ${EMAIL_CONFIG.from}
Subject: ${subject}

${errorDetails}`;
      
      fs.writeFileSync(tempFile, emailContent);
      
      // Use curl to send email via Gmail SMTP
      const curl = spawn('curl', [
        '--url', `smtps://smtp.gmail.com:587`,
        '--ssl-reqd',
        '--mail-from', EMAIL_CONFIG.from,
        '--mail-rcpt', EMAIL_CONFIG.to,
        '--user', `${EMAIL_CONFIG.from}:${EMAIL_CONFIG.password}`,
        '--upload-file', tempFile,
        '--verbose'
      ]);

      let output = '';
      curl.stdout.on('data', (data) => output += data);
      curl.stderr.on('data', (data) => output += data);

      curl.on('close', (code) => {
        fs.unlinkSync(tempFile); // Clean up temp file
        if (code === 0) {
          console.log('Error email sent successfully');
          resolve();
        } else {
          console.error('Failed to send error email:', output);
          reject(new Error(`Curl failed with code ${code}`));
        }
      });

      curl.on('error', (err) => {
        fs.unlinkSync(tempFile); // Clean up temp file
        console.error('Error sending email:', err);
        reject(err);
      });
    });
  }

  const HOME = process.env.HOME;
  const IMAGE_DIR = path.join(HOME, 'twitter_images');
  const COUNTER_FILE = path.join(IMAGE_DIR, '.twitter_post_index');

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
      // Capture diagnostics before failing fast
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
    
    // Send error email
    try {
      await sendErrorEmail(error, errorLogs.join('\n'), screenshots);
    } catch (emailError) {
      console.error('Failed to send error email:', emailError);
    }
    
    throw error; // Re-throw to maintain original behavior
  } finally {
    if (browser) {
      await browser.close();
    }
  }
})();

