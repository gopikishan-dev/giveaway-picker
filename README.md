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

## Deploy on Netlify (link-only auto-fetch, no login for visitors)

Visitors only paste a post link. Comments are fetched by a small serverless function (`netlify/functions/comments.js`) that uses **your** Apify token, kept secret on the server.

1. Import this repo in Netlify. Leave the build command empty; `netlify.toml` already sets publish dir `.` and the functions folder.
2. Create a free account at [apify.com](https://apify.com) and copy your API token (*Settings → API & Integrations*).
3. In Netlify go to **Site configuration → Environment variables** and add:
   - `APIFY_TOKEN`: your token (required)
   - `MAX_COMMENTS`: max comments per post, default `2000` (optional)
   - `ALLOWED_ORIGIN`: your site URL, e.g. `https://your-site.netlify.app`, so other sites can't use your quota (recommended)
4. Redeploy. Done: paste any public post link and comments load automatically.

Apify usage is billed to your Apify account (the free plan includes monthly credits). Check usage at console.apify.com.

Without the function (e.g. opening `index.html` locally) users can still paste comments or upload a file. Settings (⚙) also lets a user add their own key.

## Tests

```bash
node --test tests/*.test.js
```

---

Developed by Gopi Kishan
