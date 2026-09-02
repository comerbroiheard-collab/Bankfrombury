'use strict';

const money = require('./money');
const ids = require('./ids');
const { Bank, BankError, TIERS, CATEGORIES, INSTANT_SOURCES } = require('./bank');
const { LedgerError } = require('./ledger');
const { MoneyError } = require('./money');
const { Router, json, readBody } = require('./http');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

class Sessions {
  constructor(ttlMs = SESSION_TTL_MS) {
    this.ttlMs = ttlMs;
    this.byToken = new Map();
  }

  open(customerId) {
    const token = ids.token();
    this.byToken.set(token, { customerId, expiresAt: Date.now() + this.ttlMs });
    return { token, expiresIn: Math.floor(this.ttlMs / 1000) };
  }

  customerId(token) {
    const session = this.byToken.get(token);
    if (!session) return null;
    if (session.expiresAt < Date.now()) {
      this.byToken.delete(token);
      return null;
    }
    return session.customerId;
  }

  close(token) { return this.byToken.delete(token); }
}

/**
 * Reads an amount from a request body. Callers may send major units
 * (`amount: 1500.50`) or exact minor units (`amountMinor: 150050`).
 */
function amountFrom(body, currency) {
  if (body.amountMinor != null) return money.assertPositive(Number(body.amountMinor), 'Amount');
  if (body.amount == null || body.amount === '') throw new BankError('An amount is required', 'amount_required');
  return money.assertPositive(money.toMinor(body.amount, currency), 'Amount');
}

function currencyOf(bank, accountId) {
  return bank.ledger.get(accountId).currency;
}

/**
 * Builds the router. `bank` holds the state; `sessions` maps bearer tokens to
 * customers. Every handler receives ({ req, res, body, query, params, customerId }).
 */
