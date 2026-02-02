const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SCREENSHOT_DIR = 'screenshots';
const STATE_FILE = 'state.json';
const CHECK_INTERVAL_SECONDS = 900; // 15 minutes

function ensureDir(directory) {
    if (!fs.existsSync(directory)) {
        fs.mkdirSync(directory);
    }
}

function loadState() {
    if (fs.existsSync(STATE_FILE)) {
        try {
            const data = fs.readFileSync(STATE_FILE, 'utf8');
            return JSON.parse(data);
        } catch (e) {
            console.error('Error reading state file:', e);
        }
    }
    return { last_seen_id: 0 };
}

function saveState(lastSeenId) {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify({ last_seen_id: lastSeenId }), 'utf8');
    } catch (e) {
        console.error('Error writing state file:', e);
    }
}

function getTweetId(url) {
    const match = url.match(/\/status\/(\d+)/);
    return match ? BigInt(match[1]) : BigInt(0);
}

// Helper to format date for filename
function getTimestamp() {
    const now = new Date();
    return now.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, -1);
}

async function checkAndScreenshot() {
    ensureDir(SCREENSHOT_DIR);
    const state = loadState();
    // Use BigInt for IDs since Twitter IDs are large integers
    let lastSeenId = BigInt(state.last_seen_id || 0);
    console.log(`Last seen ID: ${lastSeenId}`);

    console.log('Launching browser...');
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        viewport: { width: 1280, height: 720 }
    });
    const page = await context.newPage();

    try {
        console.log('Navigating to https://x.com/realDonaldTrump...');
        await page.goto('https://x.com/realDonaldTrump', { timeout: 60000 });

        console.log('Waiting for tweets...');
        await page.waitForSelector('article[data-testid="tweet"]', { timeout: 30000 });

        // Give a little extra time for layout to settle
        await page.waitForTimeout(2000);

        const tweetsLocators = await page.locator('article[data-testid="tweet"]').all();
        console.log(`Found ${tweetsLocators.length} visible tweets.`);

        let newMaxId = lastSeenId;
        let newTweetsFound = false;

        const scrapedTweets = [];

        for (const t of tweetsLocators) {
            try {
                // Find the link with the ID
                const linkLocator = t.locator('a[href*="/status/"]').first();
                const url = await linkLocator.getAttribute('href');
                if (url) {
                    const tId = getTweetId(url);
                    scrapedTweets.push({ id: tId, element: t, url: url });
                }
            } catch (e) {
                console.error(`Error parsing tweet: ${e}`);
            }
        }

        for (const t of scrapedTweets) {
            if (t.id > lastSeenId) {
                console.log(`New tweet found! ID: ${t.id}`);

                const timestamp = getTimestamp();
                const filename = path.join(SCREENSHOT_DIR, `tweet_${t.id}_${timestamp}.png`);

                // Scroll into view
                await t.element.scrollIntoViewIfNeeded();
                await page.waitForTimeout(500);

                await t.element.screenshot({ path: filename });
                console.log(`Saved screenshot: ${filename}`);

                if (t.id > newMaxId) {
                    newMaxId = t.id;
                }

                newTweetsFound = true;
            }
        }

        if (newTweetsFound) {
            console.log(`Updating state to ID: ${newMaxId}`);
            // Save as string because JSON doesn't support BigInt
            saveState(newMaxId.toString());
        } else {
            console.log('No new tweets.');
        }

    } catch (e) {
        console.error(`Error during check: ${e}`);
    } finally {
        await browser.close();
    }
}

async function main() {
    const isOnce = process.argv.includes('--once');
    console.log(`Starting X Monitor. Checking every ${CHECK_INTERVAL_SECONDS} seconds.`);

    // Initial run
    await checkAndScreenshot();

    if (isOnce) {
        console.log('Run once complete.');
        return;
    }

    // Loop
    while (true) {
        console.log(`Sleeping for ${CHECK_INTERVAL_SECONDS} seconds...`);
        await new Promise(resolve => setTimeout(resolve, CHECK_INTERVAL_SECONDS * 1000));

        console.log(`\n--- Checking at ${new Date().toISOString()} ---`);
        await checkAndScreenshot();
    }
}

if (require.main === module) {
    main();
}
