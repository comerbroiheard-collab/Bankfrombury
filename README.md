# VaivaiBank Buryatia · Ваивай Банк Буряад

> Сагай ошохо, мүнгэнэй ерэхэ — *time passes, money arrives.*

A complete, working retail bank for the Republic of Buryatia: **instant funds**,
six currencies, virtual cards, Baikal savings vaults, a credit line, standing
orders, payment codes and split bills — all on a **double-entry ledger that can
prove its own balances**.

Zero runtime dependencies. Node 20+ and nothing else.

```bash
npm run demo     # seed a week of branch activity, then open the branch
# → http://127.0.0.1:4173     sign in as @bair, PIN 1957
```

---

## What it does

### ⚡ Instant funds — the headline
Money lands the moment the call returns. No pending state, no overnight batch.

```bash
curl -X POST localhost:4173/api/accounts/<id>/instant-funds \
  -H "authorization: Bearer <token>" -H "content-type: application/json" \
  -d '{"amount": 5000, "source": "sbp", "idempotencyKey": "abc-123"}'
```

Guarded by two things that matter:

- **A rolling 24-hour ceiling** set by your loyalty tier (₽50 000 at Omul, up to
  unlimited at Baikal). Deliberately, topping yourself up earns **no** tier
  points — otherwise the limit would lift itself.
- **Idempotency keys.** Retry the same key and you get the original transaction
  back, `replayed: true`, credited exactly once.

### …and much, much more

| | |
|---|---|
| **Multi-currency** | RUB, USD, EUR, CNY, MNT, KZT. Cross-currency sends route through an FX desk so every currency's books still sum to zero. |
| **Cards** | Luhn-valid PANs, freeze/unfreeze, per-payment and daily limits, online toggle, PIN-gated detail reveal, and a purchase simulator. |
| **Cashback & points** | 0.5%–2% by tier, capped per purchase, paid out of the treasury as its own ledger entry. |
| **Round-up saving** | Pay ₽487,60 and the ₽0,40 sweeps into your vault automatically. |
| **Baikal vaults** | Named goals with progress, daily-accrued interest, a tier bonus on the headline rate. |
| **Credit line** | Draw, repay, daily interest on the drawn balance only, hard limit enforcement. |
| **Standing orders** | Repeat every N days, catch up missed cycles, pause themselves on insufficient funds. |
| **Payment codes** | `VVB-7K2Q-4M` — shareable, expiring, settle-once payment requests. |
| **Split bills** | Splits to the kopeck: ₽100 three ways is 34/33/33, never 33.33 × 3. |
| **Analytics** | Spending by category — moves between your *own* accounts are excluded, because that isn't spending. |
| **Auditability** | `/api/audit` re-derives every balance from the transaction log and reports any drift. |

---

## Architecture

```
src/money.js    integer minor units, formatting, exact splitting, basis points
src/ids.js      account numbers (mod-97 check), Luhn PANs, pay codes, scrypt PINs
src/ledger.js   double-entry core: accounts, postings, invariants, audit
src/bank.js     products: customers, instant funds, cards, vaults, credit, schedules
src/rates.js    FX board + spread
src/store.js    durable JSON store (atomic temp-file + rename)
src/http.js     router, body reader, static server, rate limiter
src/api.js      HTTP routes and session handling
src/server.js   wiring and lifecycle
public/         the app — vanilla JS, no build step
bin/vvb.js      teller CLI      bin/seed.js  demo data
```

**Money is never a float.** Every balance is an integer count of minor units
(kopecks, cents, mongo). Floats appear only at the display edge.

**Every movement is double-entry.** A transaction is a list of entries that must
sum to zero *within each currency*; the ledger checks status and funds for every
account before a single balance moves, so a rejected transaction moves nothing.
Cached balances are a projection of the log, and `Ledger.audit()` re-derives them
to prove the projection still matches:

```bash
npm run audit:ledger
node bin/vvb.js audit     # ✓ ledger balances · 13 accounts · 73 transactions
```

The bank's own books are ordinary accounts too — `external` (the outside world),
`treasury` (interest, cashback, credit funding) and `fees` (spread and interest
income) — which is why cash can enter and leave the customer side without any
currency's total drifting from zero.

---

## The API

Public: `GET /api/health` · `/api/meta` · `/api/rates` · `/api/directory` ·
`/api/requests/:code` · `POST /api/customers` · `POST /api/session`

Bearer-token routes:

| Method | Path | |
|---|---|---|
| `GET` | `/api/me` | everything the home screen needs, in one call |
| `POST` | `/api/accounts/:id/instant-funds` | ⚡ |
| `GET` | `/api/instant-funds/allowance` | what's left in the rolling window |
| `POST` | `/api/transfers` · `/api/exchange` | to an `@handle`, an id, or a printed number |
| `POST` | `/api/cards` · `/api/cards/:id/payment` · `/api/cards/:id/reveal` | |
| `PATCH` | `/api/cards/:id` | limits, toggles, round-up target |
| `POST` | `/api/vaults` · `/api/vaults/:id/move` · `/api/vaults/accrue` | |
| `POST` | `/api/credit` · `/api/credit/:id/draw` · `/api/credit/:id/repay` | |
| `POST` | `/api/requests` · `/api/requests/:code/pay` · `/api/split` | |
| `POST` | `/api/schedules` · `/api/scheduler/run` | |
| `GET` | `/api/accounts/:id/statement` · `/api/me/spending` · `/api/audit` | |

Amounts accept major units (`"amount": 1500.50`) or exact minor units
(`"amountMinor": 150050`). Errors come back as
`{ "error": "instant_limit", "message": "…" }` with a real status code.

---

## CLI

```bash
node bin/vvb.js open "Bair Dorzhiev" bair 1957
node bin/vvb.js topup @bair 25000 sbp
node bin/vvb.js send @bair @sesegma 3500 "Omul money"
node bin/vvb.js card @bair "Baikal Market" 1450 groceries
node bin/vvb.js balance          # every customer
node bin/vvb.js audit
```

## Tests

```bash
npm test     # 43 tests, no dependencies
```

They cover the parts that would actually hurt: exact splitting, rejected
transactions moving nothing, the rolling instant-funds ceiling, idempotent
retries, per-currency balance after an exchange, interest that never pays twice
for the same day, standing orders catching up and pausing, ownership checks
across customers, and a busy branch still balancing after thirty days.

## Configuration

| Variable | Default |
|---|---|
| `PORT` | `4173` |
| `HOST` | `127.0.0.1` |
| `VVB_DATA` | `./data/bank.json` (set empty for memory-only) |

## Notes

VaivaiBank Buryatia is a demonstration bank. The FX board carries indicative
figures, "instant funds" mints demo money from the outside-world book, and PINs
are the only credential — it is a faithful *model* of a bank, not a licensed one.
