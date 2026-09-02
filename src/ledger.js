'use strict';

const money = require('./money');
const ids = require('./ids');

class LedgerError extends Error {
  constructor(message, code = 'ledger_error', status = 400) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
    this.status = status;
  }
}

const ACCOUNT_TYPES = new Set(['checking', 'vault', 'credit', 'system']);
const ACCOUNT_STATUS = new Set(['active', 'frozen', 'closed']);

/**
 * Double-entry ledger. Every movement of money is a transaction made of
 * entries that sum to zero within each currency; balances are a cached
 * projection of those entries and `audit()` proves the cache still matches.
 */
class Ledger {
  constructor(state) {
    state.accounts ||= {};
    state.transactions ||= [];
    this.state = state;
  }

  // -- accounts ------------------------------------------------------------

  createAccount({ ownerId = null, currency = money.DEFAULT_CURRENCY, type = 'checking', name = 'Account', allowNegative = false, meta = {}, key = null }) {
    const cur = money.currency(currency).code;
    if (!ACCOUNT_TYPES.has(type)) throw new LedgerError(`Unknown account type: ${type}`, 'bad_account_type');
    if (key && this.state.accounts[key]) return this.state.accounts[key];

    const account = {
      id: key || ids.id('acc'),
      ownerId,
      type,
      name,
      currency: cur,
      number: type === 'system' ? null : ids.accountNumber(),
      balance: 0,
      allowNegative,
      status: 'active',
      meta,
      openedAt: new Date().toISOString(),
    };
    this.state.accounts[account.id] = account;
    return account;
  }

  get(accountId) {
    const account = this.state.accounts[accountId];
    if (!account) throw new LedgerError(`No such account: ${accountId}`, 'account_not_found', 404);
    return account;
  }

  /** Resolves an id, a printed account number (spaces optional), or nothing. */
  resolve(ref) {
    if (!ref) throw new LedgerError('Account reference is required', 'account_required');
    const raw = String(ref).trim();
    if (this.state.accounts[raw]) return this.state.accounts[raw];
    const normalised = raw.replace(/\s/g, '').toUpperCase();
    const byNumber = Object.values(this.state.accounts).find((a) => a.number === normalised);
    if (byNumber) return byNumber;
    throw new LedgerError(`No such account: ${ref}`, 'account_not_found', 404);
  }

  accountsOf(ownerId) {
    return Object.values(this.state.accounts).filter((a) => a.ownerId === ownerId && a.status !== 'closed');
  }

  /** Lazily creates the bank's own books: external world, treasury, fees. */
  systemAccount(kind, currency) {
    const cur = money.currency(currency).code;
    const key = `sys:${kind}:${cur}`;
    const names = {
      external: `Outside world (${cur})`,
      treasury: `VaivaiBank treasury (${cur})`,
      fees: `Fee income (${cur})`,
    };
    if (!names[kind]) throw new LedgerError(`Unknown system book: ${kind}`, 'bad_system_account');
    return this.state.accounts[key] || this.createAccount({
      key,
      type: 'system',
      name: names[kind],
      currency: cur,
      allowNegative: true,
      meta: { kind },
    });
  }

  setStatus(accountId, status) {
    if (!ACCOUNT_STATUS.has(status)) throw new LedgerError(`Unknown status: ${status}`, 'bad_status');
    const account = this.get(accountId);
    if (status === 'closed' && account.balance !== 0) {
      throw new LedgerError('Empty the account before closing it', 'account_not_empty');
    }
    account.status = status;
    return account;
  }

  // -- transactions --------------------------------------------------------

