'use strict';

const money = require('./money');
const ids = require('./ids');
const { Ledger, LedgerError } = require('./ledger');
const { RateBoard } = require('./rates');

class BankError extends Error {
  constructor(message, code = 'bank_error', status = 400) {
    super(message);
    this.name = 'BankError';
    this.code = code;
    this.status = status;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Loyalty tiers, named after Lake Baikal and the Buryat steppe. Points are
 * earned on card spend and saving; the tier sets the instant-funds ceiling
 * and the cashback rate.
 */
const TIERS = [
  { key: 'omul', name: 'Omul', points: 0, instantDailyLimit: 5_000_000, cashbackBps: 50, vaultBonusBps: 0 },
  { key: 'nerpa', name: 'Nerpa', points: 500, instantDailyLimit: 15_000_000, cashbackBps: 75, vaultBonusBps: 25 },
  { key: 'sable', name: 'Sable', points: 2_500, instantDailyLimit: 50_000_000, cashbackBps: 100, vaultBonusBps: 50 },
  { key: 'barguzin', name: 'Barguzin', points: 10_000, instantDailyLimit: 200_000_000, cashbackBps: 150, vaultBonusBps: 75 },
  { key: 'baikal', name: 'Baikal', points: 50_000, instantDailyLimit: null, cashbackBps: 200, vaultBonusBps: 100 },
];

const CATEGORIES = [
  'groceries', 'cafe', 'transport', 'utilities', 'health', 'travel',
  'entertainment', 'shopping', 'transfer', 'income', 'savings', 'fees', 'other',
];

const INSTANT_SOURCES = {
  card: 'Linked card',
  sbp: 'Faster payments',
  salary: 'Salary credit',
  cash: 'Cash-in terminal',
  gift: 'Gift',
  demo: 'Demo funding',
};

const HANDLE_RE = /^[a-z0-9_]{3,20}$/;

/**
 * Transaction types that only shuffle money between a customer's own books.
 * They belong in the statement but never in a spending breakdown.
 */
const INTERNAL_TYPES = new Set([
  'exchange', 'vault_deposit', 'vault_withdrawal', 'roundup', 'credit_draw', 'credit_repayment',
]);

const seed = () => ({
  customers: {},
  accounts: {},
  transactions: [],
  cards: {},
  vaults: {},
  credit: {},
  schedules: {},
  requests: {},
  idempotency: {},
  auditLog: [],
});

class Bank {
  constructor({ store = null, state = null, rates = new RateBoard(), now = () => new Date() } = {}) {
    this.store = store;
    this.state = state || store?.data || seed();
    for (const [key, value] of Object.entries(seed())) this.state[key] ||= value;
    this.ledger = new Ledger(this.state);
    this.rates = rates;
    this.clock = now;
  }

  now() { return this.clock(); }
  iso() { return this.now().toISOString(); }
  save() { this.store?.touch(); return this; }

  log(action, detail = {}) {
    this.state.auditLog.push({ id: ids.id('log'), at: this.iso(), action, detail });
    if (this.state.auditLog.length > 5000) this.state.auditLog.splice(0, this.state.auditLog.length - 5000);
  }

  // -- customers -----------------------------------------------------------

  openCustomer({ name, handle, pin = null, city = 'Ulan-Ude', currency = 'RUB' }) {
    const trimmed = String(name || '').trim();
    if (trimmed.length < 2) throw new BankError('Tell us a name of at least two characters', 'invalid_name');
    const tag = String(handle || '').trim().toLowerCase().replace(/^@/, '');
    if (!HANDLE_RE.test(tag)) {
      throw new BankError('Handle must be 3-20 characters: a-z, 0-9 or underscore', 'invalid_handle');
    }
    if (this.findCustomerByHandle(tag)) throw new BankError(`@${tag} is already taken`, 'handle_taken', 409);

    const customer = {
      id: ids.id('cus'),
      name: trimmed,
      handle: tag,
      city,
      pin: pin == null ? null : ids.hashPin(pin),
      points: 0,
      status: 'active',
      joinedAt: this.iso(),
    };
    this.state.customers[customer.id] = customer;

    const account = this.ledger.createAccount({
      ownerId: customer.id,
      currency,
      type: 'checking',
      name: `${trimmed} · everyday`,
      meta: { primary: true },
    });
    const card = this.issueCard(account.id, { label: 'VaivaiBank Everyday' });

    this.log('customer.open', { customerId: customer.id, handle: tag });
    this.save();
    return { customer: this.publicCustomer(customer), account, card: this.publicCard(card) };
  }

  customer(customerId) {
    const customer = this.state.customers[customerId];
    if (!customer) throw new BankError(`No such customer: ${customerId}`, 'customer_not_found', 404);
    return customer;
  }

  findCustomerByHandle(handle) {
    const tag = String(handle || '').toLowerCase().replace(/^@/, '');
    return Object.values(this.state.customers).find((c) => c.handle === tag) || null;
  }

  /** Accepts a customer id, an @handle, an account id or a printed number. */
  findCustomer(ref) {
    const raw = String(ref || '').trim();
    if (this.state.customers[raw]) return this.state.customers[raw];
    const byHandle = this.findCustomerByHandle(raw);
    if (byHandle) return byHandle;
    const account = this.state.accounts[raw] || Object.values(this.state.accounts).find((a) => a.number === raw.replace(/\s/g, '').toUpperCase());
    if (account?.ownerId) return this.customer(account.ownerId);
    throw new BankError(`No customer matches "${ref}"`, 'customer_not_found', 404);
  }

  verifyPin(customerId, pin) {
    const customer = this.customer(customerId);
    if (!customer.pin) return true;
    return ids.verifyPin(pin, customer.pin);
  }

  publicCustomer(customer) {
    const tier = this.tierOf(customer.points);
    return {
      id: customer.id,
      name: customer.name,
      handle: `@${customer.handle}`,
      city: customer.city,
      points: customer.points,
      status: customer.status,
      joinedAt: customer.joinedAt,
      tier,
      nextTier: TIERS.find((t) => t.points > customer.points) || null,
      hasPin: Boolean(customer.pin),
    };
  }

  tierOf(points) {
    let current = TIERS[0];
    for (const tier of TIERS) if (points >= tier.points) current = tier;
    return current;
  }

  awardPoints(customerId, points, reason) {
    if (points <= 0) return 0;
    const customer = this.customer(customerId);
    const before = this.tierOf(customer.points).key;
    customer.points += Math.round(points);
    const after = this.tierOf(customer.points);
    if (after.key !== before) this.log('tier.up', { customerId, tier: after.key });
    this.log('points.award', { customerId, points: Math.round(points), reason });
    return Math.round(points);
  }

  // -- accounts ------------------------------------------------------------

  openAccount(customerId, { currency = 'RUB', name = null, type = 'checking' } = {}) {
    const customer = this.customer(customerId);
    if (!['checking', 'vault'].includes(type)) throw new BankError('Open checking or vault accounts only', 'bad_account_type');
    const cur = money.currency(currency).code;
    const account = this.ledger.createAccount({
      ownerId: customer.id,
      currency: cur,
      type,
      name: name || `${customer.name} · ${cur}`,
    });
    this.log('account.open', { customerId, accountId: account.id, currency: cur });
    this.save();
    return account;
  }

  ownedAccount(customerId, accountId) {
    const account = this.ledger.get(accountId);
    if (account.ownerId !== customerId) throw new BankError('That account belongs to somebody else', 'forbidden', 403);
    return account;
  }

  primaryAccount(customerId, currency = null) {
    const accounts = this.ledger.accountsOf(customerId).filter((a) => a.type === 'checking');
    if (!accounts.length) throw new BankError('This customer has no open account', 'no_account', 409);
    if (currency) {
      const match = accounts.find((a) => a.currency === currency);
      if (match) return match;
    }
    return accounts.find((a) => a.meta?.primary) || accounts[0];
  }

  /** Destination for a transfer: account id/number, or @handle of a customer. */
  resolveDestination(ref, preferredCurrency = null) {
    const raw = String(ref || '').trim();
    if (raw.startsWith('@')) {
      const customer = this.findCustomer(raw);
      return this.primaryAccount(customer.id, preferredCurrency);
    }
    try {
      return this.ledger.resolve(raw);
    } catch (err) {
      const customer = this.findCustomerByHandle(raw);
      if (customer) return this.primaryAccount(customer.id, preferredCurrency);
      throw err;
    }
  }

  freezeAccount(customerId, accountId, frozen = true) {
    this.ownedAccount(customerId, accountId);
    const account = this.ledger.setStatus(accountId, frozen ? 'frozen' : 'active');
    this.log('account.status', { accountId, status: account.status });
    this.save();
    return account;
  }

  closeAccount(customerId, accountId) {
    this.ownedAccount(customerId, accountId);
    const account = this.ledger.setStatus(accountId, 'closed');
    this.log('account.close', { accountId });
    this.save();
    return account;
  }

  // -- idempotency ---------------------------------------------------------

  #replay(key) {
    if (!key) return null;
    const txId = this.state.idempotency[key];
    if (!txId) return null;
    const tx = this.state.transactions.find((t) => t.id === txId);
    return tx ? { ...tx, replayed: true } : null;
  }

  #remember(key, tx) {
    if (key) this.state.idempotency[key] = tx.id;
    return tx;
  }

