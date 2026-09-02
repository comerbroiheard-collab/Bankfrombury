'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Bank, DAY_MS } = require('../src/bank');

/** A bank with a clock the test controls. */
function makeBank(startAt = new Date('2026-01-01T09:00:00Z')) {
  let clock = startAt;
  const bank = new Bank({ now: () => clock });
  return {
    bank,
    advance(days) { clock = new Date(clock.getTime() + days * DAY_MS); },
    advanceHours(hours) { clock = new Date(clock.getTime() + hours * 3600 * 1000); },
  };
}

function customer(bank, handle = 'bair', name = 'Bair Dorzhiev') {
  return bank.openCustomer({ name, handle, pin: '1957' });
}

test('opening a customer gives an account, a card and a valid number', () => {
  const { bank } = makeBank();
  const { customer: c, account, card } = customer(bank);
  assert.equal(c.handle, '@bair');
  assert.equal(account.currency, 'RUB');
  assert.equal(account.balance, 0);
  assert.match(account.number, /^VVBBU\d{14}[0-9A-Z]$/);
  assert.match(card.masked, /^\d{4} •••• •••• \d{4}$/, 'the card number is masked in responses');
  assert.equal(require('../src/ids').luhnIsValid(bank.card(card.id).pan), true, 'card PAN passes Luhn');
  assert.equal(bank.ledger.audit().ok, true);
});

test('handles are unique and validated', () => {
  const { bank } = makeBank();
  customer(bank);
  assert.throws(() => customer(bank), /already taken/);
  assert.throws(() => bank.openCustomer({ name: 'X Y', handle: 'no' }), /3-20 characters/);
  assert.throws(() => bank.openCustomer({ name: 'X Y', handle: 'Bad Handle!' }), /3-20 characters/);
});

test('instant funds land immediately', () => {
  const { bank } = makeBank();
  const { customer: c, account } = customer(bank);
  const res = bank.instantFunds(c.id, account.id, { amount: 10_000_00, source: 'sbp' });
  assert.equal(res.balance, 10_000_00);
  assert.equal(bank.customer(c.id).points, 0, 'topping yourself up earns no tier points');
  assert.equal(bank.ledger.balance(account.id), 10_000_00);
  assert.equal(bank.ledger.audit().ok, true);
});

test('the tier ceiling caps instant funds over a rolling 24 hours', () => {
  const { bank, advanceHours } = makeBank();
  const { customer: c, account } = customer(bank);
  bank.instantFunds(c.id, account.id, { amount: 50_000_00 }); // Omul tier ceiling
  assert.throws(() => bank.instantFunds(c.id, account.id, { amount: 1_00 }), /limit reached/);
  advanceHours(25);
  const after = bank.instantFunds(c.id, account.id, { amount: 1_000_00 });
  assert.equal(after.transaction.type, 'instant_funds', 'the window rolled and funding works again');
});

test('an idempotency key makes a retried top-up a no-op', () => {
  const { bank } = makeBank();
  const { customer: c, account } = customer(bank);
  const first = bank.instantFunds(c.id, account.id, { amount: 5_000_00, idempotencyKey: 'abc-123' });
  const retry = bank.instantFunds(c.id, account.id, { amount: 5_000_00, idempotencyKey: 'abc-123' });
  assert.equal(retry.replayed, true);
  assert.equal(retry.transaction.id, first.transaction.id);
  assert.equal(bank.ledger.balance(account.id), 5_000_00, 'credited exactly once');
});

test('transfers reach a handle and refuse to overdraw', () => {
  const { bank } = makeBank();
  const a = customer(bank, 'bair');
  const b = customer(bank, 'sesegma', 'Sesegma Badmaeva');
  bank.instantFunds(a.customer.id, a.account.id, { amount: 5_000_00 });
  bank.transfer(a.customer.id, { fromAccountId: a.account.id, to: '@sesegma', amount: 2_000_00, note: 'Omul money' });
  assert.equal(bank.ledger.balance(a.account.id), 3_000_00);
  assert.equal(bank.ledger.balance(b.account.id), 2_000_00);
  assert.throws(
    () => bank.transfer(a.customer.id, { fromAccountId: a.account.id, to: '@sesegma', amount: 9_000_00 }),
    /Insufficient funds/,
  );
  assert.equal(bank.ledger.audit().ok, true);
});

