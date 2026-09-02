/* VaivaiBank Buryatia — front of house.
   Vanilla JS, no build step. State lives in `S`, the server owns the truth. */
'use strict';

const S = {
  token: localStorage.getItem('vvb.token') || null,
  me: null,
  meta: null,
  view: 'home',
  accountId: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ---------------- api ---------------- */

async function api(path, { method = 'GET', body = null } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(S.token ? { authorization: `Bearer ${S.token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(payload.message || `Request failed (${res.status})`);
    err.code = payload.error;
    err.status = res.status;
    throw err;
  }
  return payload;
}

/* ---------------- formatting ---------------- */

const SYMBOLS = { RUB: '₽', USD: '$', EUR: '€', CNY: '¥', MNT: '₮', KZT: '₸' };
const DIGITS = { RUB: 2, USD: 2, EUR: 2, CNY: 2, MNT: 2, KZT: 2 };

function fmt(minor, currency = 'RUB', { sign = false } = {}) {
  const digits = DIGITS[currency] ?? 2;
  const scale = 10 ** digits;
  const negative = minor < 0;
  const abs = Math.abs(minor);
  const whole = String(Math.trunc(abs / scale)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const frac = String(abs % scale).padStart(digits, '0');
  const prefix = negative ? '−' : sign ? '+' : '';
  return `${prefix}${whole},${frac} ${SYMBOLS[currency] || currency}`;
}

const when = (iso) => new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const TX_ICONS = {
  instant_funds: '⚡', transfer: '➔', transfer_fx: '⇄', exchange: '⇄', card_payment: '▭',
  cashback: '★', roundup: '◇', vault_deposit: '◇', vault_withdrawal: '◇', interest: '✦',
  credit_draw: '◐', credit_repayment: '◑', credit_interest: '%',
};

function toast(title, detail = '', kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<b>${esc(title)}</b>${detail ? `<small>${esc(detail)}</small>` : ''}`;
  $('#toasts').append(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s, transform .3s';
    el.style.opacity = '0';
    el.style.transform = 'translateX(18px)';
    setTimeout(() => el.remove(), 320);
  }, 4200);
}

async function run(fn, okTitle) {
  try {
    const result = await fn();
    if (okTitle) toast(okTitle, '', 'good');
    await refresh();
    return result;
  } catch (err) {
    toast('Declined', err.message, 'bad');
    return null;
  }
}

/* ---------------- session ---------------- */

async function boot() {
  S.meta = await api('/meta');
  if (S.token) {
    try {
      S.me = await api('/me');
      enterApp();
      return;
    } catch {
      localStorage.removeItem('vvb.token');
      S.token = null;
    }
  }
  showGate();
}

async function showGate() {
  $('#gate').classList.remove('is-hidden');
  $('#app').classList.add('is-hidden');
  try {
    const { customers } = await api('/directory');
    $('#directory-hint').textContent = customers.length
      ? `Open handles here: ${customers.slice(0, 6).map((c) => c.handle).join(', ')}`
      : 'No accounts open yet — be the first customer of the branch.';
  } catch { /* directory is a nicety */ }
}

function enterApp() {
  $('#gate').classList.add('is-hidden');
  $('#app').classList.remove('is-hidden');
  render();
}

async function refresh() {
  S.me = await api('/me');
  render();
}

/* ---------------- views ---------------- */

function accountById(id) {
  return S.me.accounts.find((a) => a.id === id);
}

function activeAccount() {
  return accountById(S.accountId) || S.me.accounts.find((a) => a.type === 'checking') || S.me.accounts[0];
}

function accountOptions(selectedId, filter = () => true) {
  return S.me.accounts.filter(filter).map((a) =>
    `<option value="${a.id}" ${a.id === selectedId ? 'selected' : ''}>${esc(a.name)} · ${fmt(a.balance, a.currency)}</option>`).join('');
}

function render() {
  const me = S.me;
  $('#networth').textContent = fmt(me.netWorthRub, 'RUB');
  $('#tier-chip').textContent = `${me.customer.tier.name} · ${me.customer.points.toLocaleString('en-GB')} pts`;
  $('#tier-chip').title = me.customer.nextTier
    ? `${(me.customer.nextTier.points - me.customer.points).toLocaleString('en-GB')} points to ${me.customer.nextTier.name}`
    : 'Top tier — Baikal';
  $$('.rail-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.view === S.view));
  $('#main').innerHTML = (VIEWS[S.view] || VIEWS.home)();
}

const VIEWS = {

  /* ---- home: instant funds, accounts, recent ---- */
  home() {
    const me = S.me;
    const account = activeAccount();
    const a = me.allowance;
    const used = a.limit ? Math.min(100, (a.used / a.limit) * 100) : 0;

    return `
    <div class="view">
      <section class="hero">
        <div class="split">
          <div>
            <p class="hint">${esc(account.name)} · ${esc(account.pretty || '')}</p>
            <div class="hero-balance">${fmt(account.balance, account.currency)}</div>
            <p class="hero-sub">Сайн байна, ${esc(me.customer.name.split(' ')[0])}. ${me.customer.tier.name} tier · ${me.customer.tier.cashbackBps / 100}% cashback on card spend.</p>
          </div>
          <div style="text-align:right">
            <p class="hint">Instant funds left today</p>
            <b style="font-size:20px">${a.limit == null ? 'Unlimited' : fmt(a.remaining, 'RUB')}</b>
          </div>
        </div>

        <div class="allowance"><i style="width:${used}%"></i></div>

        <form class="instant-form" data-form="instant">
          <label>Add instant funds
            <input name="amount" type="number" min="1" step="0.01" placeholder="5000" required />
          </label>
          <label>Source
            <select name="source">${S.meta.instantSources.map((s) => `<option value="${s.key}">${esc(s.label)}</option>`).join('')}</select>
          </label>
          <button class="btn btn-primary" type="submit">⚡ Add now</button>
        </form>
        <div class="amount-row">
          ${[1000, 5000, 25000, 100000].map((v) => `<button class="btn btn-sm" data-quick="${v}">+ ${fmt(v * 100, account.currency)}</button>`).join('')}
        </div>
      </section>

      <div class="section-title"><h2>Accounts</h2><button class="btn btn-sm" data-open="account">+ New account</button></div>
      <div class="grid grid-3">
        ${me.accounts.map((acc) => `
          <div class="account ${acc.id === account.id ? 'is-active' : ''}" data-account="${acc.id}">
            <div class="split">
              <span class="pill">${esc(acc.currency)} · ${esc(acc.type)}</span>
              ${acc.status !== 'active' ? `<span class="pill bad">${esc(acc.status)}</span>` : ''}
            </div>
            <b>${fmt(acc.balance, acc.currency)}</b>
            <div>${esc(acc.name)}</div>
            <div class="num-line">${esc(acc.pretty || '—')}</div>
          </div>`).join('')}
      </div>

      <div class="grid grid-2">
        <section class="card">
          <h3>Recent activity</h3>
          ${txList(me.recent.slice(0, 8))}
        </section>
        <section class="card">
          <h3>Where the money goes</h3>
          ${spendingChart(me.spending)}
        </section>
      </div>
    </div>`;
  },

  /* ---- send: transfer, exchange, request, split ---- */
  send() {
    const me = S.me;
    const from = activeAccount();
    return `
    <div class="view">
      <div class="section-title"><h2>Move money</h2><p class="muted">Instant between VaivaiBank accounts, any currency, any handle.</p></div>
      <div class="grid grid-2">
        <section class="card">
          <h3>Send to a handle</h3>
          <form class="form-grid" data-form="transfer">
            <label>From<select name="fromAccountId">${accountOptions(from.id)}</select></label>
            <label>To<input name="to" placeholder="@sesegma or VVB BU 0301 …" required /></label>
            <div class="row">
              <label>Amount<input name="amount" type="number" min="0.01" step="0.01" required /></label>
              <label>Category<select name="category">${S.meta.categories.map((c) => `<option ${c === 'transfer' ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
            </div>
            <label>Note<input name="note" placeholder="For the omul" /></label>
            <button class="btn btn-primary">Send instantly</button>
          </form>
        </section>

        <section class="card">
          <h3>Exchange between your accounts</h3>
          <form class="form-grid" data-form="exchange">
            <div class="row">
              <label>From<select name="fromAccountId">${accountOptions(from.id, (a) => a.type !== 'credit')}</select></label>
              <label>To<select name="toAccountId">${accountOptions(null, (a) => a.type !== 'credit' && a.id !== from.id)}</select></label>
            </div>
            <label>Amount<input name="amount" type="number" min="0.01" step="0.01" required /></label>
            <button class="btn">Exchange at ${S.meta.rates.spreadBps / 100}% spread</button>
            <p class="hint">Cross-currency sends work too — the FX desk sits in the middle so both books balance.</p>
          </form>
        </section>

        <section class="card">
          <h3>Request money</h3>
          <form class="form-grid" data-form="request">
            <div class="row">
              <label>Amount<input name="amount" type="number" min="0.01" step="0.01" required /></label>
              <label>Expires in (hours)<input name="expiresInHours" type="number" value="72" min="1" /></label>
            </div>
            <label>Note<input name="note" placeholder="Dinner at Ulan-Ude" /></label>
            <button class="btn">Create pay code</button>
          </form>
          ${me.requests.length ? `<div class="stack" style="margin-top:14px">${me.requests.map((r) => `
            <div class="split"><span class="mono">${esc(r.code)}</span><span>${fmt(r.amount, r.currency)}</span><span class="pill">${esc(r.status)}</span></div>`).join('')}</div>` : ''}
        </section>

        <section class="card">
          <h3>Pay a code · split a bill</h3>
          <form class="form-grid" data-form="pay-code" style="margin-bottom:18px">
            <label>Pay code<input name="code" placeholder="VVB-7K2Q-4M" required /></label>
            <button class="btn btn-primary">Pay request</button>
          </form>
          <form class="form-grid" data-form="split">
            <div class="row">
              <label>Bill total<input name="amount" type="number" min="0.01" step="0.01" required /></label>
              <label>Ways<input name="ways" type="number" min="2" value="3" /></label>
            </div>
            <label>Note<input name="note" value="Split bill" /></label>
            <button class="btn">Split evenly, to the kopeck</button>
          </form>
        </section>
      </div>
    </div>`;
  },

  /* ---- cards ---- */
  cards() {
    const me = S.me;
    return `
    <div class="view">
      <div class="section-title"><h2>Cards</h2><button class="btn btn-sm" data-open="card">+ Issue card</button></div>
      ${me.cards.length ? '' : '<p class="empty">No cards yet.</p>'}
      <div class="grid grid-2">
        ${me.cards.map((card) => {
          const acc = accountById(card.accountId);
          return `
          <section class="card">
            <div class="plastic ${card.status !== 'active' ? 'is-frozen' : ''}">
              <div class="split">
                <div class="chip-gold"></div>
                <small>${esc(card.status)}</small>
              </div>
              <div>
                <div class="pan" data-pan="${card.id}">${esc(card.masked)}</div>
                <div class="split" style="margin-top:10px">
                  <small>${esc(card.label)}</small>
                  <small>exp ${esc(card.expiry)}</small>
                </div>
              </div>
            </div>

            <div class="split" style="margin:14px 0">
              <span class="muted">${esc(acc ? acc.name : '')} · ${acc ? fmt(acc.balance, acc.currency) : ''}</span>
              <span>
                <button class="btn btn-sm" data-card-reveal="${card.id}">Show details</button>
                <button class="btn btn-sm" data-card-status="${card.id}" data-next="${card.status === 'active' ? 'frozen' : 'active'}">${card.status === 'active' ? 'Freeze' : 'Unfreeze'}</button>
              </span>
            </div>

            <form class="form-grid" data-form="card-limits" data-card="${card.id}">
              <div class="row">
                <label>Per payment<input name="perTransactionLimit" type="number" step="1" value="${(card.perTransactionLimit / 100).toFixed(0)}" /></label>
                <label>Daily<input name="dailyLimit" type="number" step="1" value="${(card.dailyLimit / 100).toFixed(0)}" /></label>
              </div>
              <label>Round-up savings into
                <select name="roundUpVaultId">
                  <option value="">— off —</option>
                  ${me.vaults.map((v) => `<option value="${v.id}" ${card.roundUpVaultId === v.id ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}
                </select>
              </label>
              <button class="btn btn-sm">Save card settings</button>
            </form>

            <form class="form-grid" data-form="card-payment" data-card="${card.id}" style="margin-top:14px;border-top:1px solid var(--line-soft);padding-top:14px">
              <p class="hint">Try the card — simulate a purchase and watch cashback, points and round-up land.</p>
              <div class="row3">
                <label>Merchant<input name="merchant" value="Baikal Market" /></label>
                <label>Amount<input name="amount" type="number" min="0.01" step="0.01" value="899.40" /></label>
                <label>Category<select name="category">${S.meta.categories.map((c) => `<option ${c === 'groceries' ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
              </div>
              <button class="btn">Pay ▸</button>
            </form>
          </section>`;
        }).join('')}
      </div>
    </div>`;
  },

  /* ---- save ---- */
  save() {
    const me = S.me;
    return `
    <div class="view">
      <div class="section-title">
        <h2>Baikal vaults</h2>
        <button class="btn btn-sm" data-action="accrue">Run interest accrual</button>
      </div>
      <div class="grid grid-2">
        <section class="card">
          <h3>Open a vault</h3>
          <form class="form-grid" data-form="vault">
            <label>Name<input name="name" value="Baikal Vault" required /></label>
            <div class="row3">
              <label>Currency<select name="currency">${S.meta.currencies.map((c) => `<option>${c.code}</option>`).join('')}</select></label>
              <label>Goal<input name="goal" type="number" step="0.01" placeholder="200000" /></label>
              <label>Rate %<input name="apy" type="number" step="0.1" value="7" /></label>
            </div>
            <button class="btn btn-primary">Open vault</button>
            <p class="hint">Your ${esc(me.customer.tier.name)} tier adds +${me.customer.tier.vaultBonusBps / 100}% on top of the headline rate.</p>
          </form>
        </section>

        ${me.vaults.map((v) => `
        <section class="card">
          <div class="split">
            <div>
              <h3 style="margin-bottom:4px">${esc(v.name)}</h3>
              <p class="muted">${v.apy.toFixed(2)}% a year · interest paid ${fmt(v.interestPaid, v.currency)}</p>
            </div>
            <b style="font-size:20px">${fmt(v.balance, v.currency)}</b>
          </div>
          ${v.goal ? `
            <div class="allowance" style="margin:14px 0"><i style="width:${Math.round(v.progress * 100)}%"></i></div>
            <p class="hint">${Math.round(v.progress * 100)}% of ${fmt(v.goal, v.currency)}</p>` : ''}
          <form class="form-grid" data-form="vault-move" data-vault="${v.id}" style="margin-top:14px">
            <div class="row3">
              <label>Amount<input name="amount" type="number" min="0.01" step="0.01" required /></label>
              <label>Direction<select name="direction"><option value="in">Into vault</option><option value="out">Out of vault</option></select></label>
              <label>Account<select name="accountId">${accountOptions(null, (a) => a.currency === v.currency && a.type === 'checking')}</select></label>
            </div>
            <button class="btn">Move</button>
          </form>
        </section>`).join('')}
      </div>
    </div>`;
  },

  /* ---- borrow ---- */
  borrow() {
    const me = S.me;
    if (!me.credit.length) {
      return `
      <div class="view">
        <div class="section-title"><h2>Credit line</h2></div>
        <section class="card" style="max-width:520px">
          <h3>Open a credit line</h3>
          <form class="form-grid" data-form="credit">
            <div class="row">
              <label>Limit ₽<input name="limit" type="number" value="100000" min="1000" /></label>
              <label>APR %<input name="apr" type="number" step="0.1" value="19" /></label>
            </div>
            <button class="btn btn-primary">Open credit line</button>
            <p class="hint">Interest is charged daily on the drawn balance only. Repay any time; the ledger tracks every kopeck.</p>
          </form>
        </section>
      </div>`;
    }
    return `
    <div class="view">
      <div class="section-title"><h2>Credit line</h2><button class="btn btn-sm" data-action="accrue-credit">Charge interest</button></div>
      ${me.credit.map((c) => `
      <section class="card">
        <div class="grid grid-3">
          <div><p class="hint">Drawn</p><b style="font-size:22px">${fmt(c.drawn, c.currency)}</b></div>
          <div><p class="hint">Available</p><b style="font-size:22px">${fmt(c.available, c.currency)}</b></div>
          <div><p class="hint">Rate</p><b style="font-size:22px">${c.apr.toFixed(2)}%</b></div>
        </div>
        <div class="allowance" style="margin:16px 0"><i style="width:${Math.round((c.drawn / c.limit) * 100)}%"></i></div>
        <div class="grid grid-2">
          <form class="form-grid" data-form="credit-draw" data-credit="${c.id}">
            <label>Draw amount<input name="amount" type="number" min="0.01" step="0.01" required /></label>
            <button class="btn">Draw to my account</button>
          </form>
          <form class="form-grid" data-form="credit-repay" data-credit="${c.id}">
            <label>Repay amount<input name="amount" type="number" min="0.01" step="0.01" required /></label>
            <button class="btn">Repay</button>
          </form>
        </div>
        <p class="hint" style="margin-top:12px">Interest charged so far: ${fmt(c.interestCharged, c.currency)}</p>
      </section>`).join('')}
    </div>`;
  },

  /* ---- activity ---- */
  activity() {
    const me = S.me;
    const account = activeAccount();
    return `
    <div class="view">
      <div class="section-title">
        <h2>Activity</h2>
        <label style="min-width:280px">Account<select data-select="account">${accountOptions(account.id)}</select></label>
      </div>
      <div class="grid grid-2">
        <section class="card">
          <h3>Statement · ${esc(account.name)}</h3>
          <div id="statement">Loading…</div>
        </section>
        <section class="card">
          <h3>Spending by category</h3>
          ${spendingChart(me.spending)}
        </section>
      </div>
      <section class="card">
        <h3>Standing orders</h3>
        <form class="form-grid" data-form="schedule" style="margin-bottom:16px">
          <div class="row3">
            <label>From<select name="fromAccountId">${accountOptions(account.id)}</select></label>
            <label>To<input name="to" placeholder="@handle" required /></label>
            <label>Amount<input name="amount" type="number" min="0.01" step="0.01" required /></label>
          </div>
          <div class="row3">
            <label>Every (days)<input name="everyDays" type="number" value="30" min="1" /></label>
            <label>Note<input name="note" placeholder="Rent" /></label>
            <label>&nbsp;<button class="btn">Create standing order</button></label>
          </div>
        </form>
        ${me.schedules.length ? `<table class="data">
          <thead><tr><th>To</th><th>Amount</th><th>Every</th><th>Next</th><th>Status</th><th></th></tr></thead>
          <tbody>${me.schedules.map((s) => `<tr>
            <td>${esc(s.toName)}</td><td>${fmt(s.amount, s.currency)}</td><td>${s.everyDays}d</td>
            <td>${when(s.nextAt)}</td><td><span class="pill ${s.status === 'active' ? 'good' : 'bad'}">${esc(s.status)}</span></td>
            <td><button class="btn btn-sm btn-danger" data-cancel-schedule="${s.id}">Cancel</button></td>
          </tr>`).join('')}</tbody></table>` : '<p class="empty">No standing orders yet.</p>'}
      </section>
    </div>`;
  },

  /* ---- bank ---- */
  bank() {
    const rates = S.meta.rates;
    return `
    <div class="view">
      <div class="section-title"><h2>The bank</h2><button class="btn btn-sm" data-action="health">Re-run audit</button></div>
      <div class="grid grid-2">
        <section class="card">
          <h3>FX board · base ${esc(rates.base)}</h3>
          <table class="data">
            <thead><tr><th>Currency</th><th>Per ruble</th><th>Rubles per unit</th></tr></thead>
            <tbody>${rates.rates.map((r) => `<tr><td>${esc(r.code)} ${SYMBOLS[r.code] || ''}</td><td>${r.perRuble.toFixed(4)}</td><td>${r.rublesPerUnit.toFixed(4)}</td></tr>`).join('')}</tbody>
          </table>
          <p class="hint" style="margin-top:10px">Spread ${rates.spreadBps / 100}% per conversion, booked to fee income.</p>
        </section>

        <section class="card">
          <h3>Ledger integrity</h3>
          <div id="audit-panel"><p class="muted">Press “Re-run audit” to re-derive every balance from the transaction log.</p></div>
          <p class="hint" style="margin-top:12px">Every movement is double-entry: entries sum to zero in each currency, and cached balances are checked against the log.</p>
        </section>

        <section class="card">
          <h3>Loyalty tiers</h3>
          <table class="data">
            <thead><tr><th>Tier</th><th>From</th><th>Instant funds / day</th><th>Cashback</th></tr></thead>
            <tbody>${S.meta.tiers.map((t) => `<tr>
              <td>${esc(t.name)}${t.key === S.me.customer.tier.key ? ' <span class="pill good">you</span>' : ''}</td>
              <td>${t.points.toLocaleString('en-GB')} pts</td>
              <td>${t.instantDailyLimit == null ? 'Unlimited' : fmt(t.instantDailyLimit, 'RUB')}</td>
              <td>${t.cashbackBps / 100}%</td></tr>`).join('')}</tbody>
          </table>
        </section>

        <section class="card">
          <h3>Talk to the API</h3>
          <code class="codeblock">curl -X POST localhost:4173/api/accounts/${esc(activeAccount().id)}/instant-funds \\
  -H "authorization: Bearer &lt;token&gt;" \\
  -H "content-type: application/json" \\
  -d '{"amount": 5000, "source": "sbp"}'</code>
          <p class="hint" style="margin-top:10px">Same endpoints the app uses. Send an <span class="mono">idempotencyKey</span> and a retry can never double-credit.</p>
        </section>
      </div>
    </div>`;
  },
};

/* ---------------- components ---------------- */

function txList(rows) {
  if (!rows.length) return '<p class="empty">Nothing yet. Add some instant funds to get going.</p>';
  return rows.map((tx) => `
    <div class="tx">
      <div class="tx-icon">${TX_ICONS[tx.type] || '•'}</div>
      <div class="tx-main">
        <b>${esc(tx.description)}</b>
        <small>${when(tx.at)} · ${esc(tx.category || tx.type)}</small>
      </div>
      <div class="tx-amt ${tx.amount > 0 ? 'in' : ''}">${fmt(tx.amount, tx.currency, { sign: true })}</div>
    </div>`).join('');
}

/**
 * Spending by category: horizontal bars, one row per category, sorted by size.
 * Categories past the eighth fold into "other" — hues are assigned in fixed
 * order and never cycled, and every bar carries its own label and value so
 * identity never rests on colour alone.
 */
function spendingChart(spending) {
  if (!spending.total) return '<p class="empty">No outgoings to chart yet.</p>';
  const SLOTS = 8;
  const rows = [...spending.rows];
  const head = rows.slice(0, SLOTS - 1);
  const tail = rows.slice(SLOTS - 1);
  if (tail.length) {
    head.push({
      category: `other (${tail.length})`,
      spent: tail.reduce((sum, r) => sum + r.spent, 0),
      count: tail.reduce((sum, r) => sum + r.count, 0),
      currency: tail[0].currency,
    });
  }
  const max = Math.max(...head.map((r) => r.spent));
  return `
    <div class="bars" role="img" aria-label="Spending by category">
      ${head.map((row, i) => `
        <div class="bar-row" title="${esc(row.category)}: ${fmt(row.spent, row.currency)} across ${row.count} transaction${row.count === 1 ? '' : 's'}">
          <div class="bar-label">${esc(row.category)}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, (row.spent / max) * 100)}%;background:var(--series-${i + 1})"></div></div>
          <div class="bar-value">${fmt(row.spent, row.currency)}</div>
        </div>`).join('')}
    </div>
    <p class="hint" style="margin-top:14px">Total out: ${fmt(spending.total, 'RUB')}</p>`;
}

async function loadStatement() {
  const host = $('#statement');
  if (!host) return;
  try {
    const account = activeAccount();
    const st = await api(`/accounts/${account.id}/statement?limit=40`);
    host.innerHTML = `
      <div class="grid grid-3" style="margin-bottom:14px">
        <div><p class="hint">In</p><b class="num" style="color:var(--good)">${fmt(st.credits, st.account.currency)}</b></div>
        <div><p class="hint">Out</p><b class="num">${fmt(st.debits, st.account.currency)}</b></div>
        <div><p class="hint">Closing</p><b class="num">${fmt(st.closing, st.account.currency)}</b></div>
      </div>
      ${txList(st.rows)}`;
  } catch (err) {
    host.innerHTML = `<p class="empty">${esc(err.message)}</p>`;
  }
}

/* ---------------- events ---------------- */

document.addEventListener('click', async (event) => {
  const t = event.target;

  const gateTab = t.closest('[data-gate-tab]');
  if (gateTab) {
    $$('[data-gate-tab]').forEach((b) => b.classList.toggle('is-active', b === gateTab));
    $$('[data-gate-panel]').forEach((p) => p.classList.toggle('is-hidden', p.dataset.gatePanel !== gateTab.dataset.gateTab));
    return;
  }

  const nav = t.closest('.rail-btn');
  if (nav) {
    S.view = nav.dataset.view;
    render();
    if (S.view === 'activity') loadStatement();
    return;
  }

  if (t.closest('#signout')) {
    await api('/session', { method: 'DELETE' }).catch(() => {});
    localStorage.removeItem('vvb.token');
    S.token = null;
    S.me = null;
    location.reload();
    return;
  }

  const account = t.closest('[data-account]');
  if (account) { S.accountId = account.dataset.account; render(); return; }

  const quick = t.closest('[data-quick]');
  if (quick) {
    const acc = activeAccount();
    await run(() => api(`/accounts/${acc.id}/instant-funds`, {
      method: 'POST',
      body: { amount: Number(quick.dataset.quick), source: 'demo' },
    }), `⚡ ${fmt(Number(quick.dataset.quick) * 100, acc.currency)} landed instantly`);
    return;
  }

  const open = t.closest('[data-open]');
  if (open?.dataset.open === 'account') {
    const currency = prompt('Currency for the new account (RUB, USD, EUR, CNY, MNT, KZT):', 'USD');
    if (currency) await run(() => api('/accounts', { method: 'POST', body: { currency: currency.toUpperCase() } }), 'Account opened');
    return;
  }
  if (open?.dataset.open === 'card') {
    const acc = activeAccount();
    await run(() => api('/cards', { method: 'POST', body: { accountId: acc.id, label: 'VaivaiBank virtual' } }), 'Card issued');
    return;
  }

  const status = t.closest('[data-card-status]');
  if (status) {
    await run(() => api(`/cards/${status.dataset.cardStatus}/status`, { method: 'POST', body: { status: status.dataset.next } }),
      status.dataset.next === 'frozen' ? 'Card frozen' : 'Card unfrozen');
    return;
  }

  const reveal = t.closest('[data-card-reveal]');
  if (reveal) {
    const pin = S.me.customer.hasPin ? prompt('Enter your PIN to reveal card details:') : '';
    try {
      const card = await api(`/cards/${reveal.dataset.cardReveal}/reveal`, { method: 'POST', body: { pin } });
      const pan = $(`[data-pan="${card.id}"]`);
      if (pan) {
        pan.textContent = card.pan;
        setTimeout(() => { const el = $(`[data-pan="${card.id}"]`); if (el) el.textContent = card.pan.replace(/\d(?=\d{4})/g, '•'); }, 12000);
      }
      toast(`CVV ${card.cvv} · exp ${card.expiry}`, 'Hidden again in 12 seconds', 'good');
    } catch (err) { toast('Cannot show details', err.message, 'bad'); }
    return;
  }

  const cancel = t.closest('[data-cancel-schedule]');
  if (cancel) {
    await run(() => api(`/schedules/${cancel.dataset.cancelSchedule}`, { method: 'DELETE' }), 'Standing order cancelled');
    return;
  }

  const action = t.closest('[data-action]')?.dataset.action;
  if (action === 'accrue') {
    const res = await run(() => api('/vaults/accrue', { method: 'POST' }));
    if (res) toast(res.paid.length ? `Interest paid on ${res.paid.length} vault(s)` : 'No whole day has passed yet', '', 'good');
    return;
  }
  if (action === 'accrue-credit') {
    const res = await run(() => api('/credit/accrue', { method: 'POST' }));
    if (res) toast(res.charged.length ? 'Interest charged' : 'Nothing due yet', '', 'good');
    return;
  }
  if (action === 'health') {
    const health = await api('/health');
    const a = health.audit;
    $('#audit-panel').innerHTML = `
      <div class="split"><span>${a.ok ? '<span class="pill good">balanced</span>' : '<span class="pill bad">drift found</span>'}</span>
      <span class="muted">${a.accounts} accounts · ${a.transactions} transactions</span></div>
      <table class="data" style="margin-top:12px">
        <tbody>
          <tr><td>Customers</td><td class="num">${health.customers}</td></tr>
          <tr><td>Cards issued</td><td class="num">${health.cards}</td></tr>
          <tr><td>Vaults</td><td class="num">${health.vaults}</td></tr>
          <tr><td>Unbalanced currencies</td><td class="num">${a.unbalanced.length}</td></tr>
          <tr><td>Balance drift</td><td class="num">${a.drift.length}</td></tr>
        </tbody>
      </table>`;
    toast(a.ok ? 'Ledger balances' : 'Ledger drift detected', `${a.transactions} transactions re-derived`, a.ok ? 'good' : 'bad');
  }
});

document.addEventListener('change', (event) => {
  const select = event.target.closest('[data-select="account"]');
  if (select) { S.accountId = select.value; loadStatement(); }
});

document.addEventListener('submit', async (event) => {
  const form = event.target;
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form).entries());
  const kind = form.dataset.form || form.id;

  const handlers = {
    async 'join-form'() {
      const res = await api('/customers', { method: 'POST', body: data });
      S.token = res.session.token;
      localStorage.setItem('vvb.token', S.token);
      S.me = await api('/me');
      enterApp();
      toast(`Welcome, ${res.customer.name}`, `Account ${res.account.number}`, 'good');
    },
    async 'signin-form'() {
      const res = await api('/session', { method: 'POST', body: data });
      S.token = res.session.token;
      localStorage.setItem('vvb.token', S.token);
      S.me = await api('/me');
      enterApp();
      toast(`Сайн байна, ${res.customer.name}`, '', 'good');
    },
    async instant() {
      const acc = activeAccount();
      const res = await api(`/accounts/${acc.id}/instant-funds`, {
        method: 'POST',
        body: { amount: Number(data.amount), source: data.source },
      });
      form.reset();
      await refresh();
      const left = res.allowance.remaining == null ? 'unlimited today' : `${fmt(res.allowance.remaining, 'RUB')} left today`;
      toast('⚡ Instant funds added', `New balance ${fmt(res.balance, res.currency)} · ${left}`, 'good');
    },
    async transfer() {
      const res = await api('/transfers', { method: 'POST', body: { ...data, amount: Number(data.amount) } });
      form.reset();
      await refresh();
      toast('Sent', `${res.transaction.description}`, 'good');
    },
    async exchange() {
      const res = await api('/exchange', { method: 'POST', body: { ...data, amount: Number(data.amount) } });
      form.reset();
      await refresh();
      toast('Exchanged', `${fmt(res.quote.sent, res.quote.from)} → ${fmt(res.quote.received, res.quote.to)} (fee ${fmt(res.quote.fee, res.quote.to)})`, 'good');
    },
    async request() {
      const res = await api('/requests', { method: 'POST', body: { ...data, amount: Number(data.amount) } });
      await refresh();
      toast(`Pay code ${res.code}`, 'Share it — anyone at the branch can settle it', 'good');
    },
    async 'pay-code'() {
      const res = await api(`/requests/${encodeURIComponent(data.code)}/pay`, { method: 'POST', body: {} });
      form.reset();
      await refresh();
      toast('Request paid', `${res.request.code} · ${fmt(res.request.amount, res.request.currency)}`, 'good');
    },
    async split() {
      const res = await api('/split', { method: 'POST', body: { ...data, amount: Number(data.amount), ways: Number(data.ways) } });
      await refresh();
      toast(`Split ${fmt(res.total, res.currency)} ${Number(data.ways)} ways`, `Your share ${fmt(res.yourShare, res.currency)} · codes: ${res.requests.map((r) => r.code).join(', ')}`, 'good');
    },
    async 'card-limits'() {
      await api(`/cards/${form.dataset.card}`, {
        method: 'PATCH',
        body: {
          perTransactionLimit: Number(data.perTransactionLimit),
          dailyLimit: Number(data.dailyLimit),
          roundUpVaultId: data.roundUpVaultId || null,
        },
      });
      await refresh();
      toast('Card settings saved', '', 'good');
    },
    async 'card-payment'() {
      const res = await api(`/cards/${form.dataset.card}/payment`, {
        method: 'POST',
        body: { merchant: data.merchant, amount: Number(data.amount), category: data.category },
      });
      await refresh();
      const extras = [
        res.cashback ? `cashback ${fmt(res.cashback, res.currency)}` : null,
        res.roundUp ? `round-up ${fmt(res.roundUp, res.currency)}` : null,
        res.pointsEarned ? `+${res.pointsEarned} pts` : null,
      ].filter(Boolean).join(' · ');
      toast(`Paid ${esc(data.merchant)}`, extras || `Balance ${fmt(res.balance, res.currency)}`, 'good');
    },
    async vault() {
      await api('/vaults', {
        method: 'POST',
        body: {
          name: data.name,
          currency: data.currency,
          goal: data.goal ? Number(data.goal) : null,
          apyBps: Math.round(Number(data.apy) * 100),
        },
      });
      await refresh();
      toast('Vault opened', '', 'good');
    },
    async 'vault-move'() {
      await api(`/vaults/${form.dataset.vault}/move`, {
        method: 'POST',
        body: { amount: Number(data.amount), direction: data.direction, accountId: data.accountId || null },
      });
      form.reset();
      await refresh();
      toast('Vault updated', '', 'good');
    },
    async credit() {
      await api('/credit', { method: 'POST', body: { limit: Number(data.limit), aprBps: Math.round(Number(data.apr) * 100) } });
      await refresh();
      toast('Credit line open', '', 'good');
    },
    async 'credit-draw'() {
      await api(`/credit/${form.dataset.credit}/draw`, { method: 'POST', body: { amount: Number(data.amount) } });
      form.reset();
      await refresh();
      toast('Drawn', '', 'good');
    },
    async 'credit-repay'() {
      await api(`/credit/${form.dataset.credit}/repay`, { method: 'POST', body: { amount: Number(data.amount) } });
      form.reset();
      await refresh();
      toast('Repaid', '', 'good');
    },
    async schedule() {
      await api('/schedules', {
        method: 'POST',
        body: { ...data, amount: Number(data.amount), everyDays: Number(data.everyDays) },
      });
      await refresh();
      toast('Standing order created', '', 'good');
    },
  };

  const handler = handlers[kind];
  if (!handler) return;
  const submit = form.querySelector('button[type="submit"], button:not([type])');
  if (submit) submit.disabled = true;
  try {
    await handler();
    if (S.view === 'activity') loadStatement();
  } catch (err) {
    if (form.closest('#gate')) $('#gate-error').textContent = err.message;
    else toast('Declined', err.message, 'bad');
  } finally {
    if (submit) submit.disabled = false;
  }
});

boot().catch((err) => {
  document.body.innerHTML = `<p style="padding:40px;color:#e66767">The branch is closed: ${esc(err.message)}</p>`;
});