  // -- instant funds -------------------------------------------------------

  /** Total instant funds credited to a customer in the last 24 hours, in RUB. */
  instantUsedToday(customerId) {
    const since = new Date(this.now().getTime() - DAY_MS).toISOString();
    const owned = new Set(this.ledger.accountsOf(customerId).map((a) => a.id));
    let total = 0;
    for (let i = this.state.transactions.length - 1; i >= 0; i -= 1) {
      const tx = this.state.transactions[i];
      if (tx.at < since) break;
      if (tx.type !== 'instant_funds') continue;
      for (const entry of tx.entries) {
        if (entry.amount > 0 && owned.has(entry.accountId)) {
          total += entry.currency === 'RUB'
            ? entry.amount
            : Math.round(money.toMajor(entry.amount, entry.currency) / this.rates.rate(entry.currency) * 100);
        }
      }
    }
    return total;
  }

  instantAllowance(customerId) {
    const customer = this.customer(customerId);
    const tier = this.tierOf(customer.points);
    const used = this.instantUsedToday(customerId);
    return {
      tier: tier.key,
      tierName: tier.name,
      limit: tier.instantDailyLimit,
      used,
      remaining: tier.instantDailyLimit == null ? null : Math.max(0, tier.instantDailyLimit - used),
      currency: 'RUB',
    };
  }

