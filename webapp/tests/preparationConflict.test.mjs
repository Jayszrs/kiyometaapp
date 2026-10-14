import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import ts from 'typescript';
let source=readFileSync(new URL('../src/lib/db.ts',import.meta.url),'utf8').replace('import { supabase } from "./supabaseClient";','const supabase = globalThis.orderDbMock;');
const {outputText}=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}});
let updateResult,latest,patch;
globalThis.orderDbMock={from:()=>({update:values=>{patch=values;return {eq(){return this;},select(){return this;},single:async()=>updateResult};},select:()=>({eq(){return this;},maybeSingle:async()=>({data:latest,error:null})})})};
const {markPreparationPrinted,StaleOrderError,upsertOrder}=await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
const order={id:'order-1',version:2,quantity:3,orderAmount:15000,progress:'In production'};

test('print status updates only print metadata and optimistic version',async()=>{
 updateResult={data:{id:'order-1',version:3,completed_tasks:[]},error:null};
 await markPreparationPrinted(order,'2026-10-14T01:00:00Z');
 assert.deepEqual(patch,{preparation_print_status:'completed',preparation_printed_at:'2026-10-14T01:00:00Z',version:3});
});
test('concurrent edit identifies the actual latest username',async()=>{
 updateResult={data:null,error:{code:'PGRST116'}};latest={id:'order-1',version:4,updated_by_username:'operator-rama'};
 await assert.rejects(markPreparationPrinted(order,'now'),error=>error instanceof StaleOrderError && error.latestEditor==='operator-rama' && error.message.includes('operator-rama'));
 await assert.rejects(upsertOrder(order),error=>error instanceof StaleOrderError && error.latestEditor==='operator-rama');
});
test('permission/schema failure is not misreported as another person editing',async()=>{
 const error={code:'42501',message:'permission denied'};updateResult={data:null,error};
 await assert.rejects(markPreparationPrinted(order,'now'),actual=>actual===error);
 await assert.rejects(upsertOrder(order),actual=>actual===error);
});
test('unavailable username is explicit, never fabricated',async()=>{
 updateResult={data:null,error:{code:'PGRST116'}};latest={id:'order-1',version:4};
 await assert.rejects(markPreparationPrinted(order,'now'),error=>error instanceof StaleOrderError && error.latestEditor===undefined && error.message.includes('username is unavailable'));
});
