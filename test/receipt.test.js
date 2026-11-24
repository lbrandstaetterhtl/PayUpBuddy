import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReceipt } from '../src/receipt.js';
import { parseCents } from '../src/money.js';

test('parseCents handles German and English formats', () => {
  assert.equal(parseCents('12,50'), 1250);
  assert.equal(parseCents('12.50'), 1250);
  assert.equal(parseCents('1.234,56'), 123456);
  assert.equal(parseCents('1,234.56'), 123456);
  assert.equal(parseCents('7'), 700);
  assert.equal(parseCents('7,5'), 750);
  assert.equal(parseCents('-0,25'), -25);
  assert.equal(parseCents('9,99 €'), 999);
  assert.equal(parseCents('abc'), null);
  assert.equal(parseCents(''), null);
});

test('supermarket receipt: items, quantity rows, tax table and total', () => {
  const text = `REWE Markt GmbH
Musterstr. 1, 12345 Musterstadt
UID Nr.: DE812706034
EUR
MILCH 3,5%            1,29 B
BANANE                1,78 B
  2 Stk x   0,89
SPÜLMITTEL            2,49 A
PFAND                 0,25 A
PFANDRÜCKGABE        -0,25 A
--------------------------------
SUMME            EUR  5,56
Geg. EC-Cash     EUR  5,56
Steuer  %   Netto  Steuer  Brutto
A= 19,0%    2,09    0,40    2,49
B=  7,0%    2,87    0,20    3,07
24.11.2026  10:15  Bon-Nr.: 4711`;
  const { items, totalCents } = parseReceipt(text);
  assert.equal(totalCents, 556);
  assert.deepEqual(items, [
    { label: 'MILCH 3,5%', cents: 129 },
    { label: 'BANANE', cents: 178 },
    { label: 'SPÜLMITTEL', cents: 249 },
    { label: 'PFAND', cents: 25 },
    { label: 'PFANDRÜCKGABE', cents: -25 },
  ]);
});

test('restaurant receipt with quantities in the label', () => {
  const text = `Pizzeria Da Mario
1 Pizza Margherita      9,50
2 x Cola 0,3            7,00
1 Tiramisu              5,90 €
Zwischensumme          22,40
Gesamt                 22,40
MwSt 19%                3,58
Trinkgeld               2,00`;
  const { items, totalCents } = parseReceipt(text);
  assert.equal(totalCents, 2240);
  assert.deepEqual(items.map((i) => i.cents), [950, 700, 590, 200]); // tip counts, VAT doesn't
  assert.equal(items[1].label, '2 x Cola 0,3');
});

test('OCR noise: spaced decimals and stray symbols', () => {
  const { items, totalCents } = parseReceipt('Brot | 2 ,49 B\nKäse _ 3, 99\nTOTAL 6,48');
  assert.deepEqual(items, [{ label: 'Brot', cents: 249 }, { label: 'Käse', cents: 399 }]);
  assert.equal(totalCents, 648);
});

test('empty input', () => {
  assert.deepEqual(parseReceipt(''), { items: [], totalCents: null });
});

test('delivery app screenshot: currency before amount, fees and tip count', () => {
  const text = `[1x]   =   Double Patty Melt          €12.00
®      Fritten
o                   es.s0
[1x]   Chili Cheese Fritten        €8.00
— Small
(1X)   Double Hot Smash Burger     €15.00
Subtotal                           €40.50
Delivery costs                     €2.99
Tip                                €1.00
Servicefee @                       €0.69
Rabatt                            -€2.00
Total (incl. VAT)                  €45.18`;
  const { items, totalCents } = parseReceipt(text);
  assert.equal(totalCents, 4518);
  assert.deepEqual(items, [
    { label: 'Double Patty Melt', cents: 1200 },
    { label: 'Chili Cheese Fritten', cents: 800 },
    { label: 'Double Hot Smash Burger', cents: 1500 },
    { label: 'Delivery costs', cents: 299 },
    { label: 'Tip', cents: 100 },
    { label: 'Servicefee', cents: 69 },
    { label: 'Rabatt', cents: -200 },
  ]);
});

test('a dash between label and amount is not a minus sign', () => {
  assert.deepEqual(parseReceipt('Brot - 2,49').items, [{ label: 'Brot', cents: 249 }]);
});
