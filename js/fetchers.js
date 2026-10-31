/*
 * Comment fetchers. Instagram does not allow reading comments anonymously
 * from a browser, so auto-fetch goes through one of two providers:
 *   1. Apify "Instagram Comment Scraper" — any public post/reel, needs a free Apify token.
 *   2. Instagram Graph API — only posts of your own Business/Creator account.
 */
(function (root) {
  'use strict';

  const Core = root.GiveawayCore;

  class FetchError extends Error {
    constructor(message, hint) {
      super(message);
      this.name = 'FetchError';
      this.hint = hint || '';
    }
  }

  async function requestJSON(url, options, timeoutMs, signal) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new DOMException('timeout', 'TimeoutError')), timeoutMs);
    const onAbort = () => ctrl.abort(signal.reason);
    if (signal) {
      if (signal.aborted) ctrl.abort(signal.reason);
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    let res;
    try {
      res = await fetch(url, Object.assign({}, options, { signal: ctrl.signal }));
    } catch (e) {
      if (signal && signal.aborted) throw new FetchError('Fetch cancelled.');
      if (ctrl.signal.aborted) throw new FetchError('The request timed out.', 'Try again, or reduce the max comments limit in Settings.');
      if (e instanceof FetchError) throw e;
      throw new FetchError('Network error — could not reach the server.', 'Check your internet connection or any ad-blocker that may block the request.');
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
    let body = null;
    const raw = await res.text();
    try { body = raw ? JSON.parse(raw) : null; } catch (e) { body = null; }
    if (!res.ok) {
      const msg = (body && body.error && (body.error.message || body.error.type)) || `HTTP ${res.status}`;
      const err = new FetchError(msg);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  }

  /* ------------------------------ Apify -------------------------------- */

  const APIFY_ACTOR = 'apify~instagram-comment-scraper';

  async function fetchViaApify(postUrl, opts) {
    const token = (opts.apifyToken || '').trim();
    const limit = Math.max(1, Math.min(10000, parseInt(opts.limit, 10) || 1000));
    const endpoint = `https://api.apify.com/v2/acts/${APIFY_ACTOR}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}&timeout=290&clean=true`;
    let items;
    try {
      items = await requestJSON(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          directUrls: [postUrl],
          resultsLimit: limit,
          includeNestedComments: true,
          isNewestComments: false,
        }),
      }, 300000, opts.signal);
    } catch (e) {
      if (e.status === 401 || e.status === 403) {
        throw new FetchError('Apify rejected the token.', 'Open Settings and paste a valid API token from console.apify.com → Settings → Integrations.');
      }
      if (e.status === 402) {
        throw new FetchError('Your Apify account is out of credits.', 'Top up on apify.com or paste the comments manually.');
      }
      if (e.status === 408) {
        throw new FetchError('Apify took too long for this post.', 'Lower “Max comments” in Settings and try again.');
      }
      throw e;
    }
    if (!Array.isArray(items)) throw new FetchError('Unexpected response from Apify.');
    const errItem = items.find((i) => i && i.error && !i.text);
    const comments = Core.normalizeItems(items.filter((i) => i && !i.error));
    if (!comments.length && errItem) {
      throw new FetchError(String(errItem.errorDescription || errItem.error), 'Make sure the post is public and the link is correct.');
    }
    return comments;
  }

  /* --------------------------- Graph API ------------------------------- */

  async function graphPaged(url, maxPages, signal) {
    const out = [];
    let next = url;
    let pages = 0;
    while (next && pages < maxPages) {
      const data = await requestJSON(next, { method: 'GET' }, 30000, signal);
      if (data && Array.isArray(data.data)) out.push(...data.data);
      next = data && data.paging && data.paging.next;
      pages++;
    }
    return { items: out, hasMore: !!next };
  }

  async function fetchViaGraph(post, opts) {
    const token = (opts.graphToken || '').trim();
    const useFacebook = opts.graphHost === 'facebook';
    const base = useFacebook ? 'https://graph.facebook.com/v21.0' : 'https://graph.instagram.com/v21.0';
    const userNode = useFacebook ? (opts.igUserId || '').trim() : 'me';
    if (useFacebook && !userNode) {
      throw new FetchError('Instagram Business account ID is missing.', 'Add it in Settings → Graph API.');
    }
    const at = `access_token=${encodeURIComponent(token)}`;

    let media;
    try {
      media = await graphPaged(`${base}/${userNode}/media?fields=id,permalink,shortcode&limit=100&${at}`, 30, opts.signal);
    } catch (e) {
      if (e.status === 400 || e.status === 401 || e.status === 190) {
        throw new FetchError('Instagram rejected the access token: ' + e.message, 'Generate a fresh token and paste it in Settings.');
      }
      throw e;
    }
    const match = media.items.find((m) =>
      (m.shortcode && m.shortcode === post.shortcode) ||
      (m.permalink && m.permalink.includes('/' + post.shortcode)));
    if (!match) {
      const err = new FetchError('This post was not found on the connected account.', 'Graph API can only read posts from your own account.');
      err.notFound = true;
      throw err;
    }
    const fields = 'id,text,username,timestamp,from,replies.limit(50){id,text,username,timestamp,from}';
    const res = await graphPaged(`${base}/${match.id}/comments?fields=${encodeURIComponent(fields)}&limit=50&${at}`, 400, opts.signal);
    return Core.normalizeItems(res.items);
  }

  /* ------------------------ Site's own server -------------------------- */

  const SERVER_ENDPOINT = '/.netlify/functions/comments';

  function noServerError() {
    const err = new FetchError('Auto-fetch isn’t available here.', 'Paste the comments below, or add your own key in Settings.');
    err.needsSetup = true;
    return err;
  }

  /** Uses the site's serverless function, so visitors need no login or API key. */
  async function fetchViaServer(post, onStatus, signal) {
    if (!/^https?:$/.test(root.location.protocol)) throw noServerError();
    let start;
    try {
      start = await requestJSON(SERVER_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: post.url }),
      }, 20000, signal);
    } catch (e) {
      if (e.body && e.body.code === 'NOT_CONFIGURED') throw noServerError();
      if (e.body && e.body.error) throw new FetchError(e.body.error);
      if (e.status) throw noServerError(); // static hosting without the function (404/405/501…)
      throw e;
    }
    if (!start || !start.runId) throw noServerError();

    const startedAt = Date.now();
    const messages = ['Reading comments from Instagram…', 'Collecting replies and mentions…', 'Almost there — large posts take a bit longer…'];
    let delay = 2500;
    while (Date.now() - startedAt < 5 * 60 * 1000) {
      onStatus && onStatus(messages[Math.min(messages.length - 1, Math.floor((Date.now() - startedAt) / 15000))]);
      await new Promise((resolve, reject) => {
        const onAbort = () => { clearTimeout(t); reject(new FetchError('Fetch cancelled.')); };
        const t = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, delay);
        if (signal) {
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        }
      });
      delay = Math.min(5000, delay + 500);
      let res;
      try {
        res = await requestJSON(`${SERVER_ENDPOINT}?runId=${encodeURIComponent(start.runId)}`, { method: 'GET' }, 25000, signal);
      } catch (e) {
        if (signal && signal.aborted) throw e;
        if (e.body && e.body.error) throw new FetchError(e.body.error);
        continue; // transient network hiccup — keep polling
      }
      if (res.status === 'SUCCEEDED') return { comments: Core.normalizeItems(res.comments || []), limited: !!res.limited };
      if (res.status === 'FAILED') throw new FetchError(res.error || 'Could not read comments for this post.', 'Make sure the post is public, or paste the comments below.');
    }
    throw new FetchError('This post is taking too long.', 'Try again in a minute, or paste the comments below.');
  }

  /**
   * Fetch comments for a post.
   * Personal keys (Settings) are used if present; otherwise the site's own server does the work.
   */
  async function fetchComments(post, settings, onStatus, signal) {
    const hasGraph = !!(settings.graphToken || '').trim();
    const hasApify = !!(settings.apifyToken || '').trim();
    if (!hasGraph && !hasApify) {
      onStatus && onStatus('Fetching comments…');
      const res = await fetchViaServer(post, onStatus, signal);
      return { comments: res.comments, limited: res.limited, provider: 'Instagram' };
    }
    let graphError = null;
    if (hasGraph) {
      try {
        onStatus && onStatus('Connecting to Instagram Graph API…');
        return { comments: await fetchViaGraph(post, Object.assign({}, settings, { signal })), provider: 'Instagram Graph API' };
      } catch (e) {
        if (!hasApify || (signal && signal.aborted)) throw e;
        graphError = e;
      }
    }
    onStatus && onStatus(graphError ? 'Not on your account — scraping public comments via Apify…' : 'Scraping public comments via Apify… (can take up to a minute)');
    return { comments: await fetchViaApify(post.url, Object.assign({}, settings, { signal, limit: settings.maxComments })), provider: 'Apify' };
  }

  root.GiveawayFetchers = { fetchComments, FetchError };
})(typeof window !== 'undefined' ? window : globalThis);
