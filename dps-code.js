// DPS Code = DCS_Code & "/" & Price Adjusted & "/" & Size Adjusted
// Transcribed 2026-11-15 from the DAX formulas in Wesley's Power BI "Items" table (he pasted them
// in chat). This is the SINGLE definition of the formula for this project - docs/business-rules.md
// ("DPS Code") points here. If the DAX changes, update this file and that section together.
//
// DAX differences carried over on purpose:
//  - Price thresholds are strict ">" exactly as written (so a price of exactly 101 falls in "91-101",
//    exactly 150 in "101-150"; the 101 threshold is not 100 - keep it).
//  - DAX string "=" is case-insensitive, so sizes are compared upper-cased. Whitespace is trimmed
//    (SAP/Excel values can carry trailing spaces; the DAX source data didn't).
//  - ISBLANK(Size) is treated as null / empty / whitespace-only.
//  - Size is only normalized for clothing (DCS_Code starts with "CL"); everything else is "No".
//    A clothing size that isn't in any list below passes through unchanged (the DAX's final else).

// Price Adjusted: [threshold, label], checked top to bottom; first threshold the price exceeds wins.
const PRICE_BUCKETS = [
  [500, '>=500'], [400, '400-500'], [350, '350-400'], [300, '300-350'], [250, '250-300'],
  [200, '200-250'], [150, '150-200'], [101, '101-150'], [91, '91-101'], [81, '81-91'],
  [76, '76-81'], [71, '71-76'], [66, '66-71'], [61, '61-66'], [56, '56-61'],
  [51, '51-56'], [46, '46-51'], [41, '41-46'], [36, '36-41'], [31, '31-36'],
  [26, '26-31'], [21, '21-26'], [17, '17-21'], [13, '13-17'], [10, '10-13'],
  [7, '7-10'], [5, '5-7'], [3, '3-5'], [1, '1-3'],
];
const PRICE_FLOOR = '0-1';

// Size Adjusted (clothing only): first list containing the size wins.
const SIZE_GROUPS = [
  ['XS', ['XS', 'XSM']],
  ['S', ['S', 'SM', 'XS/S']],
  ['M', ['M', 'MD', '25', '26', '27', '28', '29', '30', '31', 'REG', 'S/M/L', 'S/M', 'M/L']],
  ['L', ['L', 'LG', '32', '33', '34', '35', '36', '37', '38', '39', '40', '41', '42', '70 IN', 'L/XL']],
  ['XL', ['XL', 'XLG']],
  ['2X', ['XXL', '2XL', '2X', 'XL/XXL', '2XL/XXL', 'XL/2X']],
  ['3X', ['3X', '3XL']],
  ['4X', ['4X', '4XL']],
  ['No', ['O/S', 'OS', '(BLANK)']],
];

function priceAdjusted(salePrice) {
  const p = Number(salePrice);
  for (const [threshold, label] of PRICE_BUCKETS) if (p > threshold) return label;
  return PRICE_FLOOR;
}

function sizeAdjusted(dcsCode, size) {
  if (String(dcsCode || '').slice(0, 2).toUpperCase() !== 'CL') return 'No';
  const raw = size === null || size === undefined ? '' : String(size).trim();
  if (raw === '') return 'No';
  const s = raw.toUpperCase();
  for (const [label, sizes] of SIZE_GROUPS) if (sizes.includes(s)) return label;
  return raw; // DAX final else: unmapped size passes through as-is
}

function dpsCode(dcsCode, salePrice, size) {
  const dcs = String(dcsCode || '').trim();
  return `${dcs}/${priceAdjusted(salePrice)}/${sizeAdjusted(dcs, size)}`;
}

module.exports = { dpsCode, priceAdjusted, sizeAdjusted };