  /**
   * Instant funds: money lands in the account the moment the call returns.
   * Guarded by the tier's rolling 24h ceiling and an optional idempotency key
   * so a retried request never credits twice.
   */
  instantFunds(customerId, accountId, { amount, source = 'demo', note = null, idempotencyKey = null } = {}) {
    const replay = this.#replay(idempotencyKey);
    if (replay) return { transaction: replay, replayed: true };

    const account = this.ownedAccount(customerId, accountId);
    const minor = money.assertPositive(amount, 'Top-up');
    if (!INSTANT_SOURCES[source]) throw new BankError(`Unknown funding source: ${source}`, 'bad_source');

    const allowance = this.instantAllowance(customerId);
    const inRubles = account.currency === 'RUB'
      ? minor
      : Math.round((money.toMajor(minor, account.currency) / this.rates.rate(account.currency)) * 100);
    if (allowance.limit != null && inRubles > allowance.remaining) {
      throw new BankError(
        `Instant funds limit reached: ${money.format(allowance.remaining, 'RUB')} left today on ${allowance.tierName}. Earn points or wait for the window to roll.`,
        'instant_limit',
        429,
      );
    }

    const external = this.ledger.systemAccount('external', account.currency);
    const tx = this.ledger.post({
      type: 'instant_funds',
      description: note || `Instant funds · ${INSTANT_SOURCES[source]}`,
      category: 'income',
      at: this.iso(),
      meta: { source, customerId },
      entries: [
        { accountId: external.id, amount: -minor },
        { accountId: account.id, amount: minor },
      ],
    });
    this.#remember(idempotencyKey, tx);

    // Deliberately no loyalty points here: points raise the tier, and the tier
    // raises this very ceiling, so funding yourself must not unlock more funding.
    this.log('instant_funds', { customerId, accountId, amount: minor, currency: account.currency, source });
    this.save();
    return { transaction: tx, balance: account.balance, currency: account.currency, allowance: this.instantAllowance(customerId) };
  }

  // -- transfers and exchange ---------------------------------------------

  transfer(customerId, { fromAccountId, to, amount, note = null, category = 'transfer', idempotencyKey = null } = {}) {
    const replay = this.#replay(idempotencyKey);
    if (replay) return { transaction: replay, replayed: true };

    const from = this.ownedAccount(customerId, fromAccountId);
    const dest = this.resolveDestination(to, from.currency);
    if (dest.id === from.id) throw new BankError('Pick a different account to send to', 'same_account');
    const minor = money.assertPositive(amount, 'Transfer');

    const sender = this.customer(customerId);
    const at = this.iso();
    let tx;

    if (dest.currency === from.currency) {
      tx = this.ledger.post({
        type: 'transfer',
        description: note || `To ${dest.name}`,
        category,
        at,
        meta: { fromAccountId: from.id, toAccountId: dest.id, from: `@${sender.handle}` },
        entries: [
          { accountId: from.id, amount: -minor },
          { accountId: dest.id, amount: minor },
        ],
      });
    } else {
      // Cross-currency: the FX desk sits in the middle so each currency balances.
      const quote = this.rates.quote(minor, from.currency, dest.currency);
      const deskOut = this.ledger.systemAccount('treasury', from.currency);
      const deskIn = this.ledger.systemAccount('treasury', dest.currency);
      const fees = this.ledger.systemAccount('fees', dest.currency);
      tx = this.ledger.post({
        type: 'transfer_fx',
        description: note || `To ${dest.name} (${from.currency}→${dest.currency})`,
        category,
        at,
        meta: { fromAccountId: from.id, toAccountId: dest.id, quote, from: `@${sender.handle}` },
        entries: [
          { accountId: from.id, amount: -minor },
          { accountId: deskOut.id, amount: minor },
          { accountId: deskIn.id, amount: -quote.gross },
          { accountId: dest.id, amount: quote.received },
          { accountId: fees.id, amount: quote.fee },
        ],
      });
    }

    this.#remember(idempotencyKey, tx);
    this.log('transfer', { customerId, from: from.id, to: dest.id, amount: minor });
    this.save();
    return { transaction: tx, balance: from.balance, currency: from.currency };
  }

  /** Move money between two of your own accounts, converting if needed. */
  exchange(customerId, { fromAccountId, toAccountId, amount } = {}) {
    const from = this.ownedAccount(customerId, fromAccountId);
    const to = this.ownedAccount(customerId, toAccountId);
    if (from.id === to.id) throw new BankError('Choose two different accounts', 'same_account');
    const minor = money.assertPositive(amount, 'Exchange');
    if (from.currency === to.currency) {
      return this.transfer(customerId, { fromAccountId, to: toAccountId, amount: minor, note: 'Own transfer', category: 'transfer' });
    }
    const quote = this.rates.quote(minor, from.currency, to.currency);
    const deskOut = this.ledger.systemAccount('treasury', from.currency);
    const deskIn = this.ledger.systemAccount('treasury', to.currency);
    const fees = this.ledger.systemAccount('fees', to.currency);
    const tx = this.ledger.post({
      type: 'exchange',
      description: `Exchange ${from.currency} → ${to.currency}`,
      category: 'transfer',
      at: this.iso(),
      meta: { quote },
      entries: [
        { accountId: from.id, amount: -minor },
        { accountId: deskOut.id, amount: minor },
        { accountId: deskIn.id, amount: -quote.gross },
        { accountId: to.id, amount: quote.received },
        { accountId: fees.id, amount: quote.fee },
      ],
    });
    this.log('exchange', { customerId, from: from.id, to: to.id, quote });
    this.save();
    return { transaction: tx, quote };
  }

