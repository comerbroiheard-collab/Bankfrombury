'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Ledger } = require('../src/ledger');

const fresh = () => new Ledger({});

test('entries must balance within each currency', () => {
  const ledger = fresh();
  const a = ledger.createAccount({ name: 'A' });
  const b = ledger.createAccount({ name: 'B' });
  assert.throws(
    () => ledger.post({ type: 't', description: 'x', entries: [{ accountId: a.id, amount: -100 }, { accountId: b.id, amount: 90 }] }),
    /do not balance/,
  );
  assert.equal(a.balance, 0, 'a rejected transaction moves nothing');
  assert.equal(b.balance, 0);
});

test('a multi-currency transaction balances per currency', () => {
  const ledger = fresh();
  const rub = ledger.createAccount({ name: 'RUB', currency: 'RUB' });
  const usd = ledger.createAccount({ name: 'USD', currency: 'USD' });
  const deskRub = ledger.systemAccount('treasury', 'RUB');
  const deskUsd = ledger.systemAccount('treasury', 'USD');
  ledger.post({
    type: 'seed', description: 'fund',
    entries: [{ accountId: ledger.systemAccount('external', 'RUB').id, amount: -100000 }, { accountId: rub.id, amount: 100000 }],
  });
  ledger.post({
    type: 'exchange', description: 'fx',
    entries: [
      { accountId: rub.id, amount: -100000 },
      { accountId: deskRub.id, amount: 100000 },
      { accountId: deskUsd.id, amount: -1090 },
      { accountId: usd.id, amount: 1090 },
    ],
  });
  assert.equal(rub.balance, 0);
  assert.equal(usd.balance, 1090);
  assert.equal(ledger.audit().ok, true);
});

test('overdrafts are refused unless the account may go negative', () => {
  const ledger = fresh();
  const user = ledger.createAccount({ name: 'User' });
  const world = ledger.systemAccount('external', 'RUB');
  assert.throws(
    () => ledger.post({ type: 't', description: 'x', entries: [{ accountId: user.id, amount: -1 }, { accountId: world.id, amount: 1 }] }),
    /Insufficient funds/,
  );
  assert.ok(world.allowNegative, 'the outside world is allowed to go negative');
});

test('frozen and closed accounts reject postings', () => {
  const ledger = fresh();
  const user = ledger.createAccount({ name: 'User' });
  const world = ledger.systemAccount('external', 'RUB');
  const fund = () => ledger.post({ type: 't', description: 'x', entries: [{ accountId: world.id, amount: -500 }, { accountId: user.id, amount: 500 }] });
  fund();
  ledger.setStatus(user.id, 'frozen');
  assert.throws(fund, /frozen/);
  ledger.setStatus(user.id, 'active');
  assert.throws(() => ledger.setStatus(user.id, 'closed'), /Empty the account/);
});

test('the audit catches a tampered balance', () => {
  const ledger = fresh();
  const user = ledger.createAccount({ name: 'User' });
  const world = ledger.systemAccount('external', 'RUB');
  ledger.post({ type: 't', description: 'x', entries: [{ accountId: world.id, amount: -500 }, { accountId: user.id, amount: 500 }] });
  assert.equal(ledger.audit().ok, true);
  user.balance += 1;
  const report = ledger.audit();
  assert.equal(report.ok, false);
  assert.equal(report.drift[0].cached - report.drift[0].derived, 1);
});

test('history reports the local delta and the counterparty', () => {
  const ledger = fresh();
  const a = ledger.createAccount({ name: 'A' });
  const b = ledger.createAccount({ name: 'B' });
  const world = ledger.systemAccount('external', 'RUB');
  ledger.post({ type: 'topup', description: 'in', entries: [{ accountId: world.id, amount: -1000 }, { accountId: a.id, amount: 1000 }] });
  ledger.post({ type: 'transfer', description: 'to B', entries: [{ accountId: a.id, amount: -400 }, { accountId: b.id, amount: 400 }] });
  const { rows } = ledger.history(a.id);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].amount, -400);
  assert.equal(rows[0].counterparties[0].name, 'B');
  assert.equal(ledger.history(b.id).rows[0].amount, 400);
});
