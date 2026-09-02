'use strict';

const crypto = require('node:crypto');

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32: no I, L, O, U

/** Sortable-ish unique id: <prefix>_<time><random>. */
function id(prefix) {
  const time = Date.now().toString(32).toUpperCase().padStart(9, '0');
  const rand = Array.from(crypto.randomBytes(8), (b) => ALPHABET[b % ALPHABET.length]).join('');
  return `${prefix}_${time}${rand}`;
}

function randomDigits(n) {
  let out = '';
  const bytes = crypto.randomBytes(n);
  for (let i = 0; i < n; i += 1) out += String(bytes[i] % 10);
  return out;
}

/**
 * VaivaiBank account number, printed in the local format:
 *   VVB BU 0301 <10 digits> <check>
 * "BU" for Buryatia, 03 for the republic's bank code, 01 for the branch.
 */
function accountNumber() {
  const body = `03010${randomDigits(9)}`;
  return `VVBBU${body}${checkDigit(body)}`;
}

function prettyAccount(number) {
  const rest = String(number).slice(5);
  return `VVB BU ${rest.replace(/(.{4})/g, '$1 ').trim()}`;
}

/** Weighted mod-97 check digit, printed as a single base-32 character. */
function checkDigit(body) {
  let acc = 0;
  for (const ch of String(body)) acc = (acc * 10 + (Number(ch) || 0)) % 97;
  return ALPHABET[acc % ALPHABET.length];
}

function accountNumberIsValid(number) {
  const s = String(number || '');
  if (!/^VVBBU\d{14}[0-9A-Z]$/.test(s)) return false;
  return checkDigit(s.slice(5, 19)) === s[19];
}

/** Luhn check digit for card PANs. */
function luhnDigit(partial) {
  const digits = String(partial).split('').reverse().map(Number);
  let sum = 0;
  digits.forEach((d, i) => {
    if (i % 2 === 0) {
      const doubled = d * 2;
      sum += doubled > 9 ? doubled - 9 : doubled;
    } else {
      sum += d;
    }
  });
  return (10 - (sum % 10)) % 10;
}

function luhnIsValid(pan) {
  const s = String(pan).replace(/\s/g, '');
  if (!/^\d{12,19}$/.test(s)) return false;
  return luhnDigit(s.slice(0, -1)) === Number(s[s.length - 1]);
}

/** 9903 is VaivaiBank's (fictional) issuer prefix. */
function cardNumber(prefix = '9903') {
  const partial = prefix + randomDigits(15 - prefix.length);
  return partial + luhnDigit(partial);
}

function maskCard(pan) {
  const s = String(pan);
  return `${s.slice(0, 4)} •••• •••• ${s.slice(-4)}`;
}

function cvv() {
  return randomDigits(3);
}

/** Short human-shareable code for payment requests, e.g. "VVB-7K2Q-4M". */
function payCode() {
  const chunk = (n) => Array.from(crypto.randomBytes(n), (b) => ALPHABET[b % ALPHABET.length]).join('');
  return `VVB-${chunk(4)}-${chunk(2)}`;
}

function token() {
  return crypto.randomBytes(24).toString('base64url');
}

function hashPin(pin, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  return { salt, hash };
}

function verifyPin(pin, record) {
  if (!record || !record.salt || !record.hash) return false;
  const candidate = Buffer.from(crypto.scryptSync(String(pin), record.salt, 32).toString('hex'));
  const known = Buffer.from(record.hash);
  return candidate.length === known.length && crypto.timingSafeEqual(candidate, known);
}

module.exports = {
  id,
  accountNumber,
  prettyAccount,
  accountNumberIsValid,
  cardNumber,
  maskCard,
  cvv,
  luhnDigit,
  luhnIsValid,
  payCode,
  token,
  hashPin,
  verifyPin,
};
