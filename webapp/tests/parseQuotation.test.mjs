import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/parseQuotation.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } });
const { parseQuotation, normalizeClientName } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
const box = (text, x0, y0, width=100, page=0, score=.99) => ({text,x0,y0,x1:x0+width,y1:y0+20,page,score});
const pairs = entries => entries.flatMap(([label,value],i) => [box(label,10,40*i,140),box(value,170,40*i,250)]);

test('all aliases work on an unfamiliar quotation title; values need no whitespace after labels', () => {
  const parsed = parseQuotation(pairs([
    ['発注日','２０２６年７月２７日'], ['指定納入日','２６／０８／０３'],
    ['注文番号','MS294541'], ['品目コード','NSQ-F0124-05'], ['品目名','タンク (TOP)'],
    ['発注数量','１．'], ['発注単価','６，０００．'], ['発注金額','６，０００'], ['名称','ドブ漬け酸洗い処理'],
  ]));
  assert.equal(parsed.template,'unnamed');
  assert.deepEqual(Object.fromEntries(['orderDate','deliveryDate','orderNumber','productNumber','productName','quantity','unitPrice','orderAmount','processName'].map(k=>[k,parsed.data[k]])),{
    orderDate:'2026-07-27',deliveryDate:'2026-08-03',orderNumber:'MS294541',productNumber:'NSQ-F0124-05',productName:'タンク (TOP)',quantity:1,unitPrice:6000,orderAmount:6000,processName:'ドブ漬け酸洗い処理',
  });
  const inline=parseQuotation([box('部品名：タンク (TOP)',0,0,220),box('発注日：2026/08/17',0,40,220)]);
  assert.equal(inline.data.productName,'タンク (TOP)');
  assert.equal(inline.data.orderDate,'2026-08-17');
});

test('table columns preserve quantities, prices, net total, complete names and codes', () => {
  const labels=['図面番号','部品名','納期','処理名','数量','単価','合計金額','注文No.'];
  const vals=['NHD-F1772-11','タンク','08/20','酸洗い','3','5,000.00','15,000','210266'];
  const lines=labels.flatMap((l,i)=>[box(l,i*180,150,120),box(vals[i],i*180,190,120)]);
  lines.push(box('発注日:2026/08/17',0,0,240),box('税込合計金額:16,500',400,0,240),box('消費税額:1,500',700,0,220));
  const p=parseQuotation(lines);
  assert.equal(p.data.orderAmount,15000); assert.equal(p.data.quantity,3); assert.equal(p.data.unitPrice,5000);
  assert.equal(p.data.productName,'タンク'); assert.equal(p.data.productNumber,'NHD-F1772-11');
  assert.equal(p.data.orderNumber,'210266'); assert.equal(p.data.deliveryDate,'2026-08-20');
});

test('sender contact stays separate from destination, telephone and FAX', () => {
  const p=parseQuotation([
    box('株式会社キヨメタ 御中',0,0,250),box('〒399-0651 長野県塩尻市北小野2131-1',0,40,350),
    box('(株)マスダ シートメタル課',600,200,280),box('〒３９９－４３０１ 長野県上伊那郡宮田村6623-2',600,240,460),
    box('TEL 0266-28-0105 FAX 0266-75-1008',600,280,450),
  ]);
  assert.equal(p.data.client,'(株)マスダ シートメタル課');
  assert.equal(p.data.clientPostalCode,'399-4301');
  assert.equal(p.data.clientAddress,'長野県上伊那郡宮田村6623-2');
  assert.equal(p.data.clientPhone,'0266-28-0105');
  const noPostal=parseQuotation([box('伸和テクノス株式会社',0,0,240),box('TEL 0266-28-0105',0,40,220)]);
  assert.equal(noPostal.data.clientPostalCode,'');
});