  // -- cards ---------------------------------------------------------------

  issueCard(accountId, { label = 'VaivaiBank card', dailyLimit = 30_000_00, perTransactionLimit = 15_000_00, contactless = true, online = true } = {}) {
    const account = this.ledger.get(accountId);
    if (account.type !== 'checking') throw new BankError('Cards attach to checking accounts', 'bad_card_account');
    const expiry = new Date(this.now().getTime());
    expiry.setFullYear(expiry.getFullYear() + 4);
    const card = {
      id: ids.id('card'),
      accountId: account.id,
      ownerId: account.ownerId,
      label,
      pan: ids.cardNumber(),
      cvv: ids.cvv(),
      expiry: `${String(expiry.getMonth() + 1).padStart(2, '0')}/${String(expiry.getFullYear()).slice(-2)}`,
      status: 'active',
      dailyLimit,
      perTransactionLimit,
      contactless,
      online,
      roundUpVaultId: null,
      issuedAt: this.iso(),
    };
    this.state.cards[card.id] = card;
    this.log('card.issue', { cardId: card.id, accountId: account.id });
    this.save();
    return card;
  }

  card(cardId) {
    const card = this.state.cards[cardId];
    if (!card) throw new BankError(`No such card: ${cardId}`, 'card_not_found', 404);
    return card;
  }

  ownedCard(customerId, cardId) {
    const card = this.card(cardId);
    if (card.ownerId !== customerId) throw new BankError('That card belongs to somebody else', 'forbidden', 403);
    return card;
  }

  publicCard(card) {
    return {
      id: card.id,
      accountId: card.accountId,
      label: card.label,
      masked: ids.maskCard(card.pan),
      last4: card.pan.slice(-4),
      expiry: card.expiry,
      status: card.status,
      dailyLimit: card.dailyLimit,
      perTransactionLimit: card.perTransactionLimit,
      contactless: card.contactless,
      online: card.online,
      roundUpVaultId: card.roundUpVaultId,
      issuedAt: card.issuedAt,
    };
  }

  setCardStatus(customerId, cardId, status) {
    if (!['active', 'frozen', 'cancelled'].includes(status)) throw new BankError(`Unknown card status: ${status}`, 'bad_status');
    const card = this.ownedCard(customerId, cardId);
    if (card.status === 'cancelled') throw new BankError('That card is cancelled for good', 'card_cancelled', 409);
    card.status = status;
    this.log('card.status', { cardId, status });
    this.save();
    return this.publicCard(card);
  }

  updateCard(customerId, cardId, patch = {}) {
    const card = this.ownedCard(customerId, cardId);
    for (const field of ['dailyLimit', 'perTransactionLimit']) {
      if (patch[field] != null) card[field] = money.assertPositive(patch[field], field);
    }
    for (const field of ['contactless', 'online']) {
      if (patch[field] != null) card[field] = Boolean(patch[field]);
    }
    if (patch.label) card.label = String(patch.label).slice(0, 40);
    if (patch.roundUpVaultId !== undefined) {
      if (patch.roundUpVaultId === null) {
        card.roundUpVaultId = null;
      } else {
        const vault = this.vault(patch.roundUpVaultId);
        if (vault.ownerId !== customerId) throw new BankError('That vault belongs to somebody else', 'forbidden', 403);
        card.roundUpVaultId = vault.id;
      }
    }
    this.log('card.update', { cardId, patch: Object.keys(patch) });
    this.save();
    return this.publicCard(card);
  }

  cardSpentToday(cardId) {
    const since = new Date(this.now().getTime() - DAY_MS).toISOString();
    let total = 0;
    for (let i = this.state.transactions.length - 1; i >= 0; i -= 1) {
      const tx = this.state.transactions[i];
      if (tx.at < since) break;
      if (tx.type === 'card_payment' && tx.meta?.cardId === cardId) total += tx.meta.amount;
    }
    return total;
  }

