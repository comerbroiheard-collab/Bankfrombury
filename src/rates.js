'use strict';

const { currency, basisPoints, assertPositive, MoneyError } = require('./money');

/**
 * Indicative FX board, quoted against the ruble. These are demo figures for a
 * demo bank -- swap `setRate` in from a real feed and nothing else changes.
 */
const BASE = 'RUB';

const DEFAULT_RATES = {
  RUB: 1,
  USD: 0.0109,
  EUR: 0.0101,
  CNY: 0.0782,
  MNT: 38.4,
  KZT: 5.71,
};

/** The house takes 40 bp on each conversion leg. */
const SPREAD_BPS = 40;

class RateBoard {
  constructor(rates = DEFAULT_RATES, spreadBps = SPREAD_BPS) {
    this.rates = { ...rates };
    this.spreadBps = spreadBps;
    this.updatedAt = new Date().toISOString();
  }

  setRate(code, perRuble) {
    currency(code);
    if (!Number.isFinite(perRuble) || perRuble <= 0) {
      throw new MoneyError('Rate must be a positive number', 'invalid_rate');
    }
    this.rates[code.toUpperCase()] = perRuble;
    this.updatedAt = new Date().toISOString();
    return this.rates[code.toUpperCase()];
  }

  rate(code) {
    const cur = currency(code).code;
    const value = this.rates[cur];
    if (!value) throw new MoneyError(`No rate published for ${cur}`, 'no_rate');
    return value;
  }

  /** Mid-market price of one unit of `from` expressed in `to`. */
  cross(from, to) {
    return this.rate(to) / this.rate(from);
  }

  /**
   * Converts an amount, returning the credited amount plus the fee the house
   * kept. Minor-unit scales differ per currency, so both are normalised
   * through the base before rounding once at the end.
   */
  quote(amountMinor, from, to) {
    assertPositive(amountMinor, 'Exchange amount');
    const fromCur = currency(from);
    const toCur = currency(to);
    if (fromCur.code === toCur.code) {
      return { from: fromCur.code, to: toCur.code, sent: amountMinor, gross: amountMinor, fee: 0, received: amountMinor, rate: 1, spreadBps: 0 };
    }
    const fromScale = 10 ** fromCur.digits;
    const toScale = 10 ** toCur.digits;
    const rate = this.cross(fromCur.code, toCur.code);
    const gross = Math.round((amountMinor / fromScale) * rate * toScale);
    const fee = basisPoints(gross, this.spreadBps);
    const received = gross - fee;
    if (received <= 0) throw new MoneyError('Amount is too small to exchange', 'amount_too_small');
    return { from: fromCur.code, to: toCur.code, sent: amountMinor, gross, fee, received, rate, spreadBps: this.spreadBps };
  }

  board() {
    return {
      base: BASE,
      updatedAt: this.updatedAt,
      spreadBps: this.spreadBps,
      rates: Object.entries(this.rates).map(([code, perRuble]) => ({
        code,
        perRuble,
        rublesPerUnit: 1 / perRuble,
      })),
    };
  }
}

module.exports = { RateBoard, DEFAULT_RATES, BASE, SPREAD_BPS };
