/* Giveaway Picker — UI controller */
(function () {
  'use strict';

  const Core = window.GiveawayCore;
  const Fetchers = window.GiveawayFetchers;
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const STORE_KEYS = 'gp.settings.v1';
  const STORE_RULES = 'gp.rules.v1';

  const state = {
    step: 1,
    maxStep: 1,
    post: null,
    comments: [],
    source: '',
    pool: { entries: [], stats: null },
    rules: {},
    winners: [],      // [{ entry, confirmed }]
    rejected: [],     // usernames that failed the follow check
    drawId: '',
    drawnAt: null,
    drawToken: 0,
    drawing: false,
    skip: false,
    fetchCtrl: null,
  };

  let settings = { apifyToken: '', graphToken: '', graphHost: 'instagram', igUserId: '', maxComments: '1000', remember: true };

  /* ------------------------------ utils -------------------------------- */

  const storage = {
    get(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; } },
    set(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* storage unavailable */ } },
    del(key) { try { localStorage.removeItem(key); } catch (e) { /* storage unavailable */ } },
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function highlightMentions(text) {
    return esc(text).replace(/(^|[^A-Za-z0-9._@])@([A-Za-z0-9._]{1,30})/g, '$1<span class="mention">@$2</span>');
  }

  const fmt = (n) => Number(n || 0).toLocaleString('en-US');
  const plural = (n, one, many) => `${fmt(n)} ${n === 1 ? one : (many || one + 's')}`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const reducedMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const profileUrl = (u) => `https://www.instagram.com/${encodeURIComponent(u)}/`;

  function avatarHTML(entry) {
    const initial = esc((entry.username || '?').replace(/[^a-z0-9]/i, '').charAt(0) || '?');
    const img = entry.avatar
      ? `<img src="${esc(entry.avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`
      : '';
    return `<span class="avatar">${initial}${img}</span>`;
  }

  function toast(msg, type) {
    const el = document.createElement('div');
    el.className = 'toast ' + (type || '');
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, 2800);
  }

  function bump(el) {
    el.classList.remove('bump');
    void el.offsetWidth;
    el.classList.add('bump');
  }

  /* ---------------------------- navigation ----------------------------- */

  function goto(step) {
    if (state.drawing && step !== 3) return;
    state.step = step;
    state.maxStep = Math.max(state.maxStep, step);
    $$('[data-panel]').forEach((p) => { p.hidden = Number(p.dataset.panel) !== step; });
    renderStepper();
    window.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
  }

  function renderStepper() {
    const steps = $$('.step');
    const lines = $$('.step-line');
    steps.forEach((s) => {
      const n = Number(s.dataset.step);
      s.classList.toggle('active', n === state.step);
      s.classList.toggle('done', n < state.step || (n <= state.maxStep && n !== state.step));
      s.disabled = !canVisit(n);
    });
    lines.forEach((l, i) => l.classList.toggle('done', i + 1 < state.step));
  }

  function canVisit(n) {
    if (state.drawing) return false;
    if (n === state.step) return false;
    if (n === 1) return true;
    if (n === 2) return state.comments.length > 0;
    if (n === 3) return false;
    if (n === 4) return state.winners.length > 0;
    return false;
  }

  /* ----------------------------- settings ------------------------------ */

  function loadSettings() {
    const saved = storage.get(STORE_KEYS);
    if (saved) settings = Object.assign(settings, saved);
    $('#apifyToken').value = settings.apifyToken || '';
    $('#graphToken').value = settings.graphToken || '';
    $('#graphHost').value = settings.graphHost || 'instagram';
    $('#igUserId').value = settings.igUserId || '';
    $('#maxComments').value = settings.maxComments || '1000';
    $('#rememberKeys').checked = settings.remember !== false;
    $('#igUserIdWrap').hidden = $('#graphHost').value !== 'facebook';
    updateSettingsDot();
  }

  function updateSettingsDot() {
    $('#settingsDot').hidden = !(settings.apifyToken || settings.graphToken);
  }

  function saveSettings() {
    settings.apifyToken = $('#apifyToken').value.trim();
    settings.graphToken = $('#graphToken').value.trim();
    settings.graphHost = $('#graphHost').value;
    settings.igUserId = $('#igUserId').value.trim();
    settings.maxComments = $('#maxComments').value;
    settings.remember = $('#rememberKeys').checked;
    if (settings.remember) storage.set(STORE_KEYS, settings);
    else storage.del(STORE_KEYS);
    updateSettingsDot();
    closeModal('#settingsModal');
    toast(settings.apifyToken || settings.graphToken ? 'Auto-fetch is ready ✓' : 'Settings saved', 'ok');
  }

  let lastFocus = null;
  function openModal(sel) {
    lastFocus = document.activeElement;
    const m = $(sel);
    m.hidden = false;
    const first = m.querySelector('input, select, button:not([data-close])');
    if (first) setTimeout(() => first.focus(), 50);
  }
  function closeModal(sel) {
    $(sel).hidden = true;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  let confirmResolver = null;
  function confirmDialog(title, text, okLabel) {
    $('#confirmTitle').textContent = title;
    $('#confirmText').textContent = text;
    $('#confirmOk').textContent = okLabel || 'Yes, continue';
    openModal('#confirmModal');
    return new Promise((resolve) => { confirmResolver = resolve; });
  }
  function resolveConfirm(val) {
    if (!confirmResolver) return;
    const r = confirmResolver;
    confirmResolver = null;
    closeModal('#confirmModal');
    r(val);
  }

  /* ------------------------- step 1: comments -------------------------- */

  function validateUrl(showError) {
    const raw = $('#postUrl').value.trim();
    $('#clearUrl').hidden = !raw;
    const wrap = $('#postUrl').closest('.input-wrap');
    const msg = $('#urlMsg');
    if (!raw) { wrap.classList.remove('invalid'); msg.textContent = ''; msg.className = 'field-msg'; return null; }
    const post = Core.parsePostUrl(raw);
    if (!post) {
      if (showError) {
        wrap.classList.remove('invalid'); void wrap.offsetWidth; wrap.classList.add('invalid');
        msg.textContent = 'That doesn’t look like an Instagram post or reel link.';
        msg.className = 'field-msg';
      }
      return null;
    }
    wrap.classList.remove('invalid');
    msg.textContent = `✓ ${post.kind === 'reel' ? 'Reel' : 'Post'} detected · ${post.shortcode}`;
    msg.className = 'field-msg ok';
    return post;
  }

  function setFetching(on, text) {
    const btn = $('#fetchBtn');
    btn.classList.toggle('loading', on);
    btn.disabled = on;
    $('#postUrl').disabled = on;
    $('#fetchStatus').hidden = !on;
    if (text) $('#fetchStatusText').textContent = text;
  }

  function showFetchError(err) {
    $('#fetchErrorTitle').textContent = err.message || 'Something went wrong.';
    $('#fetchErrorHint').textContent = err.hint || '';
    $('#fetchError [data-action="open-settings"]').hidden = !err.needsSetup;
    $('#fetchError').hidden = false;
  }

  async function onFetch(e) {
    e.preventDefault();
    if (state.fetchCtrl) return;
    $('#fetchError').hidden = true;
    const post = validateUrl(true);
    if (!post) {
      if (!$('#postUrl').value.trim()) {
        $('#urlMsg').textContent = 'Paste your Instagram post link first.';
        $('#urlMsg').className = 'field-msg';
        $('#postUrl').focus();
      }
      return;
    }
    const ctrl = new AbortController();
    state.fetchCtrl = ctrl;
    setFetching(true, 'Fetching comments…');
    try {
      const res = await Fetchers.fetchComments(post, settings, (t) => { if (state.fetchCtrl === ctrl) $('#fetchStatusText').textContent = t; }, ctrl.signal);
      if (ctrl.signal.aborted) return;
      if (!res.comments.length) {
        showFetchError({ message: 'No comments found on this post.', hint: 'If the post has comments, it may be private or comments may be turned off.' });
        return;
      }
      setComments(res.comments, post, res.provider, res.limited);
      toast(`Loaded ${plural(res.comments.length, 'comment')} ✓`, 'ok');
    } catch (err) {
      if (!ctrl.signal.aborted) showFetchError(err);
    } finally {
      if (state.fetchCtrl === ctrl) state.fetchCtrl = null;
      setFetching(false);
    }
  }

  function cancelFetch() {
    if (state.fetchCtrl) {
      state.fetchCtrl.abort();
      state.fetchCtrl = null;
      setFetching(false);
      toast('Fetch cancelled');
    }
  }

  function onParse() {
    const text = $('#pasteInput').value;
    if (!text.trim()) {
      toast('Paste some comments first', 'err');
      $('#pasteInput').focus();
      return;
    }
    const comments = Core.parseComments(text);
    if (!comments.length) {
      toast('Couldn’t find any usernames in that text', 'err');
      return;
    }
    setComments(comments, validateUrl(false), 'pasted text');
    toast(`Found ${plural(comments.length, 'comment')} ✓`, 'ok');
  }

  function onFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) { toast('File is too large (max 25 MB)', 'err'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const comments = Core.parseComments(String(reader.result || ''));
      if (!comments.length) { toast('No comments found in that file', 'err'); return; }
      setComments(comments, validateUrl(false), file.name);
      toast(`Imported ${plural(comments.length, 'comment')} ✓`, 'ok');
    };
    reader.onerror = () => toast('Could not read that file', 'err');
    reader.readAsText(file);
  }

  function loadDemo() {
    const names = ['aarav.k', 'priya_sharma', 'rohan.verma', 'sneha.patel', 'kabir_09', 'ananya.rao', 'vikram.singh', 'meera_jain', 'arjun.mehta', 'isha.gupta',
      'neha_kapoor', 'aditya.nair', 'pooja.reddy', 'rahul_dev', 'tanvi.shah', 'siddharth.m', 'kavya.iyer', 'yash_malhotra', 'riya.bose', 'dev.chopra',
      'nisha.arora', 'karan_bhatia', 'simran.kaur', 'manav.joshi', 'zoya_khan', 'harsh.pandey', 'diya.menon', 'aryan_saxena', 'sana.ali', 'om.tiwari'];
    const phrases = ['Love this 😍', 'Count me in!', 'Wow amazing giveaway 🔥', 'Please pick me 🙏', 'Done all steps ✅', 'Best brand ever', 'Fingers crossed 🤞', '#giveaway let’s go'];
    const lines = [];
    for (let i = 0; i < 64; i++) {
      const u = names[Core.randomInt(names.length)];
      const tagCount = Core.randomInt(5);
      const tags = [];
      while (tags.length < tagCount) {
        const t = names[Core.randomInt(names.length)];
        if (t !== u && !tags.includes(t)) tags.push(t);
      }
      lines.push(`${u}: ${phrases[Core.randomInt(phrases.length)]} ${tags.map((t) => '@' + t).join(' ')}`.trim());
    }
    $('#pasteBox').open = true;
    $('#pasteInput').value = lines.join('\n');
    onParse();
  }

  function setComments(comments, post, source, limited) {
    $('#limitNote').hidden = !limited;
    $('#limitCount').textContent = fmt(comments.length);
    state.comments = comments;
    state.post = post || null;
    state.source = source;
    state.winners = [];
    state.rejected = [];
    state.maxStep = 1;
    $('#fetchError').hidden = true;
    renderLoaded();
    recomputePool();
    renderStepper();
    setTimeout(() => $('#loadedCard').scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' }), 60);
  }

  function renderLoaded() {
    const card = $('#loadedCard');
    if (!state.comments.length) { card.hidden = true; return; }
    card.hidden = false;
    const users = new Set(state.comments.map((c) => c.username));
    const withMention = state.comments.filter((c) => Core.extractMentions(c.text, [c.username]).length > 0).length;
    $('#loadedTitle').textContent = plural(state.comments.length, 'comment');
    $('#loadedSub').textContent = `Source: ${state.source}${state.post ? ' · ' + state.post.shortcode : ''}`;
    const openPost = $('#openPost');
    openPost.hidden = !state.post;
    if (state.post) openPost.href = state.post.url;
    $('#loadedStats').innerHTML = [
      [state.comments.length, 'Comments'],
      [users.size, 'Unique people'],
      [withMention, 'With @mentions'],
    ].map(([n, l]) => `<div class="stat"><b>${fmt(n)}</b><span>${l}</span></div>`).join('');
    $('#commentSearch').value = '';
    renderCommentList('');
  }

  function renderCommentList(query) {
    const q = query.trim().toLowerCase();
    const list = q
      ? state.comments.filter((c) => c.username.includes(q.replace(/^@/, '')) || (c.text || '').toLowerCase().includes(q))
      : state.comments;
    const LIMIT = 150;
    $('#commentList').innerHTML = list.slice(0, LIMIT).map((c, i) => `
      <li style="animation-delay:${Math.min(i, 20) * 25}ms">
        ${avatarHTML(c)}
        <div class="c-body">
          <div class="c-user">@${esc(c.username)}</div>
          <div class="c-text">${c.text ? highlightMentions(c.text) : '<i>no text</i>'}</div>
        </div>
      </li>`).join('') || '<li class="muted small">No matching comments.</li>';
    $('#commentMore').textContent = list.length > LIMIT ? `Showing ${LIMIT} of ${fmt(list.length)}` : '';
  }

  /* --------------------------- step 2: rules --------------------------- */

  function readRules() {
    const clampInt = (el, min, max) => {
      let v = parseInt(el.value, 10);
      if (isNaN(v)) v = min;
      v = Math.min(max, Math.max(min, v));
      return v;
    };
    return {
      winners: clampInt($('#winners'), 1, 100),
      minMentions: clampInt($('#minMentions'), 0, 30),
      followCheck: $('#followCheck').checked,
      host: $('#hostHandle').value,
      uniqueUsers: $('#uniqueUsers').checked,
      combineMentions: $('#combineMentions').checked,
      keyword: $('#keyword').value,
      exclude: $('#excludeList').value,
    };
  }

  function applyRules(r) {
    if (!r) return;
    if (r.winners) $('#winners').value = r.winners;
    if (r.minMentions != null) $('#minMentions').value = r.minMentions;
    $('#followCheck').checked = !!r.followCheck;
    $('#hostHandle').value = r.host || '';
    $('#uniqueUsers').checked = r.uniqueUsers !== false;
    $('#combineMentions').checked = r.combineMentions !== false;
    $('#keyword').value = r.keyword || '';
    $('#excludeList').value = r.exclude || '';
    $('#hostWrap').classList.toggle('open', !!r.followCheck);
  }

  function recomputePool() {
    const next = readRules();
    if (state.winners.length && JSON.stringify(next) !== JSON.stringify(state.rules)) {
      // rules changed after a draw: old winners no longer match the pool
      state.winners = [];
      state.rejected = [];
      state.maxStep = Math.min(state.maxStep, 2);
      renderStepper();
    }
    state.rules = next;
    storage.set(STORE_RULES, state.rules);
    state.pool = Core.buildPool(state.comments, state.rules);
    renderEligible();
  }

  function renderEligible() {
    const s = state.pool.stats;
    const r = state.rules;
    if (!s) return;
    const countEl = $('#eligibleCount');
    const prev = countEl.textContent;
    countEl.textContent = fmt(s.eligibleUsers);
    if (prev !== countEl.textContent) bump(countEl.parentElement);
    const parts = [];
    if (!r.uniqueUsers && s.entries !== s.eligibleUsers) parts.push(`${fmt(s.entries)} tickets`);
    if (s.failedMentions) parts.push(`${fmt(s.failedMentions)} too few tags`);
    if (s.failedKeyword) parts.push(`${fmt(s.failedKeyword)} missing keyword`);
    if (s.excluded) parts.push(`${fmt(s.excluded)} excluded`);
    $('#eligibleDetail').textContent = parts.length ? parts.join(' · ') : `out of ${plural(s.uniqueUsers, 'person', 'people')} who commented`;

    const msg = $('#rulesMsg');
    const btn = $('#startDraw');
    msg.className = 'field-msg center';
    if (!s.eligibleUsers) {
      btn.disabled = true;
      msg.textContent = 'No one matches these rules — try lowering the minimum mentions.';
    } else if (r.followCheck && !Core.normalizeHandle(r.host)) {
      btn.disabled = true;
      msg.textContent = 'Enter your Instagram username to use follow verification.';
    } else {
      btn.disabled = false;
      msg.textContent = s.eligibleUsers < r.winners
        ? `Only ${plural(s.eligibleUsers, 'person is', 'people are')} eligible — ${s.eligibleUsers === 1 ? 'they' : 'all of them'} will win.`
        : '';
      if (msg.textContent) msg.className = 'field-msg center ok';
    }
  }

  function onStepperClick(e) {
    const btn = e.target.closest('button[data-delta]');
    if (!btn) return;
    const input = $('#' + btn.closest('.stepper-input').dataset.target);
    const min = Number(input.min);
    const max = Number(input.max);
    const cur = parseInt(input.value, 10);
    const next = Math.min(max, Math.max(min, (isNaN(cur) ? min : cur) + Number(btn.dataset.delta)));
    if (String(next) !== input.value) {
      input.value = next;
      bump(input);
      recomputePool();
    }
  }

  function normalizeNumberInput(e) {
    const input = e.target;
    const min = Number(input.min);
    const max = Number(input.max);
    let v = parseInt(input.value, 10);
    if (isNaN(v)) v = min;
    input.value = Math.min(max, Math.max(min, v));
    recomputePool();
  }

  /* ---------------------------- step 3: draw --------------------------- */

  function newDrawId() {
    const a = new Uint8Array(4);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  }

  async function startDraw() {
    if (state.drawing) return;
    recomputePool();
    if ($('#startDraw').disabled) return;
    const picks = Core.pickWinners(state.pool.entries, state.rules.winners, []);
    if (!picks.length) { toast('No eligible participants', 'err'); return; }

    state.winners = picks.map((entry) => ({ entry, confirmed: false }));
    state.rejected = [];
    state.drawId = newDrawId();
    state.drawnAt = new Date();
    await runDrawAnimation(picks);
  }

  async function runDrawAnimation(picks) {
    const token = ++state.drawToken;
    state.drawing = true;
    state.skip = false;
    goto(3);
    $('#revealed').innerHTML = '';
    $('#skipBtn').hidden = false;
    const strip = $('#reelStrip');
    const win = $('#reelWindow');
    strip.style.transition = 'none';
    strip.style.transform = 'translateY(0)';
    strip.innerHTML = fillerItems(3);

    const alive = () => token === state.drawToken;

    // countdown
    if (!state.skip && !reducedMotion()) {
      $('#stageLabel').textContent = picks.length > 1 ? `Drawing ${picks.length} winners` : 'Drawing the winner';
      for (const n of ['3', '2', '1']) {
        if (!alive() || state.skip) break;
        $('#countdown').innerHTML = `<span>${n}</span>`;
        await sleep(800);
      }
      $('#countdown').innerHTML = '';
    }

    for (let i = 0; i < picks.length; i++) {
      if (!alive()) return;
      $('#stageLabel').textContent = picks.length > 1 ? `Winner ${i + 1} of ${picks.length}` : 'And the winner is…';
      if (!state.skip) {
        await spinTo(picks[i], token, picks.length > 3 ? 2600 : 3800);
        if (!alive()) return;
        window.Confetti.burst({ y: 0.42, count: 120 });
      }
      const li = document.createElement('li');
      li.innerHTML = `<b>${i + 1}</b>@${esc(picks[i].username)}`;
      $('#revealed').appendChild(li);
      if (!state.skip) await sleep(picks.length > 3 ? 700 : 1100);
    }
    if (!alive()) return;
    $('#countdown').innerHTML = '';
    win.classList.remove('spinning', 'slowing');
    state.drawing = false;
    renderResults();
    goto(4);
    window.Confetti.cannons();
  }

  function fillerItems(n) {
    const pool = state.pool.entries;
    let html = '';
    for (let i = 0; i < n; i++) {
      const e = pool[Core.randomInt(pool.length)];
      html += `<div class="reel-item">${avatarHTML(e)}<span class="name">@${esc(e.username)}</span></div>`;
    }
    return html;
  }

  function spinTo(entry, token, duration) {
    return new Promise((resolve) => {
      const strip = $('#reelStrip');
      const win = $('#reelWindow');
      const rowH = strip.firstElementChild ? strip.firstElementChild.getBoundingClientRect().height || 84 : 84;
      const spins = Math.max(24, Math.round(duration / 110));
      strip.style.transition = 'none';
      strip.style.transform = 'translateY(0)';
      strip.innerHTML = fillerItems(spins)
        + `<div class="reel-item target">${avatarHTML(entry)}<span class="name">@${esc(entry.username)}</span></div>`
        + fillerItems(2);
      void strip.offsetHeight;
      const targetIndex = spins; // winner row; window shows rows [index-1, index, index+1]
      const offset = (targetIndex - 1) * rowH;
      win.classList.add('spinning');
      win.classList.remove('slowing');
      strip.style.transition = `transform ${duration}ms cubic-bezier(.12,.72,.08,1)`;
      strip.style.transform = `translateY(-${offset}px)`;

      let done = false;
      const slowTimer = setTimeout(() => win.classList.add('slowing'), duration * 0.55);
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(slowTimer);
        clearTimeout(fallback);
        clearInterval(skipPoll);
        strip.removeEventListener('transitionend', onEnd);
        strip.style.transition = 'none';
        strip.style.transform = `translateY(-${offset}px)`;
        win.classList.remove('spinning', 'slowing');
        const t = strip.querySelector('.target');
        if (t) t.classList.add('win');
        resolve();
      };
      const onEnd = (ev) => { if (ev.target === strip) finish(); };
      strip.addEventListener('transitionend', onEnd);
      const fallback = setTimeout(finish, duration + 300);
      const skipPoll = setInterval(() => { if (state.skip || token !== state.drawToken) finish(); }, 80);
    });
  }

  /* -------------------------- step 4: results -------------------------- */

  function renderResults() {
    const total = state.winners.length;
    $('#resultsTitle').textContent = total > 1 ? 'Meet your winners!' : 'We have a winner!';
    $('#resultsSub').textContent = `${plural(total, 'winner')} drawn from ${plural(state.pool.stats.eligibleUsers, 'eligible participant')}`
      + (state.rules.winners > total ? ` (fewer than the ${state.rules.winners} requested — not enough eligible people)` : '');
    const grid = $('#winnersGrid');
    grid.innerHTML = '';
    state.winners.forEach((w, i) => grid.appendChild(winnerCard(w, i)));
    renderVerifyBanner();
    renderAudit();
  }

  function winnerCard(w, i) {
    const e = w.entry;
    const r = state.rules;
    const card = document.createElement('article');
    card.className = 'winner-card glass' + (w.confirmed || !r.followCheck ? ' confirmed' : '');
    card.style.animationDelay = `${i * 90}ms`;
    card.dataset.index = i;
    const host = Core.normalizeHandle(r.host);
    const mentionInfo = `${plural(e.mentions.length, 'mention')} · ${plural(e.commentCount, 'comment')}`;
    let followHTML = '';
    if (r.followCheck) {
      followHTML = w.confirmed
        ? `<div class="w-follow"><span class="w-status">✓ Follows @${esc(host)}</span></div>`
        : `<div class="w-follow">
            <p>Does @${esc(e.username)} follow @${esc(host)}?</p>
            <div class="w-follow-actions">
              <a class="btn btn-ghost btn-sm" href="${profileUrl(host)}followers/" target="_blank" rel="noopener">Check followers ↗</a>
              <button class="btn btn-sm btn-yes" type="button" data-act="yes">✓ Yes</button>
              <button class="btn btn-sm btn-no" type="button" data-act="no">✗ No — replace</button>
            </div>
          </div>`;
    }
    card.innerHTML = `
      <span class="w-rank">#${i + 1}</span>
      <div class="w-head">
        ${avatarHTML(e)}
        <div style="min-width:0">
          <a class="w-name" href="${profileUrl(e.username)}" target="_blank" rel="noopener">@${esc(e.username)}</a>
          <span class="w-meta">${mentionInfo}</span>
        </div>
      </div>
      <p class="w-comment">${e.text ? highlightMentions(e.text) : ''}</p>
      ${followHTML}
      <div class="w-actions">
        <button class="btn btn-soft btn-sm" type="button" data-act="reroll">↻ Re-pick this winner</button>
      </div>`;
    return card;
  }

  function renderVerifyBanner() {
    const banner = $('#verifyBanner');
    if (!state.rules.followCheck || !state.winners.length) { banner.hidden = true; return; }
    const pending = state.winners.filter((w) => !w.confirmed).length;
    banner.hidden = false;
    banner.classList.toggle('all-good', pending === 0);
    banner.textContent = pending === 0
      ? '✓ All winners verified — ready to announce!'
      : `⏳ ${plural(pending, 'winner')} left to verify for the follow rule`;
  }

  function renderAudit() {
    const s = state.pool.stats;
    const r = state.rules;
    const rows = [
      ['Draw ID', state.drawId],
      ['Drawn at', state.drawnAt ? state.drawnAt.toLocaleString() : '—'],
      ['Comments loaded', fmt(s.totalComments)],
      ['People who commented', fmt(s.uniqueUsers)],
      ['Eligible participants', fmt(s.eligibleUsers)],
      ['Tickets in the draw', fmt(s.entries)],
      ['Min. mentions', r.minMentions || 'None'],
      ['Follow check', r.followCheck ? '@' + Core.normalizeHandle(r.host) : 'Off'],
      ['Keyword', r.keyword ? r.keyword : 'None'],
      ['Randomness', 'crypto.getRandomValues'],
    ];
    $('#auditGrid').innerHTML = rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
    $('#rejectedWrap').hidden = !state.rejected.length;
    $('#rejectedList').innerHTML = state.rejected.map((u) => `<li>@${esc(u)}</li>`).join('');
  }

  function takenUsernames() {
    return state.winners.map((w) => w.entry.username).concat(state.rejected);
  }

  async function replaceWinner(index, reason) {
    const card = $(`.winner-card[data-index="${index}"]`);
    if (!card || card.dataset.busy) return;
    const old = state.winners[index];
    if (!old) return;
    if (reason === 'no-follow') state.rejected.push(old.entry.username);

    const exclude = takenUsernames();
    const [next] = Core.pickWinners(state.pool.entries, 1, exclude);
    if (!next) {
      if (reason === 'no-follow') {
        state.winners.splice(index, 1);
        toast('No more eligible participants — winner removed', 'err');
        renderResults();
      } else {
        toast('No other eligible participants left to pick from', 'err');
      }
      return;
    }
    card.dataset.busy = '1';
    $$('button', card).forEach((b) => { b.disabled = true; });
    const token = state.drawToken;
    await shuffleCardName(card, next);
    if (token !== state.drawToken || state.winners[index] !== old) return; // a redraw happened meanwhile
    state.winners[index] = { entry: next, confirmed: false };
    // only rebuild this card if it is still in the grid (user may have redrawn meanwhile)
    if (card.isConnected) {
      const fresh = winnerCard(state.winners[index], index);
      card.replaceWith(fresh);
      const rect = fresh.getBoundingClientRect();
      window.Confetti.burst({ x: (rect.left + rect.width / 2) / window.innerWidth, y: (rect.top + 40) / window.innerHeight, count: 70, power: 11 });
    }
    renderVerifyBanner();
    renderAudit();
    toast(`New winner: @${next.username} 🎉`, 'ok');
  }

  function shuffleCardName(card, finalEntry) {
    return new Promise((resolve) => {
      const nameEl = card.querySelector('.w-name');
      const pool = state.pool.entries;
      if (!nameEl || reducedMotion() || pool.length < 2) { resolve(); return; }
      let ticks = 0;
      const total = 16;
      const iv = setInterval(() => {
        ticks++;
        if (ticks >= total || !card.isConnected) {
          clearInterval(iv);
          nameEl.textContent = '@' + finalEntry.username;
          resolve();
          return;
        }
        nameEl.innerHTML = `<span class="shuffle-name">@${esc(pool[Core.randomInt(pool.length)].username)}</span>`;
      }, 45 + ticks * 4);
    });
  }

  function onWinnerAction(e) {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const card = btn.closest('.winner-card');
    const index = Number(card.dataset.index);
    const w = state.winners[index];
    if (!w || card.dataset.busy) return;
    const act = btn.dataset.act;
    if (act === 'yes') {
      w.confirmed = true;
      const fresh = winnerCard(w, index);
      fresh.style.animation = 'none';
      card.replaceWith(fresh);
      renderVerifyBanner();
      if (state.winners.every((x) => x.confirmed)) {
        window.Confetti.cannons();
        toast('All winners verified 🎉', 'ok');
      }
    } else if (act === 'no') {
      replaceWinner(index, 'no-follow');
    } else if (act === 'reroll') {
      confirmDialog('Re-pick this winner?', `@${w.entry.username} will be replaced by a new random participant.`, 'Re-pick').then((ok) => {
        if (ok) replaceWinner(index, 'reroll');
      });
    }
  }

  async function redrawAll() {
    if (state.drawing) return;
    const ok = await confirmDialog('Redraw all winners?', 'The current winners will be discarded and a completely fresh draw will run with the same rules.', 'Redraw');
    if (!ok) return;
    startDraw();
  }

  /* ------------------------------ exports ------------------------------ */

  function resultsText() {
    const lines = [`🏆 Giveaway winners${state.post ? ' — ' + state.post.url : ''}`, ''];
    state.winners.forEach((w, i) => lines.push(`${i + 1}. @${w.entry.username}`));
    lines.push('', `Drawn from ${fmt(state.pool.stats.eligibleUsers)} eligible participants · Draw ID ${state.drawId}`);
    return lines.join('\n');
  }

  async function copyResults() {
    const text = resultsText();
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (err) { toast('Copy failed', 'err'); ta.remove(); return; }
      ta.remove();
    }
    toast('Winner list copied ✓', 'ok');
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportCSV() {
    const q = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const rows = [['rank', 'username', 'profile', 'mentions', 'comment', 'follow_verified'].map(q).join(',')];
    state.winners.forEach((w, i) => rows.push([
      i + 1, w.entry.username, profileUrl(w.entry.username), w.entry.mentions.length, w.entry.text,
      state.rules.followCheck ? (w.confirmed ? 'yes' : 'pending') : 'n/a',
    ].map(q).join(',')));
    download(new Blob(['﻿' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' }), `giveaway-winners-${state.drawId}.csv`);
    toast('CSV downloaded ✓', 'ok');
  }

  async function downloadImage() {
    try { await document.fonts.ready; } catch (e) { /* ignore */ }
    const W = 1080;
    const H = 1350;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#07060c';
    ctx.fillRect(0, 0, W, H);
    const blob = (x, y, r, color) => {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, color); g.addColorStop(1, 'rgba(7,6,12,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    };
    blob(150, 120, 650, 'rgba(214,41,118,.55)');
    blob(980, 700, 650, 'rgba(79,91,213,.5)');
    blob(400, 1300, 600, 'rgba(250,126,30,.35)');

    const grad = ctx.createLinearGradient(0, 0, W, 0);
    ['#feda75', '#fa7e1e', '#d62976', '#962fbf', '#4f5bd5'].forEach((col, i) => grad.addColorStop(i / 4, col));

    ctx.textAlign = 'center';
    ctx.font = '120px serif';
    ctx.fillText('🏆', W / 2, 230);
    ctx.fillStyle = grad;
    ctx.font = '800 92px Syne, sans-serif';
    ctx.fillText('GIVEAWAY', W / 2, 360);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(state.winners.length > 1 ? 'WINNERS' : 'WINNER', W / 2, 460);

    const list = state.winners.slice(0, 10);
    const avail = 680;
    const rowH = Math.min(120, avail / Math.max(list.length, 1));
    const top = 560 + (avail - rowH * list.length) / 2;
    const fontSize = Math.min(58, rowH * 0.5);
    list.forEach((w, i) => {
      const y = top + i * rowH;
      const x = 140;
      const width = W - 280;
      ctx.fillStyle = 'rgba(255,255,255,.07)';
      roundRect(ctx, x, y, width, rowH - 18, 26);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.12)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = grad;
      ctx.beginPath();
      const cr = (rowH - 18) * 0.32;
      ctx.arc(x + 30 + cr, y + (rowH - 18) / 2, cr, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = `800 ${Math.round(cr)}px "Plus Jakarta Sans", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), x + 30 + cr, y + (rowH - 18) / 2 + 1);
      ctx.textAlign = 'left';
      ctx.font = `700 ${Math.round(fontSize)}px "Plus Jakarta Sans", sans-serif`;
      let name = '@' + w.entry.username;
      const maxW = width - (60 + cr * 2) - 30;
      while (ctx.measureText(name).width > maxW && name.length > 4) name = name.slice(0, -2) + '…';
      ctx.fillText(name, x + 60 + cr * 2, y + (rowH - 18) / 2 + 2);
      ctx.textBaseline = 'alphabetic';
    });
    if (state.winners.length > list.length) {
      ctx.textAlign = 'center';
      ctx.fillStyle = '#a39fb6';
      ctx.font = '600 34px "Plus Jakarta Sans", sans-serif';
      ctx.fillText(`+ ${state.winners.length - list.length} more`, W / 2, 560 + avail + 20);
    }
    ctx.textAlign = 'center';
    ctx.fillStyle = '#a39fb6';
    ctx.font = '600 30px "Plus Jakarta Sans", sans-serif';
    ctx.fillText(`Congratulations! · ${fmt(state.pool.stats.eligibleUsers)} participants`, W / 2, H - 70);

    c.toBlob((b) => {
      if (!b) { toast('Could not create image', 'err'); return; }
      download(b, `giveaway-winners-${state.drawId}.png`);
      toast('Image downloaded ✓', 'ok');
    }, 'image/png');
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* ------------------------------ reset -------------------------------- */

  async function newGiveaway() {
    const ok = await confirmDialog('Start a new giveaway?', 'Loaded comments and current winners will be cleared. Your rules and settings are kept.', 'Start new');
    if (!ok) return;
    resetComments();
  }

  function resetComments() {
    cancelFetch();
    state.drawToken++;
    state.drawing = false;
    state.comments = [];
    state.post = null;
    state.winners = [];
    state.rejected = [];
    state.maxStep = 1;
    state.pool = { entries: [], stats: null };
    $('#postUrl').value = '';
    $('#pasteInput').value = '';
    $('#loadedCard').hidden = true;
    $('#fetchError').hidden = true;
    validateUrl(false);
    goto(1);
  }

  /* ------------------------------ wiring ------------------------------- */

  function bind() {
    $('#fetchForm').addEventListener('submit', onFetch);
    $('#postUrl').addEventListener('input', () => { $('#fetchError').hidden = true; validateUrl(false); });
    $('#postUrl').addEventListener('paste', () => setTimeout(() => validateUrl(true), 0));
    $('#clearUrl').addEventListener('click', () => { $('#postUrl').value = ''; validateUrl(false); $('#postUrl').focus(); });
    $('#cancelFetch').addEventListener('click', cancelFetch);
    $('#parseBtn').addEventListener('click', onParse);
    $('#fileInput').addEventListener('change', onFile);
    $('#demoBtn').addEventListener('click', loadDemo);
    let searchTimer = 0;
    $('#commentSearch').addEventListener('input', (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => renderCommentList(e.target.value), 120);
    });

    // drag & drop file onto paste box
    const pasteBox = $('#pasteBox');
    pasteBox.addEventListener('dragover', (e) => { e.preventDefault(); pasteBox.open = true; });
    pasteBox.addEventListener('drop', (e) => {
      e.preventDefault();
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) onFile({ target: { files: [f], value: '' } });
    });

    // rules
    $$('.stepper-input').forEach((el) => el.addEventListener('click', onStepperClick));
    ['#winners', '#minMentions'].forEach((s) => {
      $(s).addEventListener('change', normalizeNumberInput);
      $(s).addEventListener('input', () => { if ($(s).value !== '') recomputePool(); });
    });
    $('#followCheck').addEventListener('change', (e) => {
      $('#hostWrap').classList.toggle('open', e.target.checked);
      if (e.target.checked && !$('#hostHandle').value) setTimeout(() => $('#hostHandle').focus(), 250);
      recomputePool();
    });
    ['#hostHandle', '#keyword', '#excludeList'].forEach((s) => $(s).addEventListener('input', recomputePool));
    ['#uniqueUsers', '#combineMentions'].forEach((s) => $(s).addEventListener('change', recomputePool));
    $('#startDraw').addEventListener('click', startDraw);

    // draw / results
    $('#skipBtn').addEventListener('click', () => { state.skip = true; $('#skipBtn').hidden = true; });
    $('#winnersGrid').addEventListener('click', onWinnerAction);
    $('#redrawBtn').addEventListener('click', redrawAll);
    $('#copyBtn').addEventListener('click', copyResults);
    $('#csvBtn').addEventListener('click', exportCSV);
    $('#imageBtn').addEventListener('click', downloadImage);

    // generic actions
    document.addEventListener('click', (e) => {
      const a = e.target.closest('[data-action]');
      if (!a) return;
      const act = a.dataset.action;
      if (act === 'home') { e.preventDefault(); if (!state.drawing) goto(1); }
      else if (act === 'goto-rules') { if (state.comments.length && !state.drawing) { recomputePool(); goto(2); } }
      else if (act === 'goto-step1') goto(1);
      else if (act === 'open-settings') openModal('#settingsModal');
      else if (act === 'show-paste') { $('#pasteBox').open = true; $('#pasteInput').focus(); }
      else if (act === 'reset-comments') resetComments();
      else if (act === 'new-giveaway') newGiveaway();
    });
    $('#stepper').addEventListener('click', (e) => {
      const s = e.target.closest('.step');
      if (!s || s.disabled) return;
      const n = Number(s.dataset.step);
      if (n === 2) recomputePool();
      goto(n);
    });

    // settings modal
    $('#settingsBtn').addEventListener('click', () => { loadSettings(); openModal('#settingsModal'); });
    $('#saveSettings').addEventListener('click', saveSettings);
    $('#clearKeys').addEventListener('click', () => {
      ['#apifyToken', '#graphToken', '#igUserId'].forEach((s) => { $(s).value = ''; });
      settings.apifyToken = ''; settings.graphToken = ''; settings.igUserId = '';
      storage.del(STORE_KEYS);
      updateSettingsDot();
      toast('Keys removed from this device');
    });
    $('#graphHost').addEventListener('change', (e) => { $('#igUserIdWrap').hidden = e.target.value !== 'facebook'; });
    $$('.tab').forEach((t) => t.addEventListener('click', () => {
      $$('.tab').forEach((x) => { x.classList.toggle('active', x === t); x.setAttribute('aria-selected', String(x === t)); });
      $$('[data-tab-panel]').forEach((p) => { p.hidden = p.dataset.tabPanel !== t.dataset.tab; });
    }));
    $$('[data-reveal]').forEach((b) => b.addEventListener('click', () => {
      const inp = $('#' + b.dataset.reveal);
      inp.type = inp.type === 'password' ? 'text' : 'password';
    }));

    // modal closing
    $('#settingsModal').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeModal('#settingsModal'); });
    $('#confirmModal').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) resolveConfirm(false); });
    $('#confirmOk').addEventListener('click', () => resolveConfirm(true));
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!$('#confirmModal').hidden) resolveConfirm(false);
      else if (!$('#settingsModal').hidden) closeModal('#settingsModal');
    });
  }

  function init() {
    loadSettings();
    applyRules(storage.get(STORE_RULES));
    state.rules = readRules();
    bind();
    goto(1);
    const params = new URLSearchParams(location.search);
    const u = params.get('url') || params.get('post');
    if (u) { $('#postUrl').value = u; validateUrl(true); }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
