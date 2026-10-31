# Giveaway Picker

A premium, animated Instagram giveaway picker. Paste a post link, set your rules, and draw fair random winners with a slot-machine style reveal.

## Features

- **Auto-fetch comments from a post link** (one-time setup, see below), or paste / upload comments (Instagram copy-paste, `user: text` lines, CSV or JSON exports)
- **Number of winners**: each winner is a different account
- **Minimum @mentions**: count tags per comment or across all of a person's comments
- **Follow verification (optional)**: confirm each winner follows you; anyone who doesn't is replaced automatically
- **Redraw all winners** or **re-pick a single winner** at any time
- Optional keyword / hashtag filter, exclude list, one-entry-per-person toggle
- Animated countdown, spinning reel, confetti, and fully responsive layout
- Export: copy list, CSV, and a 1080×1350 winners image ready for Stories / posts
- Fair: uses `crypto.getRandomValues` with unbiased rejection sampling, plus a draw ID and audit details

## Run it

It's a static site, so there's no build step:

- Open `index.html` directly in a browser, **or**
- Serve the folder (e.g. `npx serve .`) / host it free on GitHub Pages or Netlify.

## Auto-fetch setup (one time)

Instagram blocks websites from reading comments directly, so auto-fetch uses a connector. Open **Settings (⚙)** in the app:

1. **Any public post (recommended)**: create a free account at [apify.com](https://apify.com), copy your API token from *Settings → API & Integrations*, and paste it. Comments are fetched with the *Instagram Comment Scraper*.
2. **Your own account only**: paste an Instagram Graph API token (Business/Creator account). This is free and official.

Keys are stored only in your browser. Without a key you can still paste comments or upload a file.

## Tests

```bash
node --test tests/*.test.js
```

---

Developed by Gopi Kishan
