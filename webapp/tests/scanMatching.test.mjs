import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
const source=readFileSync(new URL('../src/lib/scanMatching.ts',import.meta.url),'utf8');
const {outputText}=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}});
const {findClientMatch,findProductMatch}=await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

test('client matching handles corporate abbreviations without guessing ambiguous companies',()=>{
  const clients=[{name:'株式会社マスダ シートメタル課'},{name:'伸和テクノス株式会社'},{name:'伸和工業株式会社'}];
  assert.equal(findClientMatch(clients,'㈱マスダ シートメタル課'),clients[0]);
  assert.equal(findClientMatch(clients,'伸和'),undefined);
  assert.equal(findClientMatch([{name:'(株)マスダ'}],'(株)マスダ シートメタル課')?.name,'(株)マスダ');
  assert.equal(findClientMatch([{name:'株式会社マスダ'},{name:'(株)マスダ'}],'マスダ'),undefined);
});

test('product code is authoritative, matching is client-scoped and duplicate names require review',()=>{
  const products=[{clientName:'株式会社マスダ',productName:'タンク (TOP)',productNumber:'NSQ-F0124-05'},
    {clientName:'株式会社マスダ',productName:'タンク (TOP)',productNumber:'NSQ-F0124-06'},
    {clientName:'株式会社他社',productName:'タンク (TOP)',productNumber:'OTHER-01'}];
  assert.equal(findProductMatch(products,'(株)マスダ','タンク(TOP)','ＮＳＱ－Ｆ０１２４－０５'),products[0]);
  assert.equal(findProductMatch(products,'(株)マスダ','タンク (TOP)','UNSEEN-01'),undefined);
  assert.equal(findProductMatch(products,'(株)マスダ','タンク (TOP)',''),undefined);
  assert.equal(findProductMatch(products,'(株)マスダ','タンク (TOP)','OTHER-01'),undefined);
});
