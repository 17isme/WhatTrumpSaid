const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const translate = require('google-translate-api-x');
const express = require('express');

const DB_FILE = 'tweets.db';
const SCREENSHOT_DIR = 'screenshots';
const CHECK_INTERVAL_SECONDS = 900; // 15 minutes
const JITTER_SECONDS = 180; // ±3 minutes random jitter
const API_PORT = 3000;

// ── Database ────────────────────────────────────────────────────────────────

function initDatabase() {
    const db = new Database(DB_FILE);

    // Enable WAL mode for better concurrent read performance
    db.pragma('journal_mode = WAL');

    db.exec(`
        CREATE TABLE IF NOT EXISTS tweets (
            tweet_id        TEXT PRIMARY KEY,
            tweet_url       TEXT NOT NULL,
            tweet_text      TEXT,
            tweet_text_zh   TEXT,
            screenshot_path TEXT,
            scraped_at      TEXT NOT NULL DEFAULT (datetime('now'))
        );
    `);

    // Migration: add tweet_text_zh column if upgrading from older schema
    try {
        db.exec(`ALTER TABLE tweets ADD COLUMN tweet_text_zh TEXT;`);
    } catch (_) {
        // Column already exists, ignore
    }

    return db;
}

function getLastSeenId(db) {
    const row = db.prepare(`
        SELECT tweet_id FROM tweets ORDER BY CAST(tweet_id AS INTEGER) DESC LIMIT 1
    `).get();
    return row ? BigInt(row.tweet_id) : BigInt(0);
}

function insertTweet(db, { tweetId, tweetUrl, tweetText, tweetTextZh, screenshotPath }) {
    const stmt = db.prepare(`
        INSERT OR IGNORE INTO tweets (tweet_id, tweet_url, tweet_text, tweet_text_zh, screenshot_path)
        VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(tweetId.toString(), tweetUrl, tweetText, tweetTextZh, screenshotPath);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function ensureDir(directory) {
    if (!fs.existsSync(directory)) {
        fs.mkdirSync(directory, { recursive: true });
    }
}

function getTweetId(url) {
    const match = url.match(/\/status\/(\d+)/);
    return match ? BigInt(match[1]) : BigInt(0);
}

async function translateText(text) {
    if (!text || text.trim().length === 0) return '';
    try {
        const res = await translate(text, { from: 'en', to: 'zh-CN' });
        return res.text;
    } catch (e) {
        console.error(`  Translation failed: ${e.message}`);
        return '';
    }
}

function getTimestamp() {
    const now = new Date();
    return now.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, -1);
}

// ── Core Logic ──────────────────────────────────────────────────────────────

async function checkAndScreenshot(db) {
    ensureDir(SCREENSHOT_DIR);
    const lastSeenId = getLastSeenId(db);
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

        const scrapedTweets = [];

        for (const t of tweetsLocators) {
            try {
                // Find the link with the tweet ID
                const linkLocator = t.locator('a[href*="/status/"]').first();
                const url = await linkLocator.getAttribute('href');
                if (url) {
                    const tId = getTweetId(url);

                    // Extract tweet text content
                    let tweetText = '';
                    try {
                        const textEl = t.locator('div[data-testid="tweetText"]').first();
                        tweetText = await textEl.innerText({ timeout: 3000 });
                    } catch (_) {
                        // Some tweets may not have text (e.g. media-only)
                    }

                    scrapedTweets.push({ id: tId, element: t, url, text: tweetText });
                }
            } catch (e) {
                console.error(`Error parsing tweet: ${e}`);
            }
        }

        let newTweetsCount = 0;

        for (const t of scrapedTweets) {
            if (t.id > lastSeenId) {
                console.log(`New tweet found! ID: ${t.id}`);

                // Screenshot
                const timestamp = getTimestamp();
                const filename = path.join(SCREENSHOT_DIR, `tweet_${t.id}_${timestamp}.png`);

                await t.element.scrollIntoViewIfNeeded();
                await page.waitForTimeout(500);
                await t.element.screenshot({ path: filename });
                console.log(`Saved screenshot: ${filename}`);

                // Translate to Chinese
                let tweetTextZh = '';
                if (t.text) {
                    console.log(`  Original: ${t.text.substring(0, 100)}${t.text.length > 100 ? '...' : ''}`);
                    tweetTextZh = await translateText(t.text);
                    if (tweetTextZh) {
                        console.log(`  Translated: ${tweetTextZh.substring(0, 100)}${tweetTextZh.length > 100 ? '...' : ''}`);
                    }
                }

                // Save to database
                const fullUrl = t.url.startsWith('http') ? t.url : `https://x.com${t.url}`;
                insertTweet(db, {
                    tweetId: t.id,
                    tweetUrl: fullUrl,
                    tweetText: t.text,
                    tweetTextZh: tweetTextZh,
                    screenshotPath: filename
                });
                console.log(`Saved to database: ${t.id}`);

                newTweetsCount++;
            }
        }

        if (newTweetsCount > 0) {
            console.log(`Saved ${newTweetsCount} new tweet(s) to database.`);
        } else {
            console.log('No new tweets.');
        }

    } catch (e) {
        console.error(`Error during check: ${e}`);
    } finally {
        await browser.close();
    }
}