  /** Simulates a card purchase, with limits, cashback and round-up saving. */
  cardPayment(cardId, { merchant = 'Merchant', amount, category = 'shopping', online = false } = {}) {
    const card = this.card(cardId);
    if (card.status !== 'active') throw new BankError(`Card is ${card.status}`, 'card_not_active', 409);
    if (online && !card.online) throw new BankError('Online payments are switched off for this card', 'online_disabled', 409);
    const minor = money.assertPositive(amount, 'Payment');
    if (minor > card.perTransactionLimit) {
      throw new BankError(`Over the per-payment limit of ${money.format(card.perTransactionLimit, 'RUB')}`, 'over_transaction_limit', 409);
    }
    if (this.cardSpentToday(card.id) + minor > card.dailyLimit) {
      throw new BankError(`Over the daily card limit of ${money.format(card.dailyLimit, 'RUB')}`, 'over_daily_limit', 409);
    }
    if (!CATEGORIES.includes(category)) category = 'other';

    const account = this.ledger.get(card.accountId);
    const external = this.ledger.systemAccount('external', account.currency);
    const at = this.iso();
    const tx = this.ledger.post({
      type: 'card_payment',
      description: merchant,
      category,
      at,
      meta: { cardId: card.id, merchant, amount: minor, online },
      entries: [
        { accountId: account.id, amount: -minor },
        { accountId: external.id, amount: minor },
      ],
    });

    const result = { transaction: tx, balance: account.balance, currency: account.currency, cashback: 0, roundUp: 0, pointsEarned: 0 };

    if (account.ownerId) {
      const customer = this.customer(account.ownerId);
      const tier = this.tierOf(customer.points);
      const cashback = Math.min(money.basisPoints(minor, tier.cashbackBps), 500_00);
      if (cashback > 0) {
        const treasury = this.ledger.systemAccount('treasury', account.currency);
        this.ledger.post({
          type: 'cashback',
          description: `Cashback · ${merchant}`,
          category: 'income',
          at,
          meta: { cardId: card.id, tier: tier.key, forTx: tx.id },
          entries: [
            { accountId: treasury.id, amount: -cashback },
            { accountId: account.id, amount: cashback },
          ],
        });
        result.cashback = cashback;
      }
      result.pointsEarned = this.awardPoints(customer.id, Math.floor(minor / 100_00), 'card_spend');

      if (card.roundUpVaultId) {
        const scale = 10 ** money.currency(account.currency).digits;
        const roundUp = (scale - (minor % scale)) % scale;
        if (roundUp > 0 && account.balance >= roundUp) {
          try {
            const vault = this.vault(card.roundUpVaultId);
            this.ledger.post({
              type: 'roundup',
              description: `Round-up to ${vault.name}`,
              category: 'savings',
              at,
              meta: { cardId: card.id, forTx: tx.id },
              entries: [
                { accountId: account.id, amount: -roundUp },
                { accountId: vault.accountId, amount: roundUp },
              ],
            });
            result.roundUp = roundUp;
          } catch { /* a frozen or closed vault simply skips the round-up */ }
        }
      }
    }

    result.balance = account.balance;
    this.log('card.payment', { cardId: card.id, merchant, amount: minor });
    this.save();
    return result;
  }

  // -- vaults (savings) ----------------------------------------------------

  openVault(customerId, { name = 'Baikal Vault', currency = 'RUB', goal = null, apyBps = 700 } = {}) {
    const customer = this.customer(customerId);
    const tier = this.tierOf(customer.points);
    const account = this.ledger.createAccount({
      ownerId: customer.id,
      currency: money.currency(currency).code,
      type: 'vault',
      name,
      meta: { vault: true },
    });
    const vault = {
      id: ids.id('vlt'),
      ownerId: customer.id,
      accountId: account.id,
      name,
      goal: goal == null ? null : money.assertPositive(goal, 'Goal'),
      apyBps: apyBps + tier.vaultBonusBps,
      openedAt: this.iso(),
      accruedAt: this.iso(),
      interestPaid: 0,
    };
    this.state.vaults[vault.id] = vault;
    this.log('vault.open', { vaultId: vault.id, customerId });
    this.save();
    return this.publicVault(vault);
  }

  vault(vaultId) {
    const vault = this.state.vaults[vaultId];
    if (!vault) throw new BankError(`No such vault: ${vaultId}`, 'vault_not_found', 404);
    return vault;
  }

  publicVault(vault) {
    const account = this.ledger.get(vault.accountId);
    return {
      ...vault,
      currency: account.currency,
      balance: account.balance,
      apy: vault.apyBps / 100,
      progress: vault.goal ? Math.min(1, account.balance / vault.goal) : null,
      status: account.status,
    };
  }

  vaultMove(customerId, vaultId, { fromAccountId = null, amount, direction = 'in' } = {}) {
    const vault = this.vault(vaultId);
    if (vault.ownerId !== customerId) throw new BankError('That vault belongs to somebody else', 'forbidden', 403);
    const vaultAccount = this.ledger.get(vault.accountId);
    const counterpart = fromAccountId
      ? this.ownedAccount(customerId, fromAccountId)
      : this.primaryAccount(customerId, vaultAccount.currency);
    if (counterpart.currency !== vaultAccount.currency) {
      throw new BankError(`This vault holds ${vaultAccount.currency}; exchange first`, 'currency_mismatch');
    }
    const minor = money.assertPositive(amount, 'Amount');
    const into = direction === 'in';
    const tx = this.ledger.post({
      type: into ? 'vault_deposit' : 'vault_withdrawal',
      description: into ? `Into ${vault.name}` : `Out of ${vault.name}`,
      category: 'savings',
      at: this.iso(),
      meta: { vaultId: vault.id },
      entries: into
        ? [{ accountId: counterpart.id, amount: -minor }, { accountId: vaultAccount.id, amount: minor }]
        : [{ accountId: vaultAccount.id, amount: -minor }, { accountId: counterpart.id, amount: minor }],
    });
    if (into) this.awardPoints(customerId, Math.floor(minor / 1000_00), 'saving');
    this.save();
    return { transaction: tx, vault: this.publicVault(vault) };
  }

  /**
   * Pays simple daily interest on every vault for the whole days elapsed
   * since it was last accrued. Safe to call as often as you like.
   */
  accrueInterest() {
    const now = this.now();
    const paid = [];
    for (const vault of Object.values(this.state.vaults)) {
      const account = this.ledger.get(vault.accountId);
      if (account.status !== 'active' || account.balance <= 0) continue;
      const days = Math.floor((now.getTime() - new Date(vault.accruedAt).getTime()) / DAY_MS);
      if (days < 1) continue;
      const interest = Math.round((account.balance * vault.apyBps * days) / (10000 * 365));
      vault.accruedAt = new Date(new Date(vault.accruedAt).getTime() + days * DAY_MS).toISOString();
      if (interest <= 0) continue;
      const treasury = this.ledger.systemAccount('treasury', account.currency);
      this.ledger.post({
        type: 'interest',
        description: `Interest · ${vault.name} (${days} day${days === 1 ? '' : 's'})`,
        category: 'income',
        at: this.iso(),
        meta: { vaultId: vault.id, days, apyBps: vault.apyBps },
        entries: [
          { accountId: treasury.id, amount: -interest },
          { accountId: account.id, amount: interest },
        ],
      });
      vault.interestPaid += interest;
      paid.push({ vaultId: vault.id, interest, days, currency: account.currency });
    }
    if (paid.length) this.log('interest.accrue', { vaults: paid.length });
    this.save();
    return paid;
  }

