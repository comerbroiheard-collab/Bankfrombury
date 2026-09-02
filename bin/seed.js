#!/usr/bin/env node
'use strict';

/**
 * Fills a fresh ledger with a plausible week at the Ulan-Ude branch so the app
 * has something to show. Safe to re-run: it starts from a clean data file.
 */

const fs = require('node:fs');
const path = require('node:path');
const { Bank, DAY_MS, seed: seedState } = require('../src/bank');
const { Store } = require('../src/store');

const file = process.env.VVB_DATA || path.join(__dirname, '..', 'data', 'bank.json');
fs.mkdirSync(path.dirname(file), { recursive: true });
if (fs.existsSync(file)) fs.rmSync(file);

// A movable clock lets the seed lay down a week of history, then hand the
// bank back to real time with interest already accrued.
let clock = new Date(Date.now() - 7 * DAY_MS);
const store = new Store(file, seedState());
const bank = new Bank({ store, now: () => clock });
const tick = (hours) => { clock = new Date(clock.getTime() + hours * 3600 * 1000); };

const people = [
  { name: 'Bair Dorzhiev', handle: 'bair', pin: '1957', city: 'Ulan-Ude' },
  { name: 'Sesegma Badmaeva', handle: 'sesegma', pin: '2468', city: 'Kyakhta' },
  { name: 'Ayuna Tsyrenova', handle: 'ayuna', pin: '1122', city: 'Severobaikalsk' },
  { name: 'Zorig Namsaraev', handle: 'zorig', pin: null, city: 'Gusinoozyorsk' },
];

const opened = people.map((p) => bank.openCustomer(p));
const [bair, sesegma, ayuna, zorig] = opened;

const merchants = [
  ['Baikal Market', 'groceries', 1_450_00],
  ['Café Modern Nomads', 'cafe', 890_00],
  ['Ulan-Ude Tram', 'transport', 35_00],
  ['TGK-14 Heating', 'utilities', 3_200_00],
  ['Apteka Vita', 'health', 640_00],
  ['Baikal Ferry', 'travel', 2_100_00],
  ['Kinoteatr Progress', 'entertainment', 700_00],
  ['Sagaan Morin Store', 'shopping', 4_300_00],
];

for (const person of opened) {
  bank.instantFunds(person.customer.id, person.account.id, { amount: 45_000_00, source: 'salary', note: 'Salary · Ulan-Ude' });
  tick(3);
}

// A week of card spending, spread across the merchants and the customers.
for (let day = 0; day < 6; day += 1) {
  if (day === 3) {
    // Mid-week top-up: a day past the rolling window, so the tier limit is clear.
    for (const person of opened) {
      bank.instantFunds(person.customer.id, person.account.id, { amount: 40_000_00, source: 'sbp', note: 'Instant top-up' });
    }
  }
  for (const [i, person] of opened.entries()) {
    const [merchant, category, base] = merchants[(day + i) % merchants.length];
    const jitter = 1 + ((day * 7 + i * 13) % 40) / 100;
    try {
      bank.cardPayment(person.card.id, { merchant, amount: Math.round(base * jitter), category });
    } catch { /* limits are part of the demo too */ }
    tick(1);
  }
  tick(18);
}

// Vaults, goals and round-ups.
const vault = bank.openVault(bair.customer.id, { name: 'Baikal winter trip', goal: 200_000_00, apyBps: 750 });
bank.vaultMove(bair.customer.id, vault.id, { amount: 45_000_00, direction: 'in' });
bank.updateCard(bair.customer.id, bair.card.id, { roundUpVaultId: vault.id });
bank.cardPayment(bair.card.id, { merchant: 'Buuza Bar №1', amount: 487_60, category: 'cafe' });

const sesegmaVault = bank.openVault(sesegma.customer.id, { name: 'New yurt', goal: 500_000_00 });
bank.vaultMove(sesegma.customer.id, sesegmaVault.id, { amount: 30_000_00, direction: 'in' });

// A second currency, exchanged through the FX desk.
const usd = bank.openAccount(bair.customer.id, { currency: 'USD', name: 'Bair · dollars' });
bank.exchange(bair.customer.id, { fromAccountId: bair.account.id, toAccountId: usd.id, amount: 20_000_00 });

// Transfers between neighbours, a payment request and a split bill.
bank.transfer(sesegma.customer.id, { fromAccountId: sesegma.account.id, to: '@bair', amount: 3_500_00, note: 'Omul money' });
bank.transfer(zorig.customer.id, { fromAccountId: zorig.account.id, to: '@ayuna', amount: 12_000_00, note: 'Car share' });
const request = bank.createRequest(ayuna.customer.id, { amount: 2_750_00, note: 'Theatre tickets' });
bank.payRequest(zorig.customer.id, request.code);
bank.splitBill(bair.customer.id, { amount: 9_000_00, ways: 3, note: 'Buuza feast' });

// A credit line, drawn and partly repaid.
const credit = bank.openCredit(zorig.customer.id, { limit: 150_000_00, aprBps: 1900 });
bank.creditDraw(zorig.customer.id, credit.id, { amount: 40_000_00 });
bank.creditRepay(zorig.customer.id, credit.id, { amount: 12_000_00 });

// A standing order that has already run a couple of cycles.
bank.schedule(sesegma.customer.id, {
  fromAccountId: sesegma.account.id,
  to: '@bair',
  amount: 1_500_00,
  everyDays: 2,
  note: 'Weekly milk share',
  startAt: new Date(clock.getTime() - 4 * DAY_MS).toISOString(),
});
bank.runScheduled();

// Hand the books back to real time and let interest catch up.
clock = new Date();
bank.accrueInterest();
bank.accrueCreditInterest();
store.close();

const audit = bank.ledger.audit();
process.stdout.write(
  `\n  Seeded ${file}\n` +
  `  ${Object.keys(bank.state.customers).length} customers · ${bank.state.transactions.length} transactions\n` +
  `  Ledger balanced: ${audit.ok ? 'yes' : 'NO — ' + JSON.stringify(audit.drift)}\n\n` +
  people.map((p) => `  @${p.handle.padEnd(9)} PIN ${p.pin || '(none)'}`).join('\n') + '\n\n',
);
if (!audit.ok) process.exit(1);
