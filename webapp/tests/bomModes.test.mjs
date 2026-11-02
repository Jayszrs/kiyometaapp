import assert from 'node:assert/strict';
import { test } from 'node:test';
import { moduleUrl } from './loadRecoveryModule.mjs';

const { buildBomTree, summarizeBom } = await import(moduleUrl('bom.ts'));

const row = (id, productId, inventoryItemId, quantityPerUnit, componentProductId = '', parentBomNo = '') => ({
  id, bomNo: id, productId, inventoryItemId, componentProductId, parentBomNo, quantityPerUnit, notes: '',
});

test('component structure expands a separately produced subassembly BOM', () => {
  const rows = [
    row('BOM-1', 'finished', 'subassembly-stock', 2, 'subassembly'),
    row('BOM-2', 'finished', 'bolt', 4),
    row('BOM-3', 'subassembly', 'steel', 3),
  ];
  const tree = buildBomTree(rows, 'finished');
  assert.deepEqual(tree.map(entry => [entry.row.inventoryItemId, entry.depth, entry.requiredQuantity]), [
    ['subassembly-stock', 0, 2],
    ['steel', 1, 6],
    ['bolt', 0, 4],
  ]);
});

test('material summary flattens leaves and accumulates duplicate materials', () => {
  const rows = [
    row('BOM-1', 'finished', 'subassembly-stock', 2, 'subassembly'),
    row('BOM-2', 'finished', 'steel', 1),
    row('BOM-3', 'subassembly', 'steel', 3),
    row('BOM-4', 'subassembly', 'acid', 0.5),
  ];
  assert.deepEqual(summarizeBom(rows, 'finished'), [
    { inventoryItemId: 'steel', requiredQuantity: 7 },
    { inventoryItemId: 'acid', requiredQuantity: 1 },
  ]);
});

test('defensive traversal terminates if legacy data contains a product cycle', () => {
  const rows = [
    row('BOM-1', 'a', 'b-stock', 1, 'b'),
    row('BOM-2', 'b', 'a-stock', 1, 'a'),
  ];
  assert.equal(buildBomTree(rows, 'a').length, 2);
});
