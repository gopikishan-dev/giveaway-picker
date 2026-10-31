const test = require('node:test');
const assert = require('node:assert');
require('../js/core.js');
const C = globalThis.GiveawayCore;

test('parsePostUrl handles posts, reels and junk', () => {
  assert.strictEqual(C.parsePostUrl('https://www.instagram.com/p/C1a2B3c4D5e/?igsh=abc').shortcode, 'C1a2B3c4D5e');
  assert.strictEqual(C.parsePostUrl('instagram.com/reel/Cx_Y-z12345/').kind, 'reel');
  assert.strictEqual(C.parsePostUrl('https://instagram.com/reels/Cx_Y-z12345').kind, 'reel');
  assert.strictEqual(C.parsePostUrl('https://www.instagram.com/someuser/p/ABCDEFG123/').shortcode, 'ABCDEFG123');
  assert.strictEqual(C.parsePostUrl('https://example.com/p/abc'), null);
  assert.strictEqual(C.parsePostUrl(''), null);
});

test('extractMentions dedupes, ignores emails and self', () => {
  const m = C.extractMentions('hey @Priya @priya @aman. mail me a@b.com @me', ['me']);
  assert.deepStrictEqual(m, ['priya', 'aman']);
});

test('parses "user: text" lines', () => {
  const r = C.parseComments('rahul: hi @a @b\n@priya_k love it @c\nsolo_user');
  assert.deepStrictEqual(r.map((x) => x.username), ['rahul', 'priya_k', 'solo_user']);
  assert.strictEqual(r[0].text, 'hi @a @b');
});

test('parses Instagram copy-paste block format', () => {
  const txt = `brand.page
Big giveaway! Tag 2 friends
1w
rahul.s
2w
Count me in @a @b
Reply
See translation
priya_k
Verified
3d
@c @d @e
12 likes
Reply
View replies (2)`;
  const r = C.parseComments(txt);
  // the caption block (text between handle and time) is not a comment and is skipped
  assert.deepStrictEqual(r.map((x) => x.username), ['rahul.s', 'priya_k']);
  assert.strictEqual(r[0].text, 'Count me in @a @b');
  assert.strictEqual(r[1].text, '@c @d @e');
});

test('parses CSV and JSON exports', () => {
  const csv = C.parseComments('id,ownerUsername,text\n1,rahul,"hi, @a @b"\n2,priya,yo');
  assert.deepStrictEqual(csv, [{ username: 'rahul', text: 'hi, @a @b' }, { username: 'priya', text: 'yo' }]);
  const json = C.parseComments(JSON.stringify([{ id: '1', ownerUsername: 'Ram', text: 'x', replies: [{ id: '2', ownerUsername: 'sita', text: '@ram' }] }]));
  assert.deepStrictEqual(json.map((x) => x.username), ['ram', 'sita']);
});

test('buildPool applies mentions, host exclusion, keyword', () => {
  const comments = [
    { username: 'a', text: '@x @y' },
    { username: 'b', text: '@x' },
    { username: 'b', text: '@z' },
    { username: 'host', text: '@x @y @z' },
    { username: 'c', text: '@host @x' },
  ];
  let p = C.buildPool(comments, { minMentions: 2, host: 'host' });
  assert.deepStrictEqual(p.entries.map((e) => e.username).sort(), ['a', 'b']);
  assert.strictEqual(p.stats.excluded, 1);
  p = C.buildPool(comments, { minMentions: 2, host: 'host', combineMentions: false });
  assert.deepStrictEqual(p.entries.map((e) => e.username), ['a']);
  p = C.buildPool(comments, { minMentions: 0, keyword: '@z' });
  assert.deepStrictEqual(p.entries.map((e) => e.username).sort(), ['b', 'host']);
  p = C.buildPool(comments, { uniqueUsers: false });
  assert.strictEqual(p.entries.length, 5);
});

test('pickWinners returns distinct users and respects exclusions', () => {
  const entries = [];
  for (let i = 0; i < 20; i++) entries.push({ username: 'u' + (i % 7) });
  for (let run = 0; run < 200; run++) {
    const w = C.pickWinners(entries, 5, ['u0']);
    assert.strictEqual(w.length, 5);
    assert.strictEqual(new Set(w.map((x) => x.username)).size, 5);
    assert.ok(!w.some((x) => x.username === 'u0'));
  }
  assert.strictEqual(C.pickWinners(entries, 50, []).length, 7);
  assert.strictEqual(C.pickWinners([], 3, []).length, 0);
});

test('randomInt is roughly uniform', () => {
  const counts = [0, 0, 0];
  for (let i = 0; i < 30000; i++) counts[C.randomInt(3)]++;
  counts.forEach((c) => assert.ok(c > 9000 && c < 11000, String(counts)));
});
