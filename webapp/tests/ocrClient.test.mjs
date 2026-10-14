import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, after, beforeEach } from 'node:test';
import { indexedDB } from 'fake-indexeddb';
import { storageUrl, memoryStorage } from './loadRecoveryModule.mjs';
globalThis.indexedDB = indexedDB;
globalThis.localStorage = memoryStorage();
beforeEach(() => localStorage.clear());
import ts from 'typescript';
let source = readFileSync(new URL('../src/lib/ocrClient.ts', import.meta.url), 'utf8')
  .replace('import { supabase } from "./supabaseClient";', 'const supabase = {auth:{getSession:async()=>({data:{session:{access_token:"test-token",user:{id:"ocr-user"}}}})}};')
  .replace('import.meta.env.VITE_OCR_URL', 'undefined').replace('"./recoveryStorage"', JSON.stringify(storageUrl));
const {outputText}=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}});
const diagnostic = console.error;
console.error=()=>{};
after(()=>{console.error=diagnostic;});
const normalTimer=(callback,ms)=>{if(ms<300000)queueMicrotask(callback);return 0;};
globalThis.window=Object.assign(new EventTarget(),{location:{origin:'https://test.invalid'},setTimeout:normalTimer,clearTimeout});
const {runOcr,OcrError,getOcrRecovery}=await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
const file = new File(['pixels'],'camera.jpg',{type:'image/jpeg'});
const response=body=>({ok:true,json:async()=>body});
const lines=[{text:'数量',x0:0,y0:0,x1:50,y1:20,score:.99}];

test('OCR failures are typed and never expose service details',async()=>{
  for (const [status,kind] of [[524,'timeout'],[504,'timeout'],[422,'unreadable'],[503,'service'],[429,'busy'],[401,'auth'],[413,'size']]) {
    globalThis.fetch=async()=>({ok:false,status,json:async()=>({detail:'private traceback'})});
    await assert.rejects(runOcr(file),error=>error instanceof OcrError && error.kind===kind && !error.message.includes('HTTP') && !error.message.includes('private'));
  }
});

test('job upload occurs once; polling waits for queued/running result',async()=>{
  const deadlines=[];
  window.setTimeout=(callback,ms)=>{deadlines.push(ms);return normalTimer(callback,ms);};
  let uploads=0, polls=0;
  globalThis.fetch=async(url,request)=>{
    if(request.method==='POST') {uploads++;assert.equal(request.body.get('file').name,'camera.jpg');return response({id:'scan-1'});}
    assert.ok(url.endsWith('/ocr/jobs/scan-1'));
    polls++;
    return response(polls===1?{status:'queued'}:polls===2?{status:'running'}:{status:'done',result:{lines}});
  };
  assert.deepEqual(await runOcr(file),lines);
  assert.equal(uploads,1); assert.equal(polls,3);
  assert.ok(deadlines.includes(330000)); assert.ok(!deadlines.includes(90000));
  window.setTimeout=normalTimer;
});

test('backend terminal failure ends scan with the actual error kind',async()=>{
  globalThis.fetch=async(url,request)=>response(request.method==='POST'?{id:'scan-1'}:{status:'error',error:'timeout'});
  await assert.rejects(runOcr(file),error=>error.kind==='timeout');
});

test('closing OCR detaches polling, preserves the job, and never cancels backend work',async()=>{
  const controller = new AbortController();
  const calls=[];
  globalThis.fetch=async(url,request)=>{
    calls.push(request.method??'GET');
    if(request.method==='POST')return response({id:'scan-1'});
    if(request.method==='DELETE')return response({status:'cancelling'});
    controller.abort();return response({status:'running'});
  };
  await assert.rejects(runOcr(file,controller.signal),error=>error.kind==='timeout');
  assert.deepEqual(calls,['POST','GET']);
  assert.equal(getOcrRecovery('ocr-user').id,'scan-1');
  globalThis.fetch=async()=>response({status:'done',result:{lines}});
  assert.deepEqual(await runOcr(),lines);
});

test('transient polling failure resumes the existing job without re-upload',async()=>{
  let uploads=0,polls=0;
  globalThis.fetch=async(url,request)=>{
    if(request.method==='POST'){uploads++;return response({id:'scan-1'});}
    if(++polls===1)throw new Error('temporary network interruption');
    return response({status:'done',result:{lines}});
  };
  assert.deepEqual(await runOcr(file),lines);assert.equal(uploads,1);
});

test('frontend deadline aborts a genuinely stuck request',async()=>{
  window.setTimeout=callback=>{queueMicrotask(callback);return 0;};
  globalThis.fetch=async(url,request)=>{if(request.signal.aborted) throw new Error('aborted');return new Promise((resolve,reject)=>request.signal.addEventListener('abort',()=>reject(new Error('aborted'))));};
  await assert.rejects(runOcr(file),error=>error.kind==='timeout');
  window.setTimeout=normalTimer;
});

test('extended network loss preserves the job for reconnect without another upload',async()=>{
  let uploads=0;
  globalThis.fetch=async(url,request)=>{if(request.method==='POST'){uploads++;return response({id:'scan-offline'});}throw new TypeError('network disconnected');};
  await assert.rejects(runOcr(file),error=>error.kind==='service');
  assert.equal(getOcrRecovery('ocr-user').id,'scan-offline');
  globalThis.fetch=async()=>response({status:'done',result:{lines}});
  assert.deepEqual(await runOcr(),lines);assert.equal(uploads,1);
});
test('reopening a completed scan uses its persisted result without network',async()=>{
  globalThis.fetch=async(url,request)=>response(request.method==='POST'?{id:'completed'}:{status:'done',result:{lines}});
  await runOcr(file);
  globalThis.fetch=async()=>{assert.fail('completed result should be local');};
  assert.deepEqual(await runOcr(),lines);
});
test('lost upload acknowledgement recovers saved source bytes on reopen',async()=>{
  globalThis.fetch=async()=>{throw new TypeError('response lost during upload');};
  await assert.rejects(runOcr(file));
  let uploads=0;
  globalThis.fetch=async(url,request)=>{
    if(request.method==='POST'){uploads++;assert.equal(await request.body.get('file').text(),'pixels');return response({id:'deduplicated'});}
    return response({status:'done',result:{lines}});
  };
  assert.deepEqual(await runOcr(),lines);assert.equal(uploads,1);
});
test('service restart recovers a missing job from persisted source bytes',async()=>{
  const controller=new AbortController();
  globalThis.fetch=async(url,request)=>{if(request.method==='POST')return response({id:'old-job'});controller.abort();return response({status:'running'});};
  await assert.rejects(runOcr(file,controller.signal));
  let uploads=0;
  globalThis.fetch=async(url,request)=>{
    if(url.endsWith('/old-job'))return {ok:false,status:404};
    if(request.method==='POST'){uploads++;return response({id:'replacement-job'});}
    return response({status:'done',result:{lines}});
  };
  assert.deepEqual(await runOcr(),lines);assert.equal(uploads,1);
});