test('you cannot move money out of an account you do not own', () => {
  const { bank } = makeBank();
  const a = customer(bank, 'bair');
  const b = customer(bank, 'sesegma', 'Sesegma Badmaeva');
  bank.instantFunds(b.customer.id, b.account.id, { amount: 1_000_00 });
  assert.throws(
    () => bank.transfer(a.customer.id, { fromAccountId: b.account.id, to: '@bair', amount: 100_00 }),
    /belongs to somebody else/,
  );
});

test('exchanging currencies keeps every book balanced and charges the spread', () => {
  const { bank } = makeBank();
  const { customer: c, account } = customer(bank);
  const usd = bank.openAccount(c.id, { currency: 'USD' });
  bank.instantFunds(c.id, account.id, { amount: 50_000_00 });
  const { quote } = bank.exchange(c.id, { fromAccountId: account.id, toAccountId: usd.id, amount: 10_000_00 });
  assert.equal(quote.received + quote.fee, quote.gross);
  assert.equal(bank.ledger.balance(usd.id), quote.received);
  assert.equal(bank.ledger.balance(account.id), 40_000_00);
  assert.equal(bank.ledger.audit().ok, true, 'RUB and USD both sum to zero across the ledger');
});

test('card payments pay cashback, award points and respect limits', () => {
  const { bank } = makeBank();
  const { customer: c, account, card } = customer(bank);
  bank.instantFunds(c.id, account.id, { amount: 30_000_00 });
  const res = bank.cardPayment(card.id, { merchant: 'Baikal Market', amount: 1_000_00, category: 'groceries' });
  assert.equal(res.cashback, 500, '0.5% cashback at Omul tier');
  assert.equal(res.balance, 30_000_00 - 1_000_00 + 500);
  assert.equal(res.pointsEarned, 10);
  assert.throws(() => bank.cardPayment(card.id, { merchant: 'Too big', amount: 20_000_00 }), /per-payment limit/);
  bank.setCardStatus(c.id, card.id, 'frozen');
  assert.throws(() => bank.cardPayment(card.id, { merchant: 'Frozen', amount: 100_00 }), /Card is frozen/);
});

test('round-up saving sweeps the change into the vault', () => {
  const { bank } = makeBank();
  const { customer: c, account, card } = customer(bank);
  bank.instantFunds(c.id, account.id, { amount: 10_000_00 });
  const vault = bank.openVault(c.id, { name: 'Baikal trip', goal: 100_000_00 });
  bank.updateCard(c.id, card.id, { roundUpVaultId: vault.id });
  const res = bank.cardPayment(card.id, { merchant: 'Buuza Bar', amount: 487_60, category: 'cafe' });
  assert.equal(res.roundUp, 40, 'rounded 487,60 up to 488,00');
  assert.equal(bank.ledger.balance(vault.accountId), 40);
  assert.equal(bank.ledger.audit().ok, true);
});

test('vault interest accrues per whole day and never twice for the same day', () => {
  const { bank, advance } = makeBank();
  const { customer: c, account } = customer(bank);
  bank.instantFunds(c.id, account.id, { amount: 50_000_00 });
  const vault = bank.openVault(c.id, { name: 'Vault', apyBps: 730 }); // 7.3% -> 0.02%/day
  bank.vaultMove(c.id, vault.id, { amount: 36_500_00, direction: 'in' });

  assert.deepEqual(bank.accrueInterest(), [], 'nothing before a full day passes');
  advance(1);
  const [paid] = bank.accrueInterest();
  assert.equal(paid.days, 1);
  assert.equal(paid.interest, Math.round((36_500_00 * 730) / (10000 * 365)));
  assert.deepEqual(bank.accrueInterest(), [], 'the same day is not paid twice');
  assert.equal(bank.ledger.audit().ok, true);
});

