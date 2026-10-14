import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import ts from 'typescript';
const source=readFileSync(new URL('../src/lib/parseQuotation.ts',import.meta.url),'utf8');
const {outputText}=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}});
const {parseQuotation,normalizeClientName}=await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
const truth=JSON.parse(readFileSync(new URL('../../ocr-service/tests/camera-ground-truth.json',import.meta.url),'utf8'));
const normalized=(key,value)=>typeof value==='string'?(key==='client'?normalizeClientName(value):value).normalize('NFKC').replace(/\s/g,''):value;
for(const [filename,reference] of [['20261014_162323.jpg','masuda'],['20261014_162333.jpg','shinwa'],['20261014_162031.heic','masuda'],['20261014_162042.heic','shinwa']]) {
 test(`actual ${filename}: PDF benchmark fields match; unresolved process remains flagged`,()=>{
  const fixture=JSON.parse(readFileSync(new URL(`./fixtures/camera-20261014-${filename}.json`,import.meta.url),'utf8'));
  const parsed=parseQuotation(fixture.lines);
  for(const [key,value] of Object.entries(truth[reference].data)) {
   if(key==='processName' && reference==='masuda')continue;
   assert.equal(normalized(key,parsed.data[key]),normalized(key,value),`${filename}: ${key}`);
  }
  if(reference==='masuda')assert.equal(parsed.fields.find(field=>field.key==='processName').status,'review');
  if(filename==='20261014_162323.jpg')assert.equal(parsed.fields.find(field=>field.key==='unitPrice').status,'review');
 });
}
test('rotated and recompressed camera image uses the printed heading instead of browser chrome for dates',()=>{
 const fixture=JSON.parse(readFileSync(new URL('./fixtures/camera-20261014-rotated-shinwa.json',import.meta.url),'utf8'));
 const parsed=parseQuotation(fixture.lines);
 for(const [key,value] of Object.entries(truth.shinwa.data))assert.equal(normalized(key,parsed.data[key]),normalized(key,value),key);
});