  // -- credit line ---------------------------------------------------------

  openCredit(customerId, { limit = 100_000_00, aprBps = 1900, currency = 'RUB' } = {}) {
    const customer = this.customer(customerId);
    if (Object.values(this.state.credit).some((c) => c.ownerId === customerId && c.status === 'open')) {
      throw new BankError('You already have a credit line open', 'credit_exists', 409);
    }
    const cur = money.currency(currency).code;
    const account = this.ledger.createAccount({
      ownerId: customer.id,
      currency: cur,
      type: 'credit',
      name: `${customer.name} · credit line`,
      allowNegative: true,
      meta: { credit: true },
    });
    const credit = {
      id: ids.id('cr'),
      ownerId: customer.id,
      accountId: account.id,
      limit: money.assertPositive(limit, 'Credit limit'),
      aprBps,
      status: 'open',
      openedAt: this.iso(),
      accruedAt: this.iso(),
      interestCharged: 0,
      currency: cur,
    };
    this.state.credit[credit.id] = credit;
    this.log('credit.open', { creditId: credit.id, customerId, limit: credit.limit });
    this.save();
    return this.publicCredit(credit);
  }

  creditLine(creditId) {
    const credit = this.state.credit[creditId];
    if (!credit) throw new BankError(`No such credit line: ${creditId}`, 'credit_not_found', 404);
    return credit;
  }

  publicCredit(credit) {
    const account = this.ledger.get(credit.accountId);
    const drawn = Math.max(0, -account.balance);
    return {
      ...credit,
      drawn,
      available: Math.max(0, credit.limit - drawn),
      apr: credit.aprBps / 100,
    };
  }

  creditDraw(customerId, creditId, { amount, toAccountId = null } = {}) {
    const credit = this.creditLine(creditId);
    if (credit.ownerId !== customerId) throw new BankError('That credit line is not yours', 'forbidden', 403);
    if (credit.status !== 'open') throw new BankError('This credit line is closed', 'credit_closed', 409);
    const minor = money.assertPositive(amount, 'Draw');
    const view = this.publicCredit(credit);
    if (minor > view.available) {
      throw new BankError(`Only ${money.format(view.available, credit.currency)} left on this credit line`, 'over_credit_limit', 409);
    }
    const target = toAccountId ? this.ownedAccount(customerId, toAccountId) : this.primaryAccount(customerId, credit.currency);
    if (target.currency !== credit.currency) throw new BankError('Draw into an account in the same currency', 'currency_mismatch');
    const tx = this.ledger.post({
      type: 'credit_draw',
      description: 'Credit line draw',
      category: 'income',
      at: this.iso(),
      meta: { creditId: credit.id },
      entries: [
        { accountId: credit.accountId, amount: -minor },
        { accountId: target.id, amount: minor },
      ],
    });
    this.log('credit.draw', { creditId: credit.id, amount: minor });
    this.save();
    return { transaction: tx, credit: this.publicCredit(credit) };
  }

  creditRepay(customerId, creditId, { amount, fromAccountId = null } = {}) {
    const credit = this.creditLine(creditId);
    if (credit.ownerId !== customerId) throw new BankError('That credit line is not yours', 'forbidden', 403);
    const view = this.publicCredit(credit);
    if (view.drawn === 0) throw new BankError('Nothing to repay', 'nothing_owed');
    const minor = Math.min(money.assertPositive(amount, 'Repayment'), view.drawn);
    const source = fromAccountId ? this.ownedAccount(customerId, fromAccountId) : this.primaryAccount(customerId, credit.currency);
    const tx = this.ledger.post({
      type: 'credit_repayment',
      description: 'Credit line repayment',
      category: 'transfer',
      at: this.iso(),
      meta: { creditId: credit.id },
      entries: [
        { accountId: source.id, amount: -minor },
        { accountId: credit.accountId, amount: minor },
      ],
    });
    this.log('credit.repay', { creditId: credit.id, amount: minor });
    this.save();
    return { transaction: tx, credit: this.publicCredit(credit) };
  }

  /** Charges daily interest on any drawn balance. */
  accrueCreditInterest() {
    const now = this.now();
    const charged = [];
    for (const credit of Object.values(this.state.credit)) {
      if (credit.status !== 'open') continue;
      const account = this.ledger.get(credit.accountId);
      const drawn = Math.max(0, -account.balance);
      const days = Math.floor((now.getTime() - new Date(credit.accruedAt).getTime()) / DAY_MS);
      if (days < 1) continue;
      credit.accruedAt = new Date(new Date(credit.accruedAt).getTime() + days * DAY_MS).toISOString();
      if (drawn <= 0) continue;
      const interest = Math.round((drawn * credit.aprBps * days) / (10000 * 365));
      if (interest <= 0) continue;
      const fees = this.ledger.systemAccount('fees', credit.currency);
      this.ledger.post({
        type: 'credit_interest',
        description: `Credit interest (${days} day${days === 1 ? '' : 's'})`,
        category: 'fees',
        at: this.iso(),
        meta: { creditId: credit.id, days },
        entries: [
          { accountId: credit.accountId, amount: -interest },
          { accountId: fees.id, amount: interest },
        ],
      });
      credit.interestCharged += interest;
      charged.push({ creditId: credit.id, interest, days });
    }
    this.save();
    return charged;
  }