  /**
   * Posts a transaction. Entries are {accountId, amount} in minor units;
   * positive credits the account, negative debits it. Either the whole
   * transaction applies or none of it does.
   */
  post({ type, description, entries, category = null, meta = {}, at = new Date().toISOString() }) {
    if (!Array.isArray(entries) || entries.length < 2) {
      throw new LedgerError('A transaction needs at least two entries', 'bad_entries');
    }

    const resolved = entries.map((entry) => {
      const account = this.get(entry.accountId);
      const amount = money.assertMinor(entry.amount);
      if (amount === 0) throw new LedgerError('Entries cannot be zero', 'bad_entries');
      return { account, accountId: account.id, currency: account.currency, amount };
    });

    // Zero-sum within each currency.
    const sums = new Map();
    for (const entry of resolved) {
      sums.set(entry.currency, (sums.get(entry.currency) || 0) + entry.amount);
    }
    for (const [cur, sum] of sums) {
      if (sum !== 0) throw new LedgerError(`Entries do not balance in ${cur} (off by ${sum})`, 'unbalanced');
    }

    // Pre-flight: status and funds, before a single balance moves.
    for (const entry of resolved) {
      if (entry.account.status === 'closed') {
        throw new LedgerError(`${entry.account.name} is closed`, 'account_closed', 409);
      }
      if (entry.account.status === 'frozen') {
        throw new LedgerError(`${entry.account.name} is frozen`, 'account_frozen', 409);
      }
      const after = entry.account.balance + entry.amount;
      if (after < 0 && !entry.account.allowNegative) {
        throw new LedgerError(
          `Insufficient funds in ${entry.account.name}: need ${money.format(-after, entry.currency)} more`,
          'insufficient_funds',
          409,
        );
      }
    }

    for (const entry of resolved) entry.account.balance += entry.amount;

    const tx = {
      id: ids.id('tx'),
      type,
      description,
      category,
      at,
      meta,
      entries: resolved.map((e) => ({ accountId: e.accountId, currency: e.currency, amount: e.amount })),
    };
    this.state.transactions.push(tx);
    return tx;
  }

  balance(accountId) {
    return this.get(accountId).balance;
  }

  /** Transactions touching an account, newest first, with the local delta. */
  history(accountId, { limit = 50, offset = 0, from = null, to = null, category = null, type = null } = {}) {
    const account = this.get(accountId);
    const rows = [];
    for (let i = this.state.transactions.length - 1; i >= 0; i -= 1) {
      const tx = this.state.transactions[i];
      const entry = tx.entries.find((e) => e.accountId === account.id);
      if (!entry) continue;
      if (from && tx.at < from) continue;
      if (to && tx.at > to) continue;
      if (category && tx.category !== category) continue;
      if (type && tx.type !== type) continue;
      rows.push({
        id: tx.id,
        at: tx.at,
        type: tx.type,
        description: tx.description,
        category: tx.category,
        amount: entry.amount,
        currency: entry.currency,
        meta: tx.meta,
        counterparties: tx.entries
          .filter((e) => e.accountId !== account.id)
          .map((e) => ({ accountId: e.accountId, name: this.state.accounts[e.accountId]?.name ?? 'unknown', amount: e.amount })),
      });
    }
    return { total: rows.length, rows: rows.slice(offset, offset + limit) };
  }

  /**
   * Re-derives every balance from the transaction log and reports any account
   * whose cached balance drifted, plus the zero-sum check per currency.
   */
  audit() {
    const derived = new Map();
    const totals = new Map();
    for (const tx of this.state.transactions) {
      for (const entry of tx.entries) {
        derived.set(entry.accountId, (derived.get(entry.accountId) || 0) + entry.amount);
        totals.set(entry.currency, (totals.get(entry.currency) || 0) + entry.amount);
      }
    }
    const drift = [];
    for (const account of Object.values(this.state.accounts)) {
      const expected = derived.get(account.id) || 0;
      if (expected !== account.balance) {
        drift.push({ accountId: account.id, name: account.name, cached: account.balance, derived: expected });
      }
    }
    const unbalanced = [...totals.entries()].filter(([, sum]) => sum !== 0).map(([currency, sum]) => ({ currency, sum }));
    return {
      ok: drift.length === 0 && unbalanced.length === 0,
      accounts: Object.keys(this.state.accounts).length,
      transactions: this.state.transactions.length,
      drift,
      unbalanced,
    };
  }
}

module.exports = { Ledger, LedgerError, ACCOUNT_TYPES, ACCOUNT_STATUS };
