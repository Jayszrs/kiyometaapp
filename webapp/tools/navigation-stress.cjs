// Browser regression/performance runner. All Supabase HTTP/WebSocket traffic
// is intercepted with synthetic fixtures; no production mutations are sent.
// Install Playwright separately, or point PLAYWRIGHT_MODULE at an existing copy.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..');
const baseURL = process.env.BASE_URL || 'http://127.0.0.1:4173';
const cycles = Number(process.env.CYCLES || 30);
const engine = process.env.ENGINE || 'chromium';
const mode = process.env.MODE || 'stress';
const output = process.env.RESULT || path.join(root, '.buildlog/navigation', `${mode}-${engine}.json`);
fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
const env = fs.readFileSync(path.join(root, 'webapp/.env.local'),'utf8');
const projectURL = env.match(/^VITE_SUPABASE_URL=(.+)$/m)[1].trim();
const ref = new URL(projectURL).hostname.split('.')[0];
const uid = '00000000-0000-4000-8000-000000000001';
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const day = new Date().toISOString().slice(0,10);
const user = { id:uid, email:'navigation@example.invalid', role:'authenticated', aud:'authenticated', app_metadata:{provider:'email'}, user_metadata:{username:'navigation'}, created_at:day };
const token = `${Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url')}.${Buffer.from(JSON.stringify({sub:uid,role:'authenticated',exp:Math.floor(Date.now()/1000)+86400})).toString('base64url')}.test`;
const session = {user,access_token:token,refresh_token:'fixture-refresh',token_type:'bearer',expires_in:86400,expires_at:Math.floor(Date.now()/1000)+86400};
const profile={id:uid,username:'navigation',display_name:'Navigation test',role:'administrator',active:true,avatar_path:'',employee_number:'',phone:'',department:'',position:'',birth_date:null,address:'',bio:''};
const clients=Array.from({length:20},(_,i)=>({id:id(100+i),name:`Fixture client ${i}`,email:'',phone:'',postal_code:'',address:''}));
const products=Array.from({length:40},(_,i)=>({id:id(200+i),client_name:clients[i%20].name,product_name:`Fixture product ${i}`,product_number:`FIX-${i}`,unit_price:1000,tasks:Array.from({length:54},(_,j)=>({content:`Task ${j+1}`,time:5})),drawings:i===0?[{path:'fixture/drawing.svg'}]:[],updated_at:day}));
const orders=Array.from({length:240},(_,i)=>({id:id(400+i),client:products[i%40].client_name,product_name:products[i%40].product_name,order_number:`NAV-${i}`,order_date:day,delivery_date:day,quantity:1,order_amount:1000,progress:'Order request',required_manhours:270,worked_manhours:0,production_end_date:null,order_contact:'',contact_contents:'',finish_task:false,has_contact:false,completed_tasks:[],version:1,inventory_stock_applied:false}));
const items=Array.from({length:100},(_,i)=>({id:id(1000+i),item_code:`FIX-ITEM-${i}`,item_name:`Fixture item ${i}`,category:'material',procurement_type:'buy',unit:'pcs',opening_qty:100,minimum_qty:10,target_qty:100,supplier_name:'Fixture supplier',unit_cost:10,active:true,available_qty:100,stock_value:1000,suggested_purchase_qty:0,needs_reorder:false}));
const movements=Array.from({length:500},(_,i)=>({id:id(2000+i),item_id:items[i%100].id,movement_no:`FIX-MOV-${i}`,movement_date:day,movement_type:'adjustment_in',reference_type:'manual',reference_id:null,quantity:1,delta:1,pic:'Fixture',notes:'',created_at:day}));
const bom=products.map((p,i)=>({id:id(3000+i),bom_no:`FIX-BOM-${i}`,product_id:p.id,inventory_item_id:items[i].id,parent_bom_no:null,quantity_per_unit:1,notes:''}));
const routes=[['order-entry','Order entry'],['search-billing','Search & billing'],['client-master','Client master'],['product-master','Product master'],['schedule','Schedule'],['inventory','Inventory'],['profile','My profile'],['management','Role management'],['home','Home']];
(async()=>{
 const browser=await (engine==='webkit'?webkit:chromium).launch(engine==='webkit'?{headless:true}:{headless:true,channel:'chrome',args:['--js-flags=--expose-gc']});
 const viewport={width:Number(process.env.WIDTH||1024),height:Number(process.env.HEIGHT||768)};
 const context=await browser.newContext({viewport,hasTouch:!process.env.DESKTOP,deviceScaleFactor:1,serviceWorkers:'block'});
 await context.addInitScript(({ref,uid,session,orders})=>{
   // Keep OS connectivity changes out of fixture timing comparisons. Resume
   // is tested separately; no real API or network availability is required.
   Object.defineProperty(navigator,'onLine',{configurable:true,get:()=>true});
   localStorage.setItem(`sb-${ref}-auth-token`,JSON.stringify(session));
   localStorage.setItem('kiyometa-language','en');
   const set=(key,value)=>localStorage.setItem(`kiyometa.recovery.v1:${uid}:${key}`,JSON.stringify(value));
   set('entry-new',false);set('entry-form',{id:orders[0].id,orderDate:orders[0].order_date,deliveryDate:orders[0].delivery_date,client:orders[0].client,orderNumber:orders[0].order_number,productName:orders[0].product_name,quantity:1,orderAmount:1000,progress:'Order request',requiredManhours:270,workedManhours:0,productionEndDate:'',orderContact:'',contactContents:'',finishTask:false,hasContact:false,completedTasks:[],version:1});set('page','home');set('billing-selection',[orders[0].id]);set('checklist-order',orders[0].id);set('entry-selection',orders[0].id);
   window.__longTasks={count:0,duration:0,max:0};window.__unhandled=[];
   window.addEventListener('unhandledrejection',e=>window.__unhandled.push(String(e.reason)));
   try{new PerformanceObserver(list=>{for(const e of list.getEntries()){window.__longTasks.count++;window.__longTasks.duration+=e.duration;window.__longTasks.max=Math.max(window.__longTasks.max,e.duration);}}).observe({type:'longtask',buffered:true});}catch{}
 },{ref,uid,session,orders});
 const requests={},failures=[],errors=[],samples=[],latencies=[];let pending=0,aborted=0,inventoryReads=0,activeInventoryReads=0,peakInventoryReads=0,inventoryFeed=null,failRead=true;
 await context.route(`${projectURL}/**`,async route=>{
   const req=route.request(),url=new URL(req.url()),key=url.pathname;requests[key]=(requests[key]||0)+1;pending++;
   const inventory=key.endsWith('/inventory_balances');
   if(inventory){inventoryReads++;peakInventoryReads=Math.max(peakInventoryReads,++activeInventoryReads);}
   try{
     if(req.method()==='OPTIONS')return await route.fulfill({status:204,headers:{'access-control-allow-origin':'*'}});
     let data;
     if(key.endsWith('/auth/v1/user'))data=user;
     else if(key.endsWith('/auth/v1/token'))data=session;
     else if(key.endsWith('/functions/v1/manage-users'))data={users:[{...profile,displayName:profile.display_name,createdAt:day}]};
     else if(key.includes('/rpc/undo_capabilities'))data={version:8};
     else if(key.includes('/rpc/user_label'))data='Navigation test';
     else if(key.includes('/storage/v1/object/sign/'))data=req.method()==='POST'&&req.postDataJSON()?.paths?req.postDataJSON().paths.map(p=>({path:p,signedURL:'/object/sign/fixture/drawing.svg?token=fixture'})):{signedURL:'/object/sign/fixture/drawing.svg?token=fixture'};
     else if(key.includes('/storage/'))return await route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="2048" height="1536"><rect width="100%" height="100%" fill="white"/><path d="M100 100H1900V1400H100Z" fill="none" stroke="navy" stroke-width="10"/></svg>'});
     else{
       const table=key.split('/').pop();data=({profiles:[profile],clients,products,orders,inventory_balances:items,purchases:[],stock_movements:movements,product_materials:bom,audit_logs:[]})[table];
       if(!data)throw Error(`Unhandled fixture endpoint ${key}`);
       if(url.searchParams.has('id'))data=data.filter(r=>r.id===url.searchParams.get('id').slice(3));
       if(table==='products'&&!url.searchParams.get('select')?.includes('*'))data=data.map(({tasks,drawings,...p})=>p);
       if(url.searchParams.has('limit'))data=data.slice(0,Number(url.searchParams.get('limit')));
       if(req.headers().accept?.includes('vnd.pgrst.object'))data=data[0]??null;
     }
     const body=JSON.stringify(data);
     const delay=mode==='read-cancel'&&/inventory_balances|purchases|stock_movements|product_materials/.test(key)?800:mode==='refresh-race'&&inventory&&inventoryReads===1?700:25;
     await new Promise(r=>setTimeout(r,delay));
     if(mode==='read-error'&&inventory&&failRead){failRead=false;return await route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({message:'Fixture read unavailable',code:'FIXTURE'})});}
     await route.fulfill({status:200,contentType:'application/json',body,headers:{'access-control-allow-origin':'*'}});
   }catch(e){failures.push(String(e));await route.abort();}finally{pending--;if(inventory)activeInventoryReads--;}
 });
 await context.route('https://fonts.googleapis.com/**',route=>route.fulfill({contentType:'text/css',body:''}));
 if(context.routeWebSocket)await context.routeWebSocket(/supabase.*realtime/,ws=>ws.onMessage(raw=>{try{const packet=JSON.parse(raw);const array=Array.isArray(packet);const m=array?{join_ref:packet[0],ref:packet[1],topic:packet[2],event:packet[3],payload:packet[4]}:packet;if(m.event==='phx_join'||m.event==='phx_leave'||m.event==='heartbeat'){
   const changes=(m.payload?.config?.postgres_changes||[]).map((c,id)=>({...c,id:String(id+1)}));
   if(m.event==='phx_join'&&m.topic.includes('inventory-data-refresh'))inventoryFeed={ws,topic:m.topic,joinRef:m.join_ref,array,changes};
   const payload={status:'ok',response:{postgres_changes:changes}};
   ws.send(JSON.stringify(array?[m.join_ref,m.ref,m.topic,'phx_reply',payload]:{topic:m.topic,event:'phx_reply',payload,ref:m.ref}));
 }}catch{}}));
 if(mode==='chunk-failure')await context.route('**/InventoryPage-*.js',r=>r.abort('failed'));
 const page=await context.newPage();page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text().slice(0,500));});
 page.on('requestfailed',r=>{if(/ABORT|cancel/i.test(r.failure()?.errorText||''))aborted++;else failures.push(new URL(r.url()).pathname+': '+r.failure()?.errorText);});
 const cdp=engine==='chromium'?await context.newCDPSession(page):null;
 async function settle(){await page.waitForTimeout(60);for(let i=0;pending&&i<100;i++)await page.waitForTimeout(30);await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));}
 async function measure(cycle){if(cdp)await cdp.send('HeapProfiler.collectGarbage');const dom=cdp?await cdp.send('Memory.getDOMCounters'):{};const heap=cdp?await cdp.send('Runtime.getHeapUsage'):{};return{cycle,...dom,heapBytes:heap.usedSize??null,...await page.evaluate(()=>({liveNodes:document.querySelectorAll('*').length,bodyHeight:document.body.clientHeight,textLength:document.getElementById('root').innerText.length,longTasks:window.__longTasks,unhandled:window.__unhandled}))};}
 try{
 const cold=performance.now();await page.goto(baseURL,{waitUntil:'load'});await page.getByRole('button',{name:'Menu',exact:true}).waitFor({timeout:30000});await settle();const coldLoadMs=performance.now()-cold;samples.push(await measure(0));
 if(mode!=='stress'){
   const origin=await page.evaluate(()=>performance.timeOrigin);
   if(mode==='render-failure')await page.evaluate(()=>{window.__originalNumberFormat=Number.prototype.toLocaleString;Number.prototype.toLocaleString=function(){throw new Error('Injected module render failure');};});
   await page.getByRole('button',{name:'Menu',exact:true}).click();await page.locator('nav').getByRole('button',{name:'Inventory',exact:true}).click();
   if(mode==='chunk-failure'||mode==='render-failure'){
     await page.getByText('This module could not be displayed',{exact:true}).waitFor();
     if(mode==='render-failure')await page.evaluate(()=>{Number.prototype.toLocaleString=window.__originalNumberFormat;});
     assert.ok(await page.getByRole('button',{name:'Menu',exact:true}).isVisible());
     await page.getByRole('button',{name:'Home',exact:true}).click();await settle();
     await page.getByRole('button',{name:'Menu',exact:true}).click();await page.locator('nav').getByRole('button',{name:'Inventory',exact:true}).click();
     if(mode==='chunk-failure'){
       await page.getByText('This module could not be displayed',{exact:true}).waitFor();
       await context.unroute('**/InventoryPage-*.js');
       await page.getByRole('button',{name:'Retry module',exact:true}).click();
     }
     await page.getByText('Fixture item 0',{exact:true}).waitFor();await settle();
     assert.equal(await page.evaluate(()=>performance.timeOrigin),origin);
     assert.equal(await page.evaluate(uid=>JSON.parse(localStorage.getItem(`kiyometa.recovery.v1:${uid}:entry-form`)).id,uid),orders[0].id);
   }else if(mode==='read-cancel'){
     for(let i=0;!inventoryReads&&i<100;i++)await page.waitForTimeout(10);
     await page.getByRole('button',{name:'Menu',exact:true}).click();await page.locator('nav').getByRole('button',{name:'Home',exact:true}).click();await settle();
     assert.ok(aborted>=4,`Expected inventory's four reads to abort, got ${aborted}`);
     assert.equal(await page.evaluate(uid=>JSON.parse(localStorage.getItem(`kiyometa.recovery.v1:${uid}:page`)),uid),'home');
   }else if(mode==='read-error'){
     await page.getByRole('button',{name:'Check again',exact:true}).waitFor();
     assert.match(await page.locator('#root').innerText(),/Unexpected error|Fixture read unavailable/);
     await page.getByRole('button',{name:'Check again',exact:true}).click();await settle();
     await page.getByText('Fixture item 0',{exact:true}).waitFor();
   }else if(mode==='refresh-race'){
     for(let i=0;(!inventoryReads||!inventoryFeed)&&i<100;i++)await page.waitForTimeout(10);
     assert.ok(inventoryFeed,'Inventory realtime subscription did not join');
     items[0].available_qty=200;items[0].stock_value=2000;
     const {ws,topic,changes,array,joinRef}=inventoryFeed;
     const change=changes.find(c=>c.table==='inventory_items');assert.ok(change);
     const payload={ids:[change.id],data:{schema:'public',table:'inventory_items',type:'UPDATE',columns:[{name:'id',type:'uuid'}],record:{id:items[0].id},old_record:{},commit_timestamp:new Date().toISOString()}};
     ws.send(JSON.stringify(array?[joinRef,null,topic,'postgres_changes',payload]:{topic,event:'postgres_changes',payload,ref:null}));
     await page.waitForTimeout(1200);await settle();
     assert.equal(peakInventoryReads,1,'Overlapping inventory reads can overwrite fresher results');
     assert.equal(inventoryReads,2,'A refresh received during a read must run after that read');
     const row=page.getByRole('row').filter({has:page.getByText('Fixture item 0',{exact:true})});
     assert.match(await row.innerText(),/\b200\b/);
   }else if(mode==='resume'){
     await settle();
     for(let i=0;i<5;i++){await page.evaluate(()=>{window.dispatchEvent(new Event('kiyometa-resume'));window.dispatchEvent(new Event('focus'));window.dispatchEvent(new Event('online'));document.dispatchEvent(new Event('visibilitychange'));});await settle();}
     assert.ok(await page.getByText('Fixture item 0',{exact:true}).isVisible());
   }else throw Error('Unknown MODE '+mode);
   assert.deepEqual(await page.evaluate(()=>window.__unhandled),[]);
   if(!['chunk-failure','render-failure','read-error'].includes(mode))assert.deepEqual(errors,[]);
   const result={mode,engine,browser:browser.version(),passed:true,aborted,inventoryReads,peakInventoryReads,requests,expectedFaultErrors:errors};
   fs.writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify({...result,expectedFaultErrors:errors.length}));return;
 }
 for(let c=1;c<=cycles;c++){
  for(const [target,label] of routes){
   const begin=performance.now();await page.getByRole('button',{name:'Menu',exact:true}).click();await page.locator('nav').getByRole('button',{name:label,exact:true}).click();await settle();
   await page.getByRole('button',{name:'Menu',exact:true}).waitFor({timeout:5000});
   const state=await page.evaluate(({uid,target})=>({route:JSON.parse(localStorage.getItem(`kiyometa.recovery.v1:${uid}:page`)),text:document.getElementById('root').innerText.length,header:!!document.querySelector('header'),height:document.getElementById('root').getBoundingClientRect().height}),{uid,target});
   if(state.route!==target||!state.header||state.text<60||state.height<100)throw Error('Blank or incorrect module '+JSON.stringify(state));
   latencies.push({target,ms:performance.now()-begin});
   if(target==='order-entry'){
     const start=performance.now();await page.getByRole('button',{name:'Tasks',exact:true}).click();await settle();
     if(!await page.getByRole('button',{name:'Save & Return',exact:true}).count())throw Error('Missing checklist content');
     latencies.push({target:'checklist',ms:performance.now()-start});await page.getByRole('button',{name:'Return',exact:true}).first().click();await settle();
   }
   if(target==='search-billing')for(const [sub,label] of [['invoice','Invoice Print'],['delivery-slip-single','Single Delivery Slip Print'],['delivery-slip-multiple','Multiple Delivery Slip Print']]){
     const start=performance.now();await page.getByRole('button',{name:label,exact:true}).click();await settle();
     if((await page.locator('#root').innerText()).length<100)throw Error('Blank document '+sub);
     latencies.push({target:sub,ms:performance.now()-start});
     await page.getByRole('button',{name:'Menu',exact:true}).click();await page.locator('nav').getByRole('button',{name:'Search & billing',exact:true}).click();await settle();
   }
   if(target==='inventory')for(const tab of ['Purchases','Movements','Product materials (BOM)','Inventory']){await page.getByRole('button',{name:tab,exact:true}).click();await settle();}

  }
  if(c%5===0)samples.push(await measure(c));
 }
 const percentile=(xs,p)=>xs.slice().sort((a,b)=>a-b)[Math.min(xs.length-1,Math.floor(xs.length*p))];
 assert.deepEqual(errors,[]);assert.deepEqual(failures,[]);assert.deepEqual(await page.evaluate(()=>window.__unhandled),[]);
 const result={engine,browser:browser.version(),viewport,hasTouch:!process.env.DESKTOP,fixtureLatencyMs:25,cycles,navigations:latencies.length,coldLoadMs,medianMs:percentile(latencies.map(x=>x.ms),.5),p95Ms:percentile(latencies.map(x=>x.ms),.95),requests,failures,errors,samples,latencies};
 fs.writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify({...result,latencies:undefined}));
 }catch(e){await page.screenshot({path:output+'.png'});fs.writeFileSync(output,JSON.stringify({error:String(e),errors,failures,requests,samples,latencies,aborted,inventoryReads,peakInventoryReads},null,2));console.error(String(e));console.error(JSON.stringify({errors,failures,requests,aborted,inventoryReads,peakInventoryReads}));process.exitCode=1;}
 finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});