test('a credit line draws, charges daily interest and repays', () => {
  const { bank, advance } = makeBank();
  const { customer: c, account } = customer(bank);
  const credit = bank.openCredit(c.id, { limit: 100_000_00, aprBps: 3650 }); // 0.01%/day
  assert.throws(() => bank.creditDraw(c.id, credit.id, { amount: 200_000_00 }), /Only/);
  bank.creditDraw(c.id, credit.id, { amount: 40_000_00 });
  assert.equal(bank.ledger.balance(account.id), 40_000_00);
  assert.equal(bank.publicCredit(bank.creditLine(credit.id)).available, 60_000_00);

  advance(10);
  const [charged] = bank.accrueCreditInterest();
  assert.equal(charged.days, 10);
  assert.equal(charged.interest, Math.round((40_000_00 * 3650 * 10) / (10000 * 365)));

  bank.instantFunds(c.id, account.id, { amount: 1_000_00 }); // to cover principal plus interest
  bank.creditRepay(c.id, credit.id, { amount: 100_000_00 });
  assert.equal(bank.publicCredit(bank.creditLine(credit.id)).drawn, 0, 'repayment is capped at what is owed');
  assert.equal(bank.ledger.audit().ok, true);
});

test('payment requests settle once and only once', () => {
  const { bank } = makeBank();
  const a = customer(bank, 'ayuna', 'Ayuna Tsyrenova');
  const b = customer(bank, 'zorig', 'Zorig Namsaraev');
  bank.instantFunds(b.customer.id, b.account.id, { amount: 10_000_00 });
  const request = bank.createRequest(a.customer.id, { amount: 2_750_00, note: 'Theatre tickets' });
  assert.match(request.code, /^VVB-[0-9A-Z]{4}-[0-9A-Z]{2}$/);
  assert.throws(() => bank.payRequest(a.customer.id, request.code), /cannot pay your own/);
  bank.payRequest(b.customer.id, request.code);
  assert.equal(bank.ledger.balance(a.account.id), 2_750_00);
  assert.throws(() => bank.payRequest(b.customer.id, request.code), /already paid/);
});

test('a split bill adds up to the original to the kopeck', () => {
  const { bank } = makeBank();
  const { customer: c } = customer(bank);
  const split = bank.splitBill(c.id, { amount: 10_000, ways: 3, note: 'Buuza feast' });
  const shares = [split.yourShare, ...split.requests.map((r) => r.amount)];
  assert.equal(shares.length, 3);
  assert.equal(shares.reduce((a, b) => a + b, 0), 10_000);
});

test('standing orders catch up missed cycles and pause when funds run out', () => {
  const { bank, advance } = makeBank();
  const a = customer(bank, 'bair');
  const b = customer(bank, 'sesegma', 'Sesegma Badmaeva');
  bank.instantFunds(a.customer.id, a.account.id, { amount: 2_500_00 });
  const schedule = bank.schedule(a.customer.id, {
    fromAccountId: a.account.id, to: '@sesegma', amount: 1_000_00, everyDays: 7, note: 'Rent share',
  });

  assert.deepEqual(bank.runScheduled(), [], 'nothing is due yet');
  advance(21); // three cycles missed
  const executed = bank.runScheduled();
  assert.equal(executed.length, 2, 'two cycles paid, the third had no funds');
  assert.equal(bank.state.schedules[schedule.id].status, 'paused');
  assert.match(bank.state.schedules[schedule.id].lastError, /Insufficient funds/);
  assert.equal(bank.ledger.balance(b.account.id), 2_000_00);
  assert.equal(bank.ledger.audit().ok, true);
});