function buildRouter(bank, sessions) {
  const router = new Router();

  const auth = (handler) => async (ctx) => {
    if (!ctx.customerId) throw new BankError('Sign in first', 'unauthorized', 401);
    return handler(ctx);
  };

  // -- public ---------------------------------------------------------------

  router.get('/api/health', () => bank.health());

  router.get('/api/meta', () => ({
    bank: 'VaivaiBank Buryatia',
    currencies: Object.values(money.CURRENCIES),
    categories: CATEGORIES,
    tiers: TIERS,
    instantSources: Object.entries(INSTANT_SOURCES).map(([key, label]) => ({ key, label })),
    rates: bank.rates.board(),
  }));

  router.get('/api/rates', () => bank.rates.board());

  router.get('/api/directory', () => ({
    customers: Object.values(bank.state.customers)
      .filter((c) => c.status === 'active')
      .map((c) => ({ handle: `@${c.handle}`, name: c.name, city: c.city, tier: bank.tierOf(c.points).name }))
      .sort((a, b) => a.handle.localeCompare(b.handle)),
  }));

  router.post('/api/customers', async ({ body }) => {
    const opened = bank.openCustomer({
      name: body.name,
      handle: body.handle,
      pin: body.pin || null,
      city: body.city || 'Ulan-Ude',
      currency: body.currency || 'RUB',
    });
    const session = sessions.open(opened.customer.id);
    return { ...opened, card: { ...opened.card, pan: undefined, cvv: undefined, masked: ids.maskCard(opened.card.pan) }, session };
  });

  router.post('/api/session', async ({ body }) => {
    const ref = body.handle || body.customerId;
    let customer;
    try {
      customer = bank.findCustomer(ref);
    } catch {
      throw new BankError('No account matches that handle', 'unauthorized', 401);
    }
    if (customer.pin && !bank.verifyPin(customer.id, body.pin)) {
      throw new BankError('That PIN does not match', 'unauthorized', 401);
    }
    return { session: sessions.open(customer.id), customer: bank.publicCustomer(customer) };
  });

  router.del('/api/session', async ({ token }) => ({ closed: sessions.close(token) }));

  router.get('/api/requests/:code', ({ params }) => {
    const request = bank.request(params.code);
    const owner = bank.customer(request.ownerId);
    return { ...request, from: `@${owner.handle}`, ownerName: owner.name };
  });

  // -- customer -------------------------------------------------------------

  router.get('/api/me', auth(({ customerId }) => bank.overview(customerId)));

  router.get('/api/me/audit', auth(({ customerId }) => ({
    entries: bank.state.auditLog.filter((e) => e.detail.customerId === customerId).slice(-100).reverse(),
  })));

  router.post('/api/accounts', auth(({ customerId, body }) => bank.openAccount(customerId, {
    currency: body.currency || 'RUB',
    name: body.name || null,
    type: body.type || 'checking',
  })));

  router.post('/api/accounts/:id/freeze', auth(({ customerId, params, body }) =>
    bank.freezeAccount(customerId, params.id, body.frozen !== false)));

  router.get('/api/accounts/:id/statement', auth(({ customerId, params, query }) =>
    bank.statement(customerId, params.id, {
      from: query.get('from'),
      to: query.get('to'),
      limit: Math.min(Number(query.get('limit')) || 50, 500),
      offset: Number(query.get('offset')) || 0,
    })));

  // -- instant funds: the headline ------------------------------------------

  router.post('/api/accounts/:id/instant-funds', auth(({ customerId, params, body }) =>
    bank.instantFunds(customerId, params.id, {
      amount: amountFrom(body, currencyOf(bank, params.id)),
      source: body.source || 'demo',
      note: body.note || null,
      idempotencyKey: body.idempotencyKey || null,
    })));

  router.get('/api/instant-funds/allowance', auth(({ customerId }) => bank.instantAllowance(customerId)));

  // -- money movement -------------------------------------------------------

  router.post('/api/transfers', auth(({ customerId, body }) => bank.transfer(customerId, {
    fromAccountId: body.fromAccountId,
    to: body.to,
    amount: amountFrom(body, currencyOf(bank, body.fromAccountId)),
    note: body.note || null,
    category: body.category || 'transfer',
    idempotencyKey: body.idempotencyKey || null,
  })));

  router.post('/api/exchange', auth(({ customerId, body }) => bank.exchange(customerId, {
    fromAccountId: body.fromAccountId,
    toAccountId: body.toAccountId,
    amount: amountFrom(body, currencyOf(bank, body.fromAccountId)),
  })));

  router.post('/api/exchange/quote', auth(({ body }) => bank.rates.quote(
    money.toMinor(body.amount ?? 0, body.from || 'RUB'),
    body.from || 'RUB',
    body.to || 'USD',
  )));

  // -- cards ----------------------------------------------------------------

  router.post('/api/cards', auth(({ customerId, body }) => {
    const account = bank.ownedAccount(customerId, body.accountId);
    const card = bank.issueCard(account.id, {
      label: body.label || 'VaivaiBank card',
      dailyLimit: body.dailyLimit != null ? money.toMinor(body.dailyLimit, account.currency) : undefined,
      perTransactionLimit: body.perTransactionLimit != null ? money.toMinor(body.perTransactionLimit, account.currency) : undefined,
    });
    return bank.publicCard(card);
  }));

  router.patch('/api/cards/:id', auth(({ customerId, params, body }) => {
    const card = bank.ownedCard(customerId, params.id);
    const currency = currencyOf(bank, card.accountId);
    const patch = { ...body };
    for (const field of ['dailyLimit', 'perTransactionLimit']) {
      if (patch[field] != null) patch[field] = money.toMinor(patch[field], currency);
    }
    return bank.updateCard(customerId, params.id, patch);
  }));

  router.post('/api/cards/:id/status', auth(({ customerId, params, body }) =>
    bank.setCardStatus(customerId, params.id, body.status)));

  /** Reveals full card details once, the way a banking app does on tap. */
  router.post('/api/cards/:id/reveal', auth(({ customerId, params, body }) => {
    const card = bank.ownedCard(customerId, params.id);
    if (!bank.verifyPin(customerId, body.pin)) throw new BankError('PIN required to show card details', 'bad_pin', 403);
    return { id: card.id, pan: card.pan.replace(/(.{4})/g, '$1 ').trim(), cvv: card.cvv, expiry: card.expiry };
  }));

  router.post('/api/cards/:id/payment', auth(({ customerId, params, body }) => {
    const card = bank.ownedCard(customerId, params.id);
    return bank.cardPayment(card.id, {
      merchant: body.merchant || 'Merchant',
      amount: amountFrom(body, currencyOf(bank, card.accountId)),
      category: body.category || 'shopping',
      online: Boolean(body.online),
    });
  }));

  // -- vaults ---------------------------------------------------------------

  router.post('/api/vaults', auth(({ customerId, body }) => bank.openVault(customerId, {
    name: body.name || 'Baikal Vault',
    currency: body.currency || 'RUB',
    goal: body.goal != null ? money.toMinor(body.goal, body.currency || 'RUB') : null,
    apyBps: body.apyBps != null ? Number(body.apyBps) : 700,
  })));

  router.post('/api/vaults/:id/move', auth(({ customerId, params, body }) => {
    const vault = bank.vault(params.id);
    return bank.vaultMove(customerId, params.id, {
      fromAccountId: body.accountId || null,
      amount: amountFrom(body, currencyOf(bank, vault.accountId)),
      direction: body.direction === 'out' ? 'out' : 'in',
    });
  }));

  router.post('/api/vaults/accrue', auth(() => ({ paid: bank.accrueInterest() })));

  // -- credit ---------------------------------------------------------------

  router.post('/api/credit', auth(({ customerId, body }) => bank.openCredit(customerId, {
    limit: body.limit != null ? money.toMinor(body.limit, body.currency || 'RUB') : undefined,
    aprBps: body.aprBps != null ? Number(body.aprBps) : undefined,
    currency: body.currency || 'RUB',
  })));

  router.post('/api/credit/:id/draw', auth(({ customerId, params, body }) => {
    const credit = bank.creditLine(params.id);
    return bank.creditDraw(customerId, params.id, {
      amount: amountFrom(body, credit.currency),
      toAccountId: body.toAccountId || null,
    });
  }));

  router.post('/api/credit/:id/repay', auth(({ customerId, params, body }) => {
    const credit = bank.creditLine(params.id);
    return bank.creditRepay(customerId, params.id, {
      amount: amountFrom(body, credit.currency),
      fromAccountId: body.fromAccountId || null,
    });
  }));

  router.post('/api/credit/accrue', auth(() => ({ charged: bank.accrueCreditInterest() })));

  // -- requests, splits, standing orders ------------------------------------

  router.post('/api/requests', auth(({ customerId, body }) => {
    const accountId = body.accountId || bank.primaryAccount(customerId).id;
    return bank.createRequest(customerId, {
      accountId,
      amount: amountFrom(body, currencyOf(bank, accountId)),
      note: body.note || null,
      expiresInHours: Number(body.expiresInHours) || 72,
    });
  }));

  router.post('/api/requests/:code/pay', auth(({ customerId, params, body }) =>
    bank.payRequest(customerId, params.code, { fromAccountId: body.fromAccountId || null })));

  router.post('/api/split', auth(({ customerId, body }) => {
    const accountId = body.accountId || bank.primaryAccount(customerId).id;
    return bank.splitBill(customerId, {
      accountId,
      amount: amountFrom(body, currencyOf(bank, accountId)),
      ways: Number(body.ways) || 2,
      note: body.note || 'Split bill',
    });
  }));

  router.post('/api/schedules', auth(({ customerId, body }) => bank.schedule(customerId, {
    fromAccountId: body.fromAccountId,
    to: body.to,
    amount: amountFrom(body, currencyOf(bank, body.fromAccountId)),
    everyDays: Number(body.everyDays) || 30,
    note: body.note || null,
    category: body.category || 'transfer',
    startAt: body.startAt || null,
  })));

  router.del('/api/schedules/:id', auth(({ customerId, params }) => bank.cancelSchedule(customerId, params.id)));

  router.post('/api/scheduler/run', auth(() => ({ executed: bank.runScheduled() })));

  // -- reporting ------------------------------------------------------------

  router.get('/api/me/spending', auth(({ customerId, query }) =>
    bank.spendingByCategory(customerId, { from: query.get('from'), to: query.get('to') })));

  router.get('/api/audit', () => bank.ledger.audit());

  return router;
}