test('split names and fullwidth postal fragments retain all characters', () => {
  const p=parseQuotation([box('品目名',0,0,120),box('タンク',0,40,60),box('(TOP)',70,40,70),
    box('株式会社新会社',500,0,200),box('〒３９９',500,40,70),box('－４３０１',575,40,90)]);
  assert.equal(p.data.productName,'タンク (TOP)');assert.equal(p.data.clientPostalCode,'399-4301');
});

test('missing labels, invalid dates and tax totals never become fabricated values', () => {
  const p=parseQuotation(pairs([['発注日','2026/02/30'],['指定納入日','08/03'],['税込合計金額','16,500'],['消費税額','1,500'],['数量','08/03']]));
  assert.equal(p.data.orderDate,'');assert.equal(p.data.deliveryDate,'');assert.equal(p.data.orderAmount,0);assert.equal(p.data.quantity,0);
  assert.ok(p.fields.find(f=>f.key==='orderAmount').status==='missing');
  assert.equal(parseQuotation([]).fields.filter(f=>f.status==='found').length,0);
});

test('values cannot jump across pages or fields, and decimals are preserved', () => {
  const p=parseQuotation([box('数量',0,0),box('99',0,40,100,1),box('発注単価:1,234.50',300,0,250),box('発注金額:2,469.00',300,40,250)]);
  assert.equal(p.data.quantity,0);assert.equal(p.data.unitPrice,1234.5);assert.equal(p.data.orderAmount,2469);
  assert.equal(parseQuotation([box('数量',0,0),box('単価',0,40),box('100',0,80)]).data.quantity,0);
});

test('December yearless deadlines roll forward and company names are not hardcoded', () => {
  assert.equal(parseQuotation(pairs([['発注日','2026/12/20'],['納期','1/8']])).data.deliveryDate,'2027-01-08');
  assert.equal(normalizeClientName('（株）新しい会社'),'株式会社新しい会社');
  assert.equal(normalizeClientName('伸和工業株式会社'),'伸和工業株式会社');
});

test('actual Shinwa OCR output matches all printed application fields', () => {
  const lines=JSON.parse(readFileSync(new URL('./fixtures/shinwa-ocr.json',import.meta.url),'utf8'));
  assert.deepEqual(parseQuotation(lines).data,{
    orderDate:'2026-08-17',deliveryDate:'2026-08-20',client:'伸和テクノス株式会社',
    orderNumber:'210266',productNumber:'NHD-F1772-11',productName:'タンク',quantity:3,
    unitPrice:5000,orderAmount:15000,processName:'酸洗い',clientPostalCode:'',
    clientAddress:'長野県諏訪郡下諏訪町4611番地90',clientPhone:'0266-28-0105',
  });
});

test('actual Masuda OCR output distinguishes the issuing company from Kiyometa', () => {
  const lines=JSON.parse(readFileSync(new URL('./fixtures/masuda-ocr.json',import.meta.url),'utf8'));
  assert.deepEqual(parseQuotation(lines).data,{
    orderDate:'2026-07-27',deliveryDate:'2026-08-03',client:'(株)マスダ シートメタル課',
    orderNumber:'MS294541',productNumber:'NSQ-F0124-05',productName:'タンク(TOP)',quantity:1,
    unitPrice:6000,orderAmount:6000,processName:'ドブ漬け酸洗い処理',clientPostalCode:'399-4301',
    clientAddress:'長野県上伊那郡宮田村6623-2',clientPhone:'',
  });
});

test('first item cannot borrow a missing quantity from the next table row',()=>{
  const p=parseQuotation([box('図面番号',0,0,130),box('数量',200,0,70),box('単価',400,0,90),
    box('PART-001',0,40,130),box('5,000',400,40,90),
    box('PART-002',0,80,130),box('20',200,80,70),box('9,000',400,80,90)]);
  assert.equal(p.data.productNumber,'PART-001');assert.equal(p.data.quantity,0);assert.equal(p.data.unitPrice,5000);
  assert.ok(p.warnings.some(w=>w.includes('Multiple items')));
});