  // -- payment requests and split bills ------------------------------------

  createRequest(customerId, { accountId = null, amount, note = null, expiresInHours = 72 } = {}) {
    const account = accountId ? this.ownedAccount(customerId, accountId) : this.primaryAccount(customerId);
    const request = {
      code: ids.payCode(),
      ownerId: customerId,
      accountId: account.id,
      currency: account.currency,
      amount: money.assertPositive(amount, 'Requested amount'),
      note,
      status: 'open',
      createdAt: this.iso(),
      expiresAt: new Date(this.now().getTime() + expiresInHours * 3600 * 1000).toISOString(),
      paidBy: null,
      paidAt: null,
    };
    this.state.requests[request.code] = request;
    this.log('request.create', { code: request.code, customerId });
    this.save();
    return request;
  }

  request(code) {
    const request = this.state.requests[String(code || '').toUpperCase()];
    if (!request) throw new BankError(`No payment request with code ${code}`, 'request_not_found', 404);
    return request;
  }

  payRequest(customerId, code, { fromAccountId = null } = {}) {
    const request = this.request(code);
    if (request.status !== 'open') throw new BankError(`That request is already ${request.status}`, 'request_closed', 409);
    if (request.expiresAt < this.iso()) {
      request.status = 'expired';
      this.save();
      throw new BankError('That payment request has expired', 'request_expired', 409);
    }
    if (request.ownerId === customerId) throw new BankError('You cannot pay your own request', 'self_pay');
    const from = fromAccountId ? this.ownedAccount(customerId, fromAccountId) : this.primaryAccount(customerId, request.currency);
    const payer = this.customer(customerId);
    const result = this.transfer(customerId, {
      fromAccountId: from.id,
      to: request.accountId,
      amount: request.amount,
      note: request.note ? `Request ${request.code} · ${request.note}` : `Payment request ${request.code}`,
      category: 'transfer',
    });
    request.status = 'paid';
    request.paidBy = `@${payer.handle}`;
    request.paidAt = this.iso();
    this.log('request.pay', { code: request.code, customerId });
    this.save();
    return { request, ...result };
  }

  /** Splits an amount evenly and raises one payment request per participant. */
  splitBill(customerId, { amount, ways, note = 'Split bill', accountId = null } = {}) {
    const total = money.assertPositive(amount, 'Bill');
    if (!Number.isInteger(ways) || ways < 2) throw new BankError('Split between at least two people', 'bad_split');
    const shares = money.split(total, ways);
    const mine = shares[0];
    const requests = shares.slice(1).map((share) => this.createRequest(customerId, { accountId, amount: share, note }));
    return { total, currency: (accountId ? this.ledger.get(accountId) : this.primaryAccount(customerId)).currency, yourShare: mine, requests };
  }

  // -- scheduled payments --------------------------------------------------

  schedule(customerId, { fromAccountId, to, amount, everyDays = 30, note = null, category = 'transfer', startAt = null } = {}) {
    const from = this.ownedAccount(customerId, fromAccountId);
    const dest = this.resolveDestination(to, from.currency);
    if (!Number.isInteger(everyDays) || everyDays < 1) throw new BankError('Repeat every whole number of days', 'bad_interval');
    const schedule = {
      id: ids.id('sch'),
      ownerId: customerId,
      fromAccountId: from.id,
      toAccountId: dest.id,
      toName: dest.name,
      amount: money.assertPositive(amount, 'Scheduled amount'),
      currency: from.currency,
      everyDays,
      note,
      category,
      nextAt: startAt || new Date(this.now().getTime() + everyDays * DAY_MS).toISOString(),
      status: 'active',
      runs: 0,
      lastError: null,
      createdAt: this.iso(),
    };
    this.state.schedules[schedule.id] = schedule;
    this.log('schedule.create', { scheduleId: schedule.id, customerId });
    this.save();
    return schedule;
  }

  cancelSchedule(customerId, scheduleId) {
    const schedule = this.state.schedules[scheduleId];
    if (!schedule) throw new BankError(`No such standing order: ${scheduleId}`, 'schedule_not_found', 404);
    if (schedule.ownerId !== customerId) throw new BankError('That standing order is not yours', 'forbidden', 403);
    schedule.status = 'cancelled';
    this.save();
    return schedule;
  }

  /** Runs every standing order that has come due, catching up missed cycles. */
  runScheduled() {
    const now = this.now();
    const executed = [];
    for (const schedule of Object.values(this.state.schedules)) {
      if (schedule.status !== 'active') continue;
      let guard = 0;
      while (new Date(schedule.nextAt) <= now && guard < 64) {
        guard += 1;
        try {
          const result = this.transfer(schedule.ownerId, {
            fromAccountId: schedule.fromAccountId,
            to: schedule.toAccountId,
            amount: schedule.amount,
            note: schedule.note || `Standing order to ${schedule.toName}`,
            category: schedule.category,
          });
          schedule.runs += 1;
          schedule.lastError = null;
          executed.push({ scheduleId: schedule.id, transactionId: result.transaction.id });
        } catch (err) {
          schedule.lastError = err.message;
          schedule.status = 'paused';
          this.log('schedule.failed', { scheduleId: schedule.id, error: err.message });
          break;
        }
        schedule.nextAt = new Date(new Date(schedule.nextAt).getTime() + schedule.everyDays * DAY_MS).toISOString();
      }
    }
    this.save();
    return executed;
  }

