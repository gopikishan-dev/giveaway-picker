/*
 * Core giveaway logic: comment parsing, mention counting, eligibility pool
 * building and cryptographically fair winner selection.
 * Pure functions only (no DOM), so it can be unit-tested in Node.
 */
(function (root) {
  'use strict';

  const HANDLE_RE = /^@?([A-Za-z0-9._]{1,30})$/;
  const MENTION_RE = /(^|[^A-Za-z0-9._@])@([A-Za-z0-9._]{1,30})/g;

  const TIMEAGO_RE = new RegExp(
    '^(?:[•·]\\s*)?(?:\\d+\\s*(?:s|m|h|d|w|y|sec|secs|second|seconds|min|mins|minute|minutes|hr|hrs|hour|hours|day|days|week|weeks|wk|wks|mo|month|months|yr|yrs|year|years)(?:\\s+ago)?|just now|yesterday)$',
    'i'
  );

  const NOISE_RES = [
    /^reply$/i,
    /^see translation$/i,
    /^like$/i,
    /^[•·]$/,
    /^\d[\d,.]*\s*[km]?\s*(likes?|replies?)$/i,
    /^[-—–_\s]*(view|hide)\s+(all\s+)?(\d+\s+)?(more\s+)?(replies|reply)(\s*\(\d+\))?$/i,
    /^(edited|pinned|author|verified|follow|following|creator|original audio)$/i,
    /^liked by .*/i,
    /^load more comments$/i,
    /^view more comments$/i,
  ];

  function normalizeHandle(raw) {
    if (raw == null) return '';
    let h = String(raw).trim().replace(/^@/, '');
    // strip verified marks or trailing junk sometimes copied with names
    h = h.replace(/[✓✔✅️]/g, '').trim();
    h = h.replace(/\.+$/, '');
    if (!/^[A-Za-z0-9._]{1,30}$/.test(h)) return '';
    return h.toLowerCase();
  }

  function isNoise(line) {
    return NOISE_RES.some((re) => re.test(line));
  }

  function isTimeAgo(line) {
    return TIMEAGO_RE.test(line);
  }

  /** Extract unique @mentions from text, ignoring emails and the given handles. */
  function extractMentions(text, ignore) {
    const out = [];
    const seen = new Set();
    const skip = new Set((ignore || []).map(normalizeHandle).filter(Boolean));
    if (!text) return out;
    MENTION_RE.lastIndex = 0;
    let m;
    while ((m = MENTION_RE.exec(String(text))) !== null) {
      const h = normalizeHandle(m[2]);
      if (!h || seen.has(h) || skip.has(h)) continue;
      seen.add(h);
      out.push(h);
    }
    return out;
  }

  /* ---------------------------- CSV helpers ---------------------------- */

  function parseCSV(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
        } else {
          field += c;
        }
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === ',' || c === '\t' || c === ';') {
        row.push(field); field = '';
      } else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        rows.push(row); row = [];
      } else {
        field += c;
      }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((f) => f.trim() !== ''));
  }

  const USER_COLS = ['username', 'ownerusername', 'owner_username', 'user', 'handle', 'author', 'owner', 'profile', 'name', 'account'];
  const TEXT_COLS = ['text', 'comment', 'comment_text', 'message', 'content', 'body', 'commenttext'];

  function tryParseCSV(text) {
    const firstLine = text.split(/\r?\n/, 1)[0] || '';
    if (!/[,\t;]/.test(firstLine)) return null;
    const rows = parseCSV(text);
    if (rows.length < 2) return null;
    const header = rows[0].map((h) => h.trim().toLowerCase().replace(/[\s"]/g, ''));
    let ui = -1;
    for (const name of USER_COLS) { ui = header.indexOf(name); if (ui !== -1) break; }
    if (ui === -1) return null;
    let ti = -1;
    for (const name of TEXT_COLS) { ti = header.indexOf(name); if (ti !== -1) break; }
    const out = [];
    for (let r = 1; r < rows.length; r++) {
      const u = normalizeHandle(rows[r][ui]);
      if (!u) continue;
      out.push({ username: u, text: ti === -1 ? '' : (rows[r][ti] || '').trim() });
    }
    return out;
  }

  /* ---------------------------- JSON helpers --------------------------- */

  /** Normalise comment objects from Apify / Graph API / generic JSON. */
  function normalizeItems(items) {
    const out = [];
    const seenIds = new Set();
    const visit = (it) => {
      if (!it || typeof it !== 'object') return;
      const username = normalizeHandle(
        it.ownerUsername || it.username ||
        (it.owner && (it.owner.username || it.owner.name)) ||
        (it.from && (it.from.username || it.from.name)) || it.user || ''
      );
      const text = String(it.text || it.comment || it.message || '').trim();
      const id = it.id != null ? String(it.id) : null;
      if (username && !(id && seenIds.has(id))) {
        if (id) seenIds.add(id);
        out.push({
          id: id || undefined,
          username,
          text,
          avatar: it.ownerProfilePicUrl || (it.owner && it.owner.profile_pic_url) || undefined,
          timestamp: it.timestamp || undefined,
        });
      }
      const replies = Array.isArray(it.replies) ? it.replies
        : (it.replies && Array.isArray(it.replies.data)) ? it.replies.data : null;
      if (replies) replies.forEach(visit);
    };
    (Array.isArray(items) ? items : [items]).forEach(visit);
    return out;
  }

  function tryParseJSON(text) {
    const t = text.trim();
    if (!(t.startsWith('[') || t.startsWith('{'))) return null;
    try {
      let data = JSON.parse(t);
      if (data && !Array.isArray(data)) {
        data = data.data || data.items || data.comments || [data];
      }
      return normalizeItems(data);
    } catch (e) {
      return null;
    }
  }

  /* -------------------------- Plain-text parser ------------------------ */

  function parseBlockFormat(lines) {
    // Instagram copy/paste: "username\n2w\ncomment text\nReply"
    const starts = [];
    for (let i = 0; i < lines.length; i++) {
      if (!isTimeAgo(lines[i])) continue;
      for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
        const l = lines[j];
        if (isNoise(l)) continue;
        const h = HANDLE_RE.test(l.replace(/[✓✔✅️]/g, '').trim()) ? normalizeHandle(l) : '';
        if (h && (!starts.length || j > starts[starts.length - 1].t)) starts.push({ u: j, t: i, username: h });
        break;
      }
    }
    const out = [];
    for (let k = 0; k < starts.length; k++) {
      const end = k + 1 < starts.length ? starts[k + 1].u : lines.length;
      const textLines = lines.slice(starts[k].t + 1, end).filter((l) => !isNoise(l) && !isTimeAgo(l));
      out.push({ username: starts[k].username, text: textLines.join(' ').trim() });
    }
    return out;
  }

  function parseLineFormat(lines) {
    const out = [];
    for (const raw of lines) {
      if (isNoise(raw) || isTimeAgo(raw)) continue;
      const line = raw.replace(/[✓✔✅️]/g, '');
      let m = line.match(/^@?([A-Za-z0-9._]{1,30})\s*[:|\t–—-]\s*(.*)$/);
      if (!m) m = line.match(/^@?([A-Za-z0-9._]{1,30})(?:\s+(.*))?$/);
      if (!m) continue;
      const u = normalizeHandle(m[1]);
      if (!u) continue;
      out.push({ username: u, text: (m[2] || '').trim() });
    }
    return out;
  }

  /** Parse whatever the user pasted / uploaded into [{username, text}]. */
  function parseComments(input) {
    const text = String(input || '').replace(/ /g, ' ');
    if (!text.trim()) return [];
    const json = tryParseJSON(text);
    if (json) return json;
    const csv = tryParseCSV(text);
    if (csv && csv.length) return csv;
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const hasTimes = lines.some(isTimeAgo);
    if (hasTimes) {
      const block = parseBlockFormat(lines);
      if (block.length) return block;
    }
    return parseLineFormat(lines);
  }

  /* ------------------------------ Links -------------------------------- */

  function parsePostUrl(url) {
    const s = String(url || '').trim();
    const m = s.match(/^(?:https?:\/\/)?(?:www\.|m\.)?instagram\.com\/(?:[A-Za-z0-9._]+\/)?(p|reel|reels|tv)\/([A-Za-z0-9_-]{5,})/i);
    if (!m) return null;
    const kind = m[1].toLowerCase() === 'reels' ? 'reel' : m[1].toLowerCase();
    return { shortcode: m[2], kind, url: `https://www.instagram.com/${kind}/${m[2]}/` };
  }

  /* --------------------------- Pool building --------------------------- */

  function parseHandleList(text) {
    return Array.from(new Set(String(text || '').split(/[\s,;]+/).map(normalizeHandle).filter(Boolean)));
  }

  /**
   * Build the list of eligible entries.
   * rules: { minMentions, uniqueUsers, combineMentions, host, keyword, exclude }
   */
  function buildPool(comments, rules) {
    const r = Object.assign({ minMentions: 0, uniqueUsers: true, combineMentions: true, host: '', keyword: '', exclude: '' }, rules || {});
    const host = normalizeHandle(r.host);
    const excluded = new Set(parseHandleList(r.exclude));
    if (host) excluded.add(host);
    const keywords = String(r.keyword || '').split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);
    const minMentions = Math.max(0, parseInt(r.minMentions, 10) || 0);

    const stats = { totalComments: comments.length, uniqueUsers: 0, excluded: 0, failedMentions: 0, failedKeyword: 0, eligibleUsers: 0, entries: 0 };

    const byUser = new Map();
    for (const c of comments) {
      const u = normalizeHandle(c.username);
      if (!u) continue;
      if (!byUser.has(u)) byUser.set(u, []);
      byUser.get(u).push(c);
    }
    stats.uniqueUsers = byUser.size;

    const hasKeyword = (t) => !keywords.length || keywords.some((k) => String(t || '').toLowerCase().includes(k));
    const entries = [];

    for (const [username, list] of byUser) {
      if (excluded.has(username)) { stats.excluded++; continue; }
      const ignore = host ? [username, host] : [username];
      const perComment = list.map((c) => ({ comment: c, mentions: extractMentions(c.text, ignore) }));
      const allMentions = Array.from(new Set(perComment.flatMap((p) => p.mentions)));
      const keywordOk = list.some((c) => hasKeyword(c.text));

      let qualifying;
      if (r.combineMentions) {
        qualifying = allMentions.length >= minMentions ? perComment.filter((p) => hasKeyword(p.comment.text)) : [];
        if (allMentions.length < minMentions) { stats.failedMentions++; continue; }
        if (!keywordOk) { stats.failedKeyword++; continue; }
      } else {
        const mentionOk = perComment.filter((p) => p.mentions.length >= minMentions);
        if (!mentionOk.length) { stats.failedMentions++; continue; }
        qualifying = mentionOk.filter((p) => hasKeyword(p.comment.text));
        if (!qualifying.length) { stats.failedKeyword++; continue; }
      }

      const best = qualifying.slice().sort((a, b) => b.mentions.length - a.mentions.length)[0] || perComment[0];
      const avatar = (list.find((c) => c.avatar) || {}).avatar;
      const base = {
        username,
        avatar,
        commentCount: list.length,
        mentions: r.combineMentions ? allMentions : best.mentions,
      };
      stats.eligibleUsers++;
      if (r.uniqueUsers) {
        entries.push(Object.assign({}, base, { text: best.comment.text }));
      } else {
        // every qualifying comment is a separate ticket
        for (const q of qualifying) {
          entries.push(Object.assign({}, base, { text: q.comment.text, mentions: r.combineMentions ? allMentions : q.mentions }));
        }
      }
    }
    stats.entries = entries.length;
    return { entries, stats };
  }

  /* ------------------------------ Random ------------------------------- */

  function getCrypto() {
    if (root.crypto && root.crypto.getRandomValues) return root.crypto;
    throw new Error('Secure random generator not available in this browser.');
  }

  /** Unbiased integer in [0, n) using rejection sampling on crypto randomness. */
  function randomInt(n) {
    if (!(n > 0)) throw new Error('randomInt: n must be > 0');
    const limit = Math.floor(0x100000000 / n) * n;
    const buf = new Uint32Array(1);
    const c = getCrypto();
    do { c.getRandomValues(buf); } while (buf[0] >= limit);
    return buf[0] % n;
  }

  /** Pick `count` entries with distinct usernames, skipping any in `excludeUsers`. */
  function pickWinners(entries, count, excludeUsers) {
    const taken = new Set((excludeUsers || []).map(normalizeHandle));
    const winners = [];
    let available = entries.filter((e) => !taken.has(e.username));
    while (winners.length < count && available.length) {
      const pick = available[randomInt(available.length)];
      winners.push(pick);
      taken.add(pick.username);
      available = available.filter((e) => e.username !== pick.username);
    }
    return winners;
  }

  function countAvailableUsers(entries, excludeUsers) {
    const taken = new Set((excludeUsers || []).map(normalizeHandle));
    const s = new Set();
    for (const e of entries) if (!taken.has(e.username)) s.add(e.username);
    return s.size;
  }

  root.GiveawayCore = {
    normalizeHandle,
    extractMentions,
    parseComments,
    normalizeItems,
    parsePostUrl,
    parseHandleList,
    buildPool,
    randomInt,
    pickWinners,
    countAvailableUsers,
    isTimeAgo,
  };
})(typeof window !== 'undefined' ? window : globalThis);
