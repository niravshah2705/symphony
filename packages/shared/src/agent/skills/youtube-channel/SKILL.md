# Skill: youtube-channel

**Trigger**: `/youtube-channel`

Crawl all videos from a YouTube channel or playlist URL, download transcripts, and generate a structured local archive with CSV metadata, per-video Markdown, a summary index, and a global index — all organised under `year/month/short-title/`.

---

## What this skill does

1. Asks the user for a YouTube channel URL or playlist URL (if not already provided).
2. Asks for an output directory (defaults to current directory `.`).
3. Runs `crawler.py` inside the project's local venv.
4. Reports progress and summarises the result.

---

## Step-by-step instructions for Claude

### Step 1 — Collect inputs

If the user invoked the skill without a URL, ask:

> "Please provide the YouTube channel URL (e.g. `https://www.youtube.com/@channelname`) or playlist URL (e.g. `https://www.youtube.com/playlist?list=PLxxx`)."

If no output directory was specified, use the **current working directory** (`.`).

### Step 2 — Locate the crawler

The canonical crawler lives at:

```
/Users/niravshah2705/git/reasearch/youtubeChannel/crawler.py
```

The run wrapper (handles venv setup automatically):

```
/Users/niravshah2705/git/reasearch/youtubeChannel/run.sh
```

### Step 3 — Ensure venv and dependencies exist

```bash
cd /Users/niravshah2705/git/reasearch/youtubeChannel
bash setup.sh
```

This is safe to re-run; it is idempotent.

### Step 4 — Run the crawler

```bash
/Users/niravshah2705/git/reasearch/youtubeChannel/run.sh "<URL>" "<output_dir>"
```

Example:

```bash
/Users/niravshah2705/git/reasearch/youtubeChannel/run.sh \
  "https://www.youtube.com/@mkbhd" \
  "./mkbhd-archive"
```

Use the `Bash` tool with `run_in_background: false` so the user sees live progress.

### Step 5 — Report results

After the crawler exits, report:

- Total videos processed
- Number of transcripts downloaded vs skipped
- Paths to: `videos.csv`, `SUMMARY.md`, `GLOBAL.md`, `CLAUDE_ACCESS.md`
- Tree of output directory (top two levels)

Run `find <output_dir> -maxdepth 3 -type f | head -60` to build the tree.

### Step 6 — Offer next steps

Suggest:

> - "Read `GLOBAL.md` and tell me which videos cover topic X"
> - "Summarise all transcripts from 2024"
> - "Open `videos.csv` and list videos by speaker"

---

## Output structure

```
<output_dir>/
├── videos.csv              ← title, description, speaker, year, month, date, url
├── SUMMARY.md              ← chronological index grouped by year, links to video.md
├── GLOBAL.md               ← full detail dump (descriptions) for semantic Q&A
├── CLAUDE_ACCESS.md        ← how to query this archive with Claude
└── <year>/
    └── <month>/
        └── <short-title>/
            ├── video.md        ← title, metadata table, full description
            └── transcript.srt  ← full spoken transcript (if captions available)
```

---

## Error handling

| Situation | Action |
|-----------|--------|
| `venv/` missing | Run `setup.sh` automatically before crawling |
| Transcript unavailable | Log "no transcript available", continue |
| yt-dlp rate-limited | Script retries with 0.5 s delay between videos |
| Invalid URL | Report the yt-dlp error message to the user |
| No videos found | Inform user and suggest checking the URL |

---

## Re-running on the same directory

The crawler skips videos that already have a `*.srt` file, so re-running is safe and only processes new videos.

---

## Dependencies

Managed inside the project venv (`venv/`):

| Package | Purpose |
|---------|---------|
| `yt-dlp` | Video metadata + transcript download |
| `youtube-transcript-api` | Fallback transcript fetcher |
