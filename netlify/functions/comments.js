/*
 * Server-side comment fetcher (Netlify Function).
 * Keeps the Apify token secret on the server so visitors can fetch comments
 * from just a post link — no login, signup or API key on their side.
 *
 *   POST /.netlify/functions/comments  { url }      -> { runId }
 *   GET  /.netlify/functions/comments?runId=XXXX    -> { status, comments? }
 *
 * Environment variables (Netlify → Site configuration → Environment variables):
 *   APIFY_TOKEN     required — your Apify API token
 *   MAX_COMMENTS    optional — max comments per post (default 2000)
 *   ALLOWED_ORIGIN  optional — e.g. https://your-site.netlify.app (blocks use from other sites)
 */
'use strict';

const ACTOR = 'apify~instagram-comment-scraper';
const API = 'https://api.apify.com/v2';
const POST_RE = /^(?:https?:\/\/)?(?:www\.|m\.)?instagram\.com\/(?:[A-Za-z0-9._]+\/)?(p|reel|reels|tv)\/([A-Za-z0-9_-]{5,})/i;
const RUN_ID_RE = /^[A-Za-z0-9]{8,32}$/;
const RUNNING = new Set(['READY', 'RUNNING']);

function reply(statusCode, body, origin) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': origin || '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    },
    body: JSON.stringify(body),
  };
}

async function apify(path, token, options) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${API}${path}${sep}token=${encodeURIComponent(token)}`, options);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
  if (!res.ok) {
    const err = new Error((data && data.error && data.error.message) || `Apify HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function friendlyError(e) {
  if (e.status === 401 || e.status === 403) return 'The comment service is not configured correctly. Please try again later.';
  if (e.status === 402) return 'The comment service has reached its monthly limit. Please paste the comments manually for now.';
  return 'Could not reach the comment service. Please try again.';
}

exports.handler = async (event) => {
  const allowed = (process.env.ALLOWED_ORIGIN || '').trim();
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  if (event.httpMethod === 'OPTIONS') return reply(204, {}, allowed || '*');
  if (allowed && origin && origin !== allowed) return reply(403, { error: 'Not allowed.' }, allowed);

  const token = (process.env.APIFY_TOKEN || '').trim();
  if (!token) return reply(503, { error: 'Auto-fetch is not configured on this site yet.', code: 'NOT_CONFIGURED' }, allowed);

  try {
    if (event.httpMethod === 'POST') {
      let body = {};
      try { body = JSON.parse(event.body || '{}'); } catch (e) { /* invalid JSON */ }
      const m = String(body.url || '').trim().match(POST_RE);
      if (!m) return reply(400, { error: 'That is not a valid Instagram post or reel link.' }, allowed);
      const kind = m[1].toLowerCase() === 'reels' ? 'reel' : m[1].toLowerCase();
      const postUrl = `https://www.instagram.com/${kind}/${m[2]}/`;
      const max = Math.max(50, Math.min(10000, parseInt(process.env.MAX_COMMENTS, 10) || 2000));
      const run = await apify(`/acts/${ACTOR}/runs?timeout=280`, token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directUrls: [postUrl], resultsLimit: max, includeNestedComments: true, isNewestComments: false }),
      });
      return reply(200, { runId: run.data.id }, allowed);
    }

    if (event.httpMethod === 'GET') {
      const runId = String((event.queryStringParameters || {}).runId || '');
      if (!RUN_ID_RE.test(runId)) return reply(400, { error: 'Invalid request.' }, allowed);
      const run = await apify(`/actor-runs/${runId}`, token, { method: 'GET' });
      const status = run.data.status;
      if (RUNNING.has(status)) return reply(200, { status: 'RUNNING' }, allowed);
      if (status !== 'SUCCEEDED') return reply(200, { status: 'FAILED', error: 'Instagram did not return comments for this post. Make sure it is public and try again.' }, allowed);
      const items = await apify(`/datasets/${run.data.defaultDatasetId}/items?clean=true&format=json`, token, { method: 'GET' });
      const list = Array.isArray(items) ? items : [];
      const failed = list.find((i) => i && i.error && !i.text);
      const comments = list.filter((i) => i && !i.error).map((i) => ({
        id: i.id,
        ownerUsername: i.ownerUsername || (i.owner && i.owner.username),
        ownerProfilePicUrl: i.ownerProfilePicUrl,
        text: i.text,
        timestamp: i.timestamp,
        replies: Array.isArray(i.replies) ? i.replies.map((r) => ({ id: r.id, ownerUsername: r.ownerUsername || (r.owner && r.owner.username), ownerProfilePicUrl: r.ownerProfilePicUrl, text: r.text })) : undefined,
      }));
      if (!comments.length && failed) {
        return reply(200, { status: 'FAILED', error: 'This post could not be read. Make sure it is public and the link is correct.' }, allowed);
      }
      // Apify's free plan stops after ~15 comments; tell the visitor so they can paste the rest.
      let limited = false;
      try {
        const logRes = await fetch(`${API}/actor-runs/${runId}/log?token=${encodeURIComponent(token)}`);
        if (logRes.ok) limited = /free user limit reached|freeUserLimit/i.test(await logRes.text());
      } catch (e) { /* log is optional */ }
      return reply(200, { status: 'SUCCEEDED', comments, limited }, allowed);
    }

    return reply(405, { error: 'Method not allowed.' }, allowed);
  } catch (e) {
    return reply(502, { error: friendlyError(e) }, allowed);
  }
};
