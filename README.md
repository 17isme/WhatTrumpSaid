# 🇺🇸 WhatTrumpSaid

**实时监控并归档特朗普在 X (Twitter) 上的每一条发言。**

🔗 **Live Site**: [https://trumpsaid.org](https://trumpsaid.org)

---

## ✨ Features

- **自动爬取** — 每 15 分钟（±3 分钟随机抖动）自动抓取 [@realDonaldTrump](https://x.com/realDonaldTrump) 的最新推文
- **中文翻译** — 每条推文自动调用 Google Translate 翻译为中文
- **截图归档** — 对每条新推文进行元素级截图，永久保存
- **SQLite 存储** — 推文原文、译文、截图路径、抓取时间全部入库
- **REST API** — 内置 Express API 服务，支持分页查询
- **艺术画廊式前端** — 极简排版设计，将每一条推文呈现为一件视觉展品

## 🏗️ Architecture

```
┌─────────────────────────────────────────┐
│           monitor_x.js                  │
│                                         │
│  ┌──────────┐    ┌───────────────────┐  │
│  │  Scraper  │    │  Express Server   │  │
│  │ (15 min)  │    │  (port 3000)      │  │
│  │           │    │                   │  │
│  │ Playwright│    │ GET /api/tweets   │  │
│  │ → Screenshot   │ GET /api/tweets/:id │
│  │ → Translate    │ GET /api/stats    │  │
│  │ → SQLite  │    │ Static files      │  │
│  └──────────┘    └───────────────────┘  │
│                                         │
│              tweets.db (SQLite)         │
└─────────────────────────────────────────┘
```

## 🚀 Quick Start

### Prerequisites

- Node.js 18+
- Chromium browser (for Playwright)

### Installation

```bash
git clone https://github.com/17isme/WhatTrumpSaid.git
cd WhatTrumpSaid
npm install
npx playwright install --with-deps chromium
```

### Run

```bash
# Start the monitor + API server
npm start

# Or run once (no API server, no loop)
node monitor_x.js --once
```

Visit [http://localhost:3000](http://localhost:3000) to view the dashboard.

### Production (PM2)

```bash
npm install -g pm2
pm2 start monitor_x.js --name whattrumpsaid
pm2 save
pm2 startup
```

## 📡 API Reference

### `GET /api/tweets`

Returns a paginated list of tweets (newest first).

| Param   | Default | Description          |
|---------|---------|----------------------|
| `page`  | `1`     | Page number          |
| `limit` | `20`    | Items per page (max 100) |

**Response:**

```json
{
  "tweets": [
    {
      "tweet_id": "1895547890123456789",
      "tweet_url": "https://x.com/realDonaldTrump/status/...",
      "tweet_text": "MAKE AMERICA GREAT AGAIN!",
      "tweet_text_zh": "让美国再次伟大！",
      "screenshot_path": "screenshots/tweet_189..._2026-03-02_10-30-00Z.png",
      "scraped_at": "2026-03-02 10:30:00"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 42,
    "totalPages": 3
  }
}
```

### `GET /api/tweets/:id`

Returns a single tweet by ID.

### `GET /api/stats`

Returns collection statistics.

```json
{
  "totalTweets": 42,
  "latestScrapedAt": "2026-03-02 10:30:00",
  "oldestScrapedAt": "2026-03-01 08:15:00"
}
```

## 🗄️ Database Schema

| Column            | Type | Description              |
|-------------------|------|--------------------------|
| `tweet_id`        | TEXT | Tweet ID (Primary Key)   |
| `tweet_url`       | TEXT | Full URL to the tweet    |
| `tweet_text`      | TEXT | Original English text    |
| `tweet_text_zh`   | TEXT | Chinese translation      |
| `screenshot_path` | TEXT | Path to screenshot file  |
| `scraped_at`      | TEXT | Timestamp when scraped   |

## 📁 Project Structure

```
WhatTrumpSaid/
├── monitor_x.js        # Main entry: scraper + API server
├── public/
│   └── index.html      # Frontend (Vue 3 + Tailwind)
├── screenshots/        # Auto-generated tweet screenshots
├── tweets.db           # SQLite database (auto-created)
├── package.json
└── README.md
```

## ⚙️ Configuration

Constants at the top of `monitor_x.js`:

| Variable                | Default | Description                     |
|-------------------------|---------|---------------------------------|
| `CHECK_INTERVAL_SECONDS`| `900`   | Base check interval (15 min)    |
| `JITTER_SECONDS`        | `180`   | Random jitter range (±3 min)    |
| `API_PORT`              | `3000`  | API server port                 |
| `DB_FILE`               | `tweets.db` | SQLite database filename    |

## 📄 License

MIT