// ── API Server ──────────────────────────────────────────────────────────────

function startApiServer(db) {
    const app = express();

    // CORS for local development
    app.use((req, res, next) => {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Headers', 'Content-Type');
        next();
    });

    // Serve static files
    app.use(express.static(path.join(__dirname, 'public')));
    app.use('/screenshots', express.static(path.join(__dirname, SCREENSHOT_DIR)));

    // GET /api/tweets — list tweets (newest first), with pagination
    app.get('/api/tweets', (req, res) => {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
        const offset = (page - 1) * limit;

        const tweets = db.prepare(`
            SELECT * FROM tweets
            ORDER BY CAST(tweet_id AS INTEGER) DESC
            LIMIT ? OFFSET ?
        `).all(limit, offset);

        const total = db.prepare('SELECT COUNT(*) AS count FROM tweets').get().count;

        res.json({
            tweets,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit)
            }
        });
    });

    // GET /api/tweets/:id — single tweet
    app.get('/api/tweets/:id', (req, res) => {
        const tweet = db.prepare('SELECT * FROM tweets WHERE tweet_id = ?').get(req.params.id);
        if (!tweet) return res.status(404).json({ error: 'Tweet not found' });
        res.json(tweet);
    });

    // GET /api/stats — basic statistics
    app.get('/api/stats', (req, res) => {
        const total = db.prepare('SELECT COUNT(*) AS count FROM tweets').get().count;
        const latest = db.prepare(`
            SELECT scraped_at FROM tweets ORDER BY CAST(tweet_id AS INTEGER) DESC LIMIT 1
        `).get();
        const oldest = db.prepare(`
            SELECT scraped_at FROM tweets ORDER BY CAST(tweet_id AS INTEGER) ASC LIMIT 1
        `).get();

        res.json({
            totalTweets: total,
            latestScrapedAt: latest?.scraped_at || null,
            oldestScrapedAt: oldest?.scraped_at || null
        });
    });

    app.listen(API_PORT, () => {
        console.log(`API server running at http://localhost:${API_PORT}`);
    });
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
    const isOnce = process.argv.includes('--once');
    const db = initDatabase();

    // Start API server (unless --once mode)
    if (!isOnce) {
        startApiServer(db);
    }

    console.log(`Starting X Monitor. Checking every ~${CHECK_INTERVAL_SECONDS}s (±${JITTER_SECONDS}s jitter).`);

    // Initial run
    await checkAndScreenshot(db);

    if (isOnce) {
        console.log('Run once complete.');
        db.close();
        return;
    }

    // Graceful shutdown
    process.on('SIGINT', () => {
        console.log('\nShutting down... closing database.');
        db.close();
        process.exit(0);
    });

    // Loop
    while (true) {
        const jitter = Math.floor(Math.random() * JITTER_SECONDS * 2) - JITTER_SECONDS;
        const sleepTime = CHECK_INTERVAL_SECONDS + jitter;
        console.log(`Sleeping for ${sleepTime} seconds (base ${CHECK_INTERVAL_SECONDS}s, jitter ${jitter > 0 ? '+' : ''}${jitter}s)...`);
        await new Promise(resolve => setTimeout(resolve, sleepTime * 1000));

        console.log(`\n--- Checking at ${new Date().toISOString()} ---`);
        await checkAndScreenshot(db);
    }
}

if (require.main === module) {
    main();
}
