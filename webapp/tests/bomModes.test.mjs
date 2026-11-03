import assert from 'node:assert/strict';
import { test } from 'node:test';
import { moduleUrl } from './loadRecoveryModule.mjs';

const { buildBomTree, compatibleSubassemblyProducts, summarizeBom, wouldCreateProductCycle } = await import(moduleUrl('bom.ts'));

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

test('subassembly choices only match manufactured inventory items and clear ambiguous matches', () => {
  const products = [
    { id: 'assembly-a', productNumber: 'FG-A001', productName: 'Bracket assembly A' },
    { id: 'assembly-b', productNumber: 'FG-B001', productName: 'Sensor mount B' },
  ];
  const items = [
    { id: 'raw', itemCode: 'RM-001', itemName: 'Pelat aluminium', category: 'material', procurementType: 'buy' },
    { id: 'stock-a', itemCode: 'FG-001', itemName: 'Bracket assembly A', category: 'finished_good', procurementType: 'make' },
    { id: 'stock-unknown', itemCode: 'FG-999', itemName: 'Unknown assembly', category: 'component', procurementType: 'make' },
  ];
  assert.deepEqual(compatibleSubassemblyProducts([], products, items, 'finished', 'raw'), []);
  assert.deepEqual(compatibleSubassemblyProducts([], products, items, 'finished', 'stock-a').map(product => product.id), ['assembly-a']);
  assert.deepEqual(compatibleSubassemblyProducts([], products, items, 'finished', 'stock-unknown'), []);
});

test('subassembly choices exclude self-links and links that would form a product cycle', () => {
  const products = [
    { id: 'a', productNumber: 'A', productName: 'A' },
    { id: 'b', productNumber: 'B', productName: 'B' },
  ];
  const items = [{ id: 'b-stock', itemCode: 'B', itemName: 'B', category: 'component', procurementType: 'make' }];
  const rows = [row('BOM-1', 'b', 'a-stock', 1, 'a')];
  assert.equal(wouldCreateProductCycle(rows, 'a', 'b'), true);
  assert.deepEqual(compatibleSubassemblyProducts(rows, products, items, 'a', 'b-stock'), []);
  assert.deepEqual(compatibleSubassemblyProducts([], products, items, 'b', 'b-stock'), []);
});