test('the overview totals foreign balances into rubles', () => {
  const { bank } = makeBank();
  const { customer: c, account } = customer(bank);
  const usd = bank.openAccount(c.id, { currency: 'USD' });
  bank.instantFunds(c.id, account.id, { amount: 20_000_00 });
  bank.exchange(c.id, { fromAccountId: account.id, toAccountId: usd.id, amount: 10_000_00 });
  const overview = bank.overview(c.id);
  assert.equal(overview.accounts.length, 2);
  // Converted back at the mid rate, the spread is the only thing missing.
  assert.ok(Math.abs(overview.netWorthRub - 20_000_00) < 100_00, `net worth ${overview.netWorthRub}`);
  assert.equal(overview.customer.tier.key, 'omul');
});

test('spending by category ranks outgoings and ignores incoming money', () => {
  const { bank } = makeBank();
  const { customer: c, account, card } = customer(bank);
  bank.instantFunds(c.id, account.id, { amount: 20_000_00 });
  bank.cardPayment(card.id, { merchant: 'Baikal Market', amount: 3_000_00, category: 'groceries' });
  bank.cardPayment(card.id, { merchant: 'Tram', amount: 35_00, category: 'transport' });
  const spending = bank.spendingByCategory(c.id);
  assert.equal(spending.rows[0].category, 'groceries');
  assert.equal(spending.rows[0].spent, 3_000_00);
  assert.ok(!spending.rows.some((r) => r.category === 'income'), 'top-ups are not spending');
  assert.ok(Math.abs(spending.rows.reduce((sum, r) => sum + r.share, 0) - 1) < 1e-9);
});

test('a whole busy branch still balances', () => {
  const { bank, advance } = makeBank();
  const people = ['bair', 'sesegma', 'ayuna', 'zorig'].map((h, i) => customer(bank, h, `Person ${i}`));
  for (const p of people) bank.instantFunds(p.customer.id, p.account.id, { amount: 40_000_00 });
  for (const [i, p] of people.entries()) {
    bank.cardPayment(p.card.id, { merchant: `Shop ${i}`, amount: 1_234_56, category: 'shopping' });
    bank.transfer(p.customer.id, { fromAccountId: p.account.id, to: `@${people[(i + 1) % people.length].customer.handle.slice(1)}`, amount: 500_00 });
    const vault = bank.openVault(p.customer.id, { name: `Vault ${i}` });
    bank.vaultMove(p.customer.id, vault.id, { amount: 5_000_00, direction: 'in' });
  }
  advance(30);
  bank.accrueInterest();
  const report = bank.ledger.audit();
  assert.equal(report.ok, true, JSON.stringify(report.drift));
  assert.ok(report.transactions > 20);
});

test('moving money between your own accounts is not spending', () => {
  const { bank } = makeBank();
  const { customer: c, account, card } = customer(bank);
  const usd = bank.openAccount(c.id, { currency: 'USD' });
  bank.instantFunds(c.id, account.id, { amount: 40_000_00 });

  bank.exchange(c.id, { fromAccountId: account.id, toAccountId: usd.id, amount: 10_000_00 });
  const vault = bank.openVault(c.id, { name: 'Vault' });
  bank.vaultMove(c.id, vault.id, { amount: 5_000_00, direction: 'in' });
  bank.transfer(c.id, { fromAccountId: account.id, to: usd.id === account.id ? account.id : vault.accountId, amount: 100_00, note: 'own move' });
  bank.cardPayment(card.id, { merchant: 'Baikal Market', amount: 1_000_00, category: 'groceries' });

  const spending = bank.spendingByCategory(c.id);
  assert.deepEqual(spending.rows.map((r) => r.category), ['groceries'], 'only the real purchase counts');
  assert.equal(spending.total, 1_000_00);
});

test('sending to another customer does count as spending', () => {
  const { bank } = makeBank();
  const a = customer(bank, 'bair');
  customer(bank, 'sesegma', 'Sesegma Badmaeva');
  bank.instantFunds(a.customer.id, a.account.id, { amount: 5_000_00 });
  bank.transfer(a.customer.id, { fromAccountId: a.account.id, to: '@sesegma', amount: 1_500_00 });
  const spending = bank.spendingByCategory(a.customer.id);
  assert.equal(spending.rows[0].category, 'transfer');
  assert.equal(spending.rows[0].spent, 1_500_00);
});
