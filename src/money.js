'use strict';

/**
 * All money in VaivaiBank is stored as integer minor units (kopecks, cents,
 * mongo, ...). Floats never touch a balance. Conversions in and out of major
 * units happen only at the edges: HTTP input and display.
 */

const CURRENCIES = {
  RUB: { code: 'RUB', symbol: '₽', digits: 2, name: 'Russian ruble' },
  USD: { code: 'USD', symbol: '$', digits: 2, name: 'US dollar' },
  EUR: { code: 'EUR', symbol: '€', digits: 2, name: 'Euro' },
  CNY: { code: 'CNY', symbol: '¥', digits: 2, name: 'Chinese yuan' },
  MNT: { code: 'MNT', symbol: '₮', digits: 2, name: 'Mongolian tugrik' },
  KZT: { code: 'KZT', symbol: '₸', digits: 2, name: 'Kazakhstani tenge' },
};

const DEFAULT_CURRENCY = 'RUB';

class MoneyError extends Error {
  constructor(message, code = 'money_error') {
    super(message);
    this.name = 'MoneyError';
    this.code = code;
    this.status = 400;
  }
}

function currency(code) {
  const cur = CURRENCIES[String(code || '').toUpperCase()];
  if (!cur) throw new MoneyError(`Unsupported currency: ${code}`, 'unsupported_currency');
  return cur;
}

function isCurrency(code) {
  return Object.prototype.hasOwnProperty.call(CURRENCIES, String(code || '').toUpperCase());
}

function scale(code) {
  return 10 ** currency(code).digits;
}

/** Major units (12.34) -> minor units (1234). */
function toMinor(major, code = DEFAULT_CURRENCY) {
  const value = typeof major === 'string' ? Number(major.replace(/\s|,/g, '')) : Number(major);
  if (!Number.isFinite(value)) throw new MoneyError('Amount is not a number', 'invalid_amount');
  const minor = Math.round(value * scale(code));
  if (!Number.isSafeInteger(minor)) throw new MoneyError('Amount is out of range', 'invalid_amount');
  return minor;
}

/** Minor units (1234) -> major units (12.34). Display only. */
function toMajor(minor, code = DEFAULT_CURRENCY) {
  return assertMinor(minor) / scale(code);
}

function assertMinor(minor) {
  if (!Number.isSafeInteger(minor)) {
    throw new MoneyError('Amount must be a whole number of minor units', 'invalid_amount');
  }
  return minor;
}

/** Validates a user-supplied transfer/top-up amount: positive, integral, sane. */
function assertPositive(minor, label = 'Amount') {
  assertMinor(minor);
  if (minor <= 0) throw new MoneyError(`${label} must be greater than zero`, 'invalid_amount');
  return minor;
}

function format(minor, code = DEFAULT_CURRENCY, { withSymbol = true, sign = false } = {}) {
  const cur = currency(code);
  const negative = minor < 0;
  const abs = Math.abs(assertMinor(minor));
  const whole = Math.trunc(abs / scale(code));
  const frac = String(abs % scale(code)).padStart(cur.digits, '0');
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const body = cur.digits > 0 ? `${grouped},${frac}` : grouped;
  const prefix = negative ? '−' : sign ? '+' : '';
  return withSymbol ? `${prefix}${body} ${cur.symbol}` : `${prefix}${body}`;
}

/**
 * Splits an amount into n parts that sum exactly back to the original.
 * Remainder kopecks are handed out one at a time to the earliest parts, so
 * 100 / 3 becomes [34, 33, 33] and never loses a kopeck.
 */
function split(minor, parts) {
  assertMinor(minor);
  if (!Number.isInteger(parts) || parts < 1) throw new MoneyError('Split needs at least one part', 'invalid_split');
  const base = Math.trunc(minor / parts);
  let remainder = minor - base * parts;
  const step = remainder < 0 ? -1 : 1;
  return Array.from({ length: parts }, () => {
    if (remainder !== 0) {
      remainder -= step;
      return base + step;
    }
    return base;
  });
}

/** Percentage of an amount in basis points (1 bp = 0.01%), rounded half-up. */
function basisPoints(minor, bps) {
  assertMinor(minor);
  if (!Number.isFinite(bps)) throw new MoneyError('Basis points must be numeric', 'invalid_rate');
  return Math.round((minor * bps) / 10000);
}

module.exports = {
  CURRENCIES,
  DEFAULT_CURRENCY,
  MoneyError,
  currency,
  isCurrency,
  toMinor,
  toMajor,
  assertMinor,
  assertPositive,
  format,
  split,
  basisPoints,
};