  // -- reporting -----------------------------------------------------------

  statement(customerId, accountId, { from = null, to = null, limit = 100, offset = 0 } = {}) {
    const account = this.ownedAccount(customerId, accountId);
    const history = this.ledger.history(account.id, { from, to, limit, offset });
    let opening = 0;
    let credits = 0;
    let debits = 0;
    for (const tx of this.state.transactions) {
      const entry = tx.entries.find((e) => e.accountId === account.id);
      if (!entry) continue;
      if (from && tx.at < from) { opening += entry.amount; continue; }
      if (to && tx.at > to) continue;
      if (entry.amount > 0) credits += entry.amount; else debits += -entry.amount;
    }
    return {
      account: { id: account.id, name: account.name, number: account.number, currency: account.currency },
      period: { from, to },
      opening,
      credits,
      debits,
      closing: opening + credits - debits,
      ...history,
    };
  }

  spendingByCategory(customerId, { from = null, to = null } = {}) {
    const owned = new Set(Object.values(this.state.accounts).filter((a) => a.ownerId === customerId).map((a) => a.id));
    const totals = new Map();
    for (const tx of this.state.transactions) {
      if (from && tx.at < from) continue;
      if (to && tx.at > to) continue;
      if (INTERNAL_TYPES.has(tx.type)) continue;
      // A transfer whose every credit lands back on your own books is a move, not a spend.
      if (tx.type.startsWith('transfer') && tx.entries.every((e) => e.amount <= 0 || owned.has(e.accountId))) continue;
      for (const entry of tx.entries) {
        if (!owned.has(entry.accountId) || entry.amount >= 0) continue;
        const key = tx.category || 'other';
        const bucket = totals.get(key) || { category: key, spent: 0, count: 0, currency: entry.currency };
        bucket.spent += -entry.amount;
        bucket.count += 1;
        totals.set(key, bucket);
      }
    }
    const rows = [...totals.values()].sort((a, b) => b.spent - a.spent);
    const total = rows.reduce((sum, row) => sum + row.spent, 0);
    return { total, rows: rows.map((row) => ({ ...row, share: total ? row.spent / total : 0 })) };
  }

  /** Everything the app needs to draw a customer's home screen in one call. */
  overview(customerId) {
    const customer = this.customer(customerId);
    const accounts = this.ledger.accountsOf(customer.id);
    const cards = Object.values(this.state.cards).filter((c) => c.ownerId === customer.id && c.status !== 'cancelled');
    const vaults = Object.values(this.state.vaults).filter((v) => v.ownerId === customer.id).map((v) => this.publicVault(v));
    const credit = Object.values(this.state.credit).filter((c) => c.ownerId === customer.id && c.status === 'open').map((c) => this.publicCredit(c));
    const schedules = Object.values(this.state.schedules).filter((s) => s.ownerId === customer.id && s.status !== 'cancelled');
    const requests = Object.values(this.state.requests).filter((r) => r.ownerId === customer.id && r.status === 'open');

    let netWorthRub = 0;
    for (const account of accounts) {
      netWorthRub += account.currency === 'RUB'
        ? account.balance
        : Math.round((money.toMajor(account.balance, account.currency) / this.rates.rate(account.currency)) * 100);
    }

    const recent = [];
    const owned = new Set(accounts.map((a) => a.id));
    for (let i = this.state.transactions.length - 1; i >= 0 && recent.length < 25; i -= 1) {
      const tx = this.state.transactions[i];
      const entry = tx.entries.find((e) => owned.has(e.accountId));
      if (!entry) continue;
      recent.push({
        id: tx.id, at: tx.at, type: tx.type, description: tx.description,
        category: tx.category, amount: entry.amount, currency: entry.currency,
        accountId: entry.accountId,
      });
    }

    return {
      customer: this.publicCustomer(customer),
      accounts: accounts.map((a) => ({ ...a, pretty: a.number ? ids.prettyAccount(a.number) : null })),
      cards: cards.map((c) => this.publicCard(c)),
      vaults,
      credit,
      schedules,
      requests,
      netWorthRub,
      allowance: this.instantAllowance(customer.id),
      recent,
      spending: this.spendingByCategory(customer.id),
    };
  }

  health() {
    return {
      bank: 'VaivaiBank Buryatia',
      motto: 'Сагай ошохо, мүнгэнэй ерэхэ · Time passes, money arrives',
      customers: Object.keys(this.state.customers).length,
      accounts: Object.keys(this.state.accounts).length,
      transactions: this.state.transactions.length,
      cards: Object.keys(this.state.cards).length,
      vaults: Object.keys(this.state.vaults).length,
      audit: this.ledger.audit(),
      rates: this.rates.board(),
      time: this.iso(),
    };
  }
}

module.exports = { Bank, BankError, LedgerError, TIERS, CATEGORIES, INSTANT_SOURCES, INTERNAL_TYPES, DAY_MS, seed };
