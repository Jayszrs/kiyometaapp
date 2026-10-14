import React from 'react';
import {createRoot} from 'react-dom/client';
import App from './src/App';
import {AuthContext} from './src/lib/auth';
import {DialogProvider} from './src/components/AppDialog';
import {supabase} from './src/lib/supabaseClient';
import {readRecovery,writeRecovery} from './src/lib/recoveryStorage';
import './src/index.css';
const owner='recovery-ui-test';
const profile={id:owner,username:'test-operator',displayName:'Test operator',role:'operator',active:true};
const order={id:'1cbf5017-b8ad-4c6b-b964-11696ff0c30d',version:1,orderDate:'2026-10-14',deliveryDate:'2026-10-20',client:'Test client',orderNumber:'TEST-RECOVERY',productName:'Test tank',quantity:3,orderAmount:15000,progress:'Order request',requiredManhours:0,workedManhours:0,productionEndDate:'',orderContact:'',contactContents:'',finishTask:false,hasContact:false,completedTasks:[]};
let connected=true,loseNextResponse=false,appOpen=true,language='en';
Object.defineProperty(navigator,'onLine',{configurable:true,get:()=>connected});
const ledger=()=>readRecovery<Record<string,unknown>>(owner,'test-ledger')??{};
const status=()=>{document.getElementById('evidence')!.textContent=`Database writes: ${Object.keys(ledger()).length} | Pending: ${(readRecovery<any[]>(owner,'outbox')??[]).length} | Server OCR accepted: ${!!readRecovery(owner,'test-ocr-accepted')} | Server OCR cancelled: ${!!readRecovery(owner,'test-ocr-cancelled')}`;};
supabase.auth.getSession=async()=>({data:{session:{user:{id:owner},access_token:'test-only'}},error:null}) as any;
supabase.from=(()=>({select(){return this;},order(){return this;},range:async()=>({data:[],error:null}),in:async()=>({data:[...Object.values(ledger())].slice(-1),error:null})})) as any;
supabase.channel=(()=>({on(){return this;},subscribe(){return this;}})) as any;
supabase.removeChannel=async()=> 'ok';
supabase.rpc=(async(name,args:any)=>{
 if(name!=='submit_order_once')return {data:null,error:null,status:200};
 if(!connected)return {data:null,error:{message:'Failed to fetch'},status:0};
 const entries=ledger(); const row=entries[args.p_request_id]??{...args.p_order,version:(args.p_expected_version??0)+1};
 entries[args.p_request_id]=row;writeRecovery(owner,'test-ledger',entries);status();
 if(loseNextResponse){loseNextResponse=false;return {data:null,error:{message:'Failed to fetch'},status:0};}
 return {data:row,error:null,status:200};
}) as any;
const originalFetch=window.fetch.bind(window);
window.fetch=async(input,init)=>{
 const url=String(input);
 if(url.includes('/ocr/jobs')){
  if(init?.method==='DELETE'){writeRecovery(owner,'test-ocr-cancelled',true);status();}
  if(init?.method==='POST'){writeRecovery(owner,'test-ocr-accepted',true);status();return new Response(JSON.stringify({id:'test-ocr'}),{status:200});}
  const done=readRecovery(owner,'test-ocr-done');
  const lines=[{text:'注文書',x0:0,y0:0,x1:100,y1:20,score:1},{text:'2026/10/14',x0:300,y0:0,x1:400,y1:20,score:1},{text:'数量 3',x0:0,y0:100,x1:100,y1:120,score:1},{text:'部品名 タンク',x0:0,y0:140,x1:200,y1:160,score:1}];
  return new Response(JSON.stringify(done?{status:'done',result:{lines}}:{status:'running'}),{status:200});
 }
 if(url.endsWith('/log'))return new Response('{}');
 return originalFetch(input,init);
};
if(!readRecovery(owner,'data-cache'))writeRecovery(owner,'data-cache',{orders:[order],clients:[{id:'test-client',name:'Test client',phone:'',email:'',postalCode:'',address:''}],products:[{id:'test-product',clientName:'Test client',productName:'Test tank',productNumber:'TEST-001',unitPrice:5000,tasks:[],drawings:[],drawingPaths:[]}]});
const root=createRoot(document.getElementById('root')!);
const render=()=>root.render(appOpen?<AuthContext.Provider value={{profile,signOut:()=>{},email:'test@example.invalid',updateProfile:()=>{}} as any}><DialogProvider lang={language as any}><App lang={language as any} setLang={value=>{language=value;render();}}/></DialogProvider></AuthContext.Provider>:<p>App closed · local storage remains</p>);
document.getElementById('controls')!.innerHTML='<div style="display:flex;gap:12px;flex-wrap:wrap;padding:8px"><button id="disconnect">Disconnect</button><button id="reconnect">Reconnect</button><button id="close">Close app</button><button id="reopen">Reopen app</button><button id="lose">Lose next response</button><button id="complete">Complete server OCR</button><output id="evidence"></output></div>';
document.getElementById('disconnect')!.onclick=()=>{connected=false;window.dispatchEvent(new Event('offline'));status();};
document.getElementById('reconnect')!.onclick=()=>{connected=true;window.dispatchEvent(new Event('online'));status();};
document.getElementById('close')!.onclick=()=>{appOpen=false;render();};
document.getElementById('reopen')!.onclick=()=>{appOpen=true;render();};
document.getElementById('lose')!.onclick=()=>{loseNextResponse=true;};
document.getElementById('complete')!.onclick=()=>{writeRecovery(owner,'test-ocr-done',true);status();};
window.addEventListener('kiyometa-outbox',status);render();status();
const clean=document.createElement('button');clean.textContent='Remove test data';clean.onclick=()=>{appOpen=false;render();for(const key of Object.keys(localStorage))if(key.startsWith('kiyometa.recovery.v1:recovery-ui-test:'))localStorage.removeItem(key);status();};document.getElementById('controls')!.append(clean);
