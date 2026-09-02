#!/usr/bin/env node
'use strict';

/** Teller's command line — the same bank core the HTTP API drives. */

const path = require('node:path');
const { Bank, seed: seedState } = require('../src/bank');
const { Store } = require('../src/store');
const money = require('../src/money');
const ids = require('../src/ids');

const file = process.env.VVB_DATA || path.join(__dirname, '..', 'data', 'bank.json');
const store = new Store(file, seedState());
const bank = new Bank({ store });

const [command, ...args] = process.argv.slice(2);
const out = (line = '') => process.stdout.write(`${line}\n`);

function amount(value, currency) {
  return money.toMinor(value, currency);
}

const commands = {
  help() {
    out(`
  VaivaiBank Buryatia · teller CLI      ledger: ${file}

    vvb open <name> <handle> [pin]        open a customer, account and card
    vvb topup <@handle> <amount> [source] add instant funds
    vvb send <@from> <@to> <amount> [note]
    vvb balance [@handle]                 balances, or every customer
    vvb card <@handle> <merchant> <amount> [category]
    vvb rates                             the FX board
    vvb audit                             re-derive every balance from the log
    vvb history <@handle> [n]             recent transactions
`);
  },

  open([name, handle, pin]) {
    if (!name || !handle) throw new Error('usage: vvb open <name> <handle> [pin]');
    const { customer, account, card } = bank.openCustomer({ name, handle, pin: pin || null });
    out(`  opened @${customer.handle} · ${ids.prettyAccount(account.number)} · card ${ids.maskCard(card.pan)}`);
  },

  topup([handle, value, source = 'demo']) {
    const customer = bank.findCustomer(handle);
    const account = bank.primaryAccount(customer.id);
    const res = bank.instantFunds(customer.id, account.id, { amount: amount(value, account.currency), source });
    out(`  ⚡ ${money.format(res.transaction.entries.find((e) => e.amount > 0).amount, account.currency)} → @${customer.handle}`);
    out(`  balance ${money.format(res.balance, res.currency)} · ${res.allowance.remaining == null ? 'unlimited' : money.format(res.allowance.remaining, 'RUB') + ' left today'}`);
  },

  send([from, to, value, ...note]) {
    const sender = bank.findCustomer(from);
    const account = bank.primaryAccount(sender.id);
    const res = bank.transfer(sender.id, { fromAccountId: account.id, to, amount: amount(value, account.currency), note: note.join(' ') || null });
    out(`  sent ${money.format(amount(value, account.currency), account.currency)} ${from} → ${to}`);
    out(`  ${res.transaction.id} · balance ${money.format(res.balance, res.currency)}`);
  },

  card([handle, merchant, value, category = 'shopping']) {
    const customer = bank.findCustomer(handle);
    const card = Object.values(bank.state.cards).find((c) => c.ownerId === customer.id && c.status === 'active');
    if (!card) throw new Error(`@${customer.handle} has no active card`);
    const account = bank.ledger.get(card.accountId);
    const res = bank.cardPayment(card.id, { merchant, amount: amount(value, account.currency), category });
    out(`  paid ${merchant} · balance ${money.format(res.balance, res.currency)}` +
      (res.cashback ? ` · cashback ${money.format(res.cashback, res.currency)}` : '') +
      (res.roundUp ? ` · round-up ${money.format(res.roundUp, res.currency)}` : ''));
  },

  balance([handle]) {
    const people = handle ? [bank.findCustomer(handle)] : Object.values(bank.state.customers);
    for (const customer of people) {
      const tier = bank.tierOf(customer.points);
      out(`\n  @${customer.handle} · ${customer.name} · ${tier.name} (${customer.points} pts)`);
      for (const account of bank.ledger.accountsOf(customer.id)) {
        out(`    ${account.name.padEnd(30)} ${money.format(account.balance, account.currency).padStart(18)}  ${account.number ? ids.prettyAccount(account.number) : ''}`);
      }
    }
    out();
  },

  history([handle, n = '12']) {
    const customer = bank.findCustomer(handle);
    const account = bank.primaryAccount(customer.id);
    for (const tx of bank.ledger.history(account.id, { limit: Number(n) }).rows) {
      out(`  ${tx.at.slice(0, 16).replace('T', ' ')}  ${money.format(tx.amount, tx.currency, { sign: true }).padStart(16)}  ${tx.description}`);
    }
  },

  rates() {
    const board = bank.rates.board();
    out(`\n  FX board · base ${board.base} · spread ${board.spreadBps / 100}%`);
    for (const row of board.rates) out(`    1 ${row.code.padEnd(4)} = ${row.rublesPerUnit.toFixed(4)} RUB`);
    out();
  },

  audit() {
    const report = bank.ledger.audit();
    out(`\n  ${report.ok ? '✓ ledger balances' : '✗ ledger drift'} · ${report.accounts} accounts · ${report.transactions} transactions`);
    for (const row of report.drift) out(`    drift ${row.name}: cached ${row.cached} vs derived ${row.derived}`);
    for (const row of report.unbalanced) out(`    unbalanced ${row.currency}: ${row.sum}`);
    out();
    if (!report.ok) process.exitCode = 1;
  },
};

try {
  (commands[command] || commands.help)(args);
  store.close();
} catch (err) {
  process.stderr.write(`\n  ${err.message}\n\n`);
  process.exitCode = 1;
}