function errorStatus(err) {
  if (err instanceof BankError || err instanceof LedgerError || err instanceof MoneyError) return err.status || 400;
  return err.status || 500;
}

async function handleRequest(bank, sessions, router, req, res, url) {
  const match = router.match(req.method, url.pathname);
  if (!match) return false;
  if (match.methodNotAllowed) {
    json(res, 405, { error: 'method_not_allowed', message: `${req.method} is not supported here` });
    return true;
  }

  let body = {};
  try {
    body = await readBody(req);
  } catch (err) {
    json(res, err.status || 400, { error: err.code || 'bad_request', message: err.message });
    return true;
  }

  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : (body.token || url.searchParams.get('token') || null);
  const customerId = token ? sessions.customerId(token) : null;

  try {
    const payload = await match.route.handler({ req, res, body, params: match.params, query: url.searchParams, customerId, token });
    if (res.writableEnded) return true;
    json(res, req.method === 'POST' ? 201 : 200, payload ?? { ok: true });
  } catch (err) {
    const status = errorStatus(err);
    if (status >= 500) process.emitWarning(`API failure on ${req.method} ${url.pathname}: ${err.stack}`);
    json(res, status, {
      error: err.code || 'internal_error',
      message: status >= 500 ? 'Something went wrong inside the bank' : err.message,
    });
  }
  return true;
}

module.exports = { buildRouter, handleRequest, Sessions, amountFrom };
