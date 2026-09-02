'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../src/server');

/** Spins up the branch on an ephemeral port, in memory only. */
async function branch() {
  const { server, bank } = createServer({ dataFile: null });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (path, { method = 'GET', body = null, token = null } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  const join = async (handle, name = 'Test Person') => {
    const res = await call('/api/customers', { method: 'POST', body: { name, handle, pin: '1234' } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return { token: res.body.session.token, ...res.body };
  };

  return { server, bank, base, call, join, close: () => new Promise((r) => server.close(r)) };
}

test('the branch answers health and meta without a session', async (t) => {
  const b = await branch();
  t.after(b.close);
  const health = await b.call('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.bank, 'VaivaiBank Buryatia');
  assert.equal(health.body.audit.ok, true);

  const meta = await b.call('/api/meta');
  assert.equal(meta.body.currencies.length, 6);
  assert.ok(meta.body.tiers.length >= 5);
  assert.ok(meta.body.rates.rates.some((r) => r.code === 'MNT'));
});

test('protected routes need a bearer token', async (t) => {
  const b = await branch();
  t.after(b.close);
  const anonymous = await b.call('/api/me');
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.body.error, 'unauthorized');

  const bad = await b.call('/api/me', { token: 'not-a-real-token' });
  assert.equal(bad.status, 401);
});

test('opening an account returns a session and hides the card number', async (t) => {
  const b = await branch();
  t.after(b.close);
  const joined = await b.join('bair', 'Bair Dorzhiev');
  assert.ok(joined.token);
  assert.equal(joined.card.pan, undefined, 'the raw PAN never leaves the bank unasked');
  assert.match(joined.card.masked, /••••/);

  const me = await b.call('/api/me', { token: joined.token });
  assert.equal(me.status, 200);
  assert.equal(me.body.customer.handle, '@bair');
  assert.equal(me.body.accounts.length, 1);
  assert.equal(me.body.netWorthRub, 0);
});

test('signing in checks the PIN', async (t) => {
  const b = await branch();
  t.after(b.close);
  await b.join('sesegma', 'Sesegma Badmaeva');
  const wrong = await b.call('/api/session', { method: 'POST', body: { handle: 'sesegma', pin: '0000' } });
  assert.equal(wrong.status, 401);
  const right = await b.call('/api/session', { method: 'POST', body: { handle: 'sesegma', pin: '1234' } });
  assert.equal(right.status, 201);
  assert.ok(right.body.session.token);
});

test('instant funds credit over HTTP, in major units', async (t) => {
  const b = await branch();
  t.after(b.close);
  const me = await b.join('ayuna');
  const res = await b.call(`/api/accounts/${me.account.id}/instant-funds`, {
    method: 'POST', token: me.token, body: { amount: 1500.5, source: 'sbp' },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.balance, 150050, '1500.50 RUB became 150050 kopecks');
  assert.equal(res.body.allowance.used, 150050);
});

test('an idempotency key survives a retried HTTP call', async (t) => {
  const b = await branch();
  t.after(b.close);
  const me = await b.join('zorig');
  const body = { amount: 100, idempotencyKey: 'retry-me' };
  const first = await b.call(`/api/accounts/${me.account.id}/instant-funds`, { method: 'POST', token: me.token, body });
  const second = await b.call(`/api/accounts/${me.account.id}/instant-funds`, { method: 'POST', token: me.token, body });
  assert.equal(second.body.replayed, true);
  assert.equal(second.body.transaction.id, first.body.transaction.id);
  const me2 = await b.call('/api/me', { token: me.token });
  assert.equal(me2.body.accounts[0].balance, 10000);
});

test('a transfer to a handle moves money and shows up on both sides', async (t) => {
  const b = await branch();
  t.after(b.close);
  const a = await b.join('bair');
  const c = await b.join('sesegma');
  await b.call(`/api/accounts/${a.account.id}/instant-funds`, { method: 'POST', token: a.token, body: { amount: 5000 } });
  const sent = await b.call('/api/transfers', {
    method: 'POST', token: a.token,
    body: { fromAccountId: a.account.id, to: '@sesegma', amount: 1200, note: 'Omul money' },
  });
  assert.equal(sent.status, 201);
  const receiver = await b.call('/api/me', { token: c.token });
  assert.equal(receiver.body.accounts[0].balance, 120000);
  assert.equal(receiver.body.recent[0].description, 'Omul money');
});

test('errors come back as readable JSON with the right status', async (t) => {
  const b = await branch();
  t.after(b.close);
  const me = await b.join('bair');

  const overdraw = await b.call('/api/transfers', {
    method: 'POST', token: me.token,
    body: { fromAccountId: me.account.id, to: '@bair', amount: 10 },
  });
  assert.equal(overdraw.status, 400);
  assert.equal(overdraw.body.error, 'same_account');

  const badAmount = await b.call(`/api/accounts/${me.account.id}/instant-funds`, {
    method: 'POST', token: me.token, body: { amount: -50 },
  });
  assert.equal(badAmount.status, 400);
  assert.match(badAmount.body.message, /greater than zero/);

  const missing = await b.call('/api/nope');
  assert.equal(missing.status, 404);

  const wrongMethod = await b.call('/api/health', { method: 'POST' });
  assert.equal(wrongMethod.status, 405);
});

test('the full journey leaves the ledger balanced', async (t) => {
  const b = await branch();
  t.after(b.close);
  const me = await b.join('bair');
  const friend = await b.join('sesegma');

  await b.call(`/api/accounts/${me.account.id}/instant-funds`, { method: 'POST', token: me.token, body: { amount: 40000 } });
  const usd = await b.call('/api/accounts', { method: 'POST', token: me.token, body: { currency: 'USD' } });
  await b.call('/api/exchange', { method: 'POST', token: me.token, body: { fromAccountId: me.account.id, toAccountId: usd.body.id, amount: 10000 } });
  const vault = await b.call('/api/vaults', { method: 'POST', token: me.token, body: { name: 'Baikal trip', goal: 100000 } });
  await b.call(`/api/vaults/${vault.body.id}/move`, { method: 'POST', token: me.token, body: { amount: 5000, direction: 'in' } });
  await b.call(`/api/cards/${me.card.id}/payment`, { method: 'POST', token: me.token, body: { merchant: 'Baikal Market', amount: 899.4, category: 'groceries' } });
  const request = await b.call('/api/requests', { method: 'POST', token: friend.token, body: { amount: 250, note: 'Tea' } });
  const paid = await b.call(`/api/requests/${request.body.code}/pay`, { method: 'POST', token: me.token, body: {} });
  assert.equal(paid.status, 201);

  const audit = await b.call('/api/audit');
  assert.equal(audit.body.ok, true, JSON.stringify(audit.body));

  const overview = await b.call('/api/me', { token: me.token });
  assert.equal(overview.body.vaults.length, 1);
  assert.ok(overview.body.customer.points > 0, 'card spending earned points');
  assert.ok(overview.body.spending.rows.some((r) => r.category === 'groceries'));
});

test('one customer cannot touch another customer´s card', async (t) => {
  const b = await branch();
  t.after(b.close);
  const a = await b.join('bair');
  const c = await b.join('sesegma');
  const res = await b.call(`/api/cards/${a.card.id}/status`, { method: 'POST', token: c.token, body: { status: 'frozen' } });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'forbidden');
});

test('card details are revealed only with the PIN', async (t) => {
  const b = await branch();
  t.after(b.close);
  const me = await b.join('bair');
  const denied = await b.call(`/api/cards/${me.card.id}/reveal`, { method: 'POST', token: me.token, body: { pin: '9999' } });
  assert.equal(denied.status, 403);
  const shown = await b.call(`/api/cards/${me.card.id}/reveal`, { method: 'POST', token: me.token, body: { pin: '1234' } });
  assert.equal(shown.status, 201);
  assert.match(shown.body.pan, /^\d{4} \d{4} \d{4} \d{4}$/);
  assert.match(shown.body.cvv, /^\d{3}$/);
});

test('the app shell and its assets are served', async (t) => {
  const b = await branch();
  t.after(b.close);
  for (const [path, needle] of [['/', 'VaivaiBank'], ['/app.js', 'instant-funds'], ['/styles.css', '--surface-1']]) {
    const res = await fetch(b.base + path);
    assert.equal(res.status, 200, path);
    assert.match(await res.text(), new RegExp(needle));
  }
  // fetch() normalises "/../" away, so send the raw path down a socket.
  const leaked = await new Promise((resolve, reject) => {
    require('node:http').get({ host: '127.0.0.1', port: b.server.address().port, path: '/../package.json' }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve(text));
    }).on('error', reject);
  });
  assert.ok(!leaked.includes('vaivaibank-buryatia'), 'path traversal cannot read files outside public/');
});
