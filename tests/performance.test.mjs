import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePlayCsv, sumWindow } from '../scripts/performance.mjs';

const csv = 'Date,Package Name,Daily User Installs,Daily User Uninstalls\n2026-10-01,p,3,1\n2026-10-02,p,2,4\n2026-11-01,p,9,9\n';
test('parses UTF-16 Play CSV and sums a window', () => {
  const rows = parsePlayCsv(Buffer.from('﻿' + csv, 'utf16le'));
  assert.deepEqual(sumWindow(rows, '2026-10-01', '2026-10-31'), { installs: 5, uninstalls: 5 });
  assert.equal(sumWindow(rows, '2026-09-01', '2026-09-30'), null);
});
test('rejects unexpected columns', () => assert.throws(() => parsePlayCsv('a,b\n1,2')));
test('handles quoted commas and padded headers', () => {
  const rows = parsePlayCsv('Date , Package Name,Daily User Installs,Daily User Uninstalls\r\n2026-10-01,"a,b",3,1\r\n');
  assert.deepEqual(rows, [{ date: '2026-10-01', installs: 3, uninstalls: 1 }]);
});
