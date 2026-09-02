'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const money = require('../src/money');

test('major units convert to minor units without float drift', () => {
  assert.equal(money.toMinor(0.1, 'RUB') + money.toMinor(0.2, 'RUB'), money.toMinor(0.3, 'RUB'));
  assert.equal(money.toMinor('1 234,50'.replace(',', '.'), 'RUB'), 123450);
  assert.equal(money.toMajor(123450, 'RUB'), 1234.5);
});

test('formatting groups thousands and keeps the minor part', () => {
  assert.equal(money.format(123456789, 'RUB'), '1 234 567,89 ₽');
  assert.equal(money.format(-5000, 'USD'), '−50,00 $');
  assert.equal(money.format(5000, 'USD', { sign: true }), '+50,00 $');
});

test('splitting never loses or invents a kopeck', () => {
  for (const [total, ways] of [[100, 3], [1, 7], [999999, 11], [10, 4]]) {
    const parts = money.split(total, ways);
    assert.equal(parts.length, ways);
    assert.equal(parts.reduce((a, b) => a + b, 0), total, `${total} split ${ways} ways`);
    assert.ok(Math.max(...parts) - Math.min(...parts) <= 1, 'parts differ by at most one minor unit');
  }
});

test('bad amounts are refused', () => {
  assert.throws(() => money.toMinor('nonsense'), /not a number/);
  assert.throws(() => money.assertPositive(0), /greater than zero/);
  assert.throws(() => money.assertPositive(-5), /greater than zero/);
  assert.throws(() => money.assertMinor(1.5), /whole number/);
  assert.throws(() => money.currency('XYZ'), /Unsupported currency/);
});

test('basis points round to the nearest minor unit', () => {
  assert.equal(money.basisPoints(100000, 750), 7500);
  assert.equal(money.basisPoints(101, 40), 0);
  assert.equal(money.basisPoints(1000, 55), 6);
});
