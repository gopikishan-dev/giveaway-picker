const test = require('node:test');
const assert = require('node:assert');
const { handler } = require('../netlify/functions/comments.js');

function mockFetch(routes) {
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    for (const [re, resp] of routes) {
      if (re.test(url)) return { ok: resp.status < 400, status: resp.status, text: async () => JSON.stringify(resp.body) };
    }
    return { ok: false, status: 404, text: async () => '{}' };
  };
  return calls;
}

test('returns NOT_CONFIGURED without token', async () => {
  delete process.env.APIFY_TOKEN;
  const r = await handler({ httpMethod: 'POST', headers: {}, body: '{}' });
  assert.strictEqual(r.statusCode, 503);
  assert.strictEqual(JSON.parse(r.body).code, 'NOT_CONFIGURED');
});

test('start run validates the link and keeps the token server-side', async () => {
  process.env.APIFY_TOKEN = 'secret';
  const calls = mockFetch([[/\/acts\/.+\/runs/, { status: 201, body: { data: { id: 'RUNabc12345' } } }]]);
  let r = await handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ url: 'https://evil.com' }) });
  assert.strictEqual(r.statusCode, 400);
  r = await handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ url: 'https://www.instagram.com/reels/ABCDE12345/?x=1' }) });
  assert.deepStrictEqual(JSON.parse(r.body), { runId: 'RUNabc12345' });
  assert.ok(!r.body.includes('secret'));
  assert.deepStrictEqual(JSON.parse(calls[0].opts.body).directUrls, ['https://www.instagram.com/reel/ABCDE12345/']);
});

test('poll returns running, then comments', async () => {
  process.env.APIFY_TOKEN = 'secret';
  mockFetch([[/actor-runs/, { status: 200, body: { data: { status: 'RUNNING' } } }]]);
  let r = await handler({ httpMethod: 'GET', headers: {}, queryStringParameters: { runId: 'RUNabc12345' } });
  assert.strictEqual(JSON.parse(r.body).status, 'RUNNING');
  mockFetch([
    [/actor-runs/, { status: 200, body: { data: { status: 'SUCCEEDED', defaultDatasetId: 'DS1' } } }],
    [/datasets\/DS1/, { status: 200, body: [{ id: '1', ownerUsername: 'ram', text: '@a @b', replies: [{ id: '2', ownerUsername: 'sita', text: 'hi' }] }] }],
  ]);
  r = await handler({ httpMethod: 'GET', headers: {}, queryStringParameters: { runId: 'RUNabc12345' } });
  const b = JSON.parse(r.body);
  assert.strictEqual(b.status, 'SUCCEEDED');
  assert.strictEqual(b.comments[0].replies[0].ownerUsername, 'sita');
  r = await handler({ httpMethod: 'GET', headers: {}, queryStringParameters: { runId: '../x' } });
  assert.strictEqual(r.statusCode, 400);
});

test('blocks other origins when ALLOWED_ORIGIN is set', async () => {
  process.env.ALLOWED_ORIGIN = 'https://mine.netlify.app';
  const r = await handler({ httpMethod: 'POST', headers: { origin: 'https://other.com' }, body: '{}' });
  assert.strictEqual(r.statusCode, 403);
  delete process.env.ALLOWED_ORIGIN;
});

test('flags runs stopped by the Apify free-plan limit', async () => {
  process.env.APIFY_TOKEN = 'secret';
  global.fetch = async (url) => {
    const body = /\/log/.test(url) ? 'INFO stopping pagination: free user limit reached'
      : /actor-runs/.test(url) ? JSON.stringify({ data: { status: 'SUCCEEDED', defaultDatasetId: 'DS1' } })
      : JSON.stringify([{ id: '1', ownerUsername: 'ram', text: 'hi' }]);
    return { ok: true, status: 200, text: async () => body };
  };
  const r = await handler({ httpMethod: 'GET', headers: {}, queryStringParameters: { runId: 'RUNabc12345' } });
  assert.strictEqual(JSON.parse(r.body).limited, true);
});
