'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {create}=require('../lib/sync-journal');
const copy=x=>JSON.parse(JSON.stringify(x));
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
function setup() {
  const map=new Map(),server={decks:new Map(),notes:new Map()},calls=[];
  const state={id:'A',generation:1,local:{decks:[],notes:[]},fail:false,storageFail:false};
  const storage={getItem:k=>map.has(k)?map.get(k):null,setItem(k,v){if(state.storageFail)throw Error('quota');map.set(k,v);},
    removeItem:k=>map.delete(k),key:i=>[...map.keys()][i],get length(){return map.size;}};
  const account=()=>({userId:state.id,generation:state.generation});
  const isCurrent=a=>a.userId===state.id && a.generation===state.generation;
  const cloud={};
  for(const [entity,list,save,del]of [['decks','listMyDecks','bulkUpsert','deleteDeck'],['notes','listMyNotes','bulkUpsertNotes','deleteNote']]){
    cloud[list]=async()=>{calls.push([list,state.id]);return copy([...server[entity].values()]);};
    cloud[save]=async rows=>{calls.push([save,state.id,copy(rows)]);if(state.fail)throw Error('network offline');for(const row of rows)server[entity].set(row.id,copy(row));return copy(rows);};
    cloud[del]=async id=>{calls.push([del,state.id,id]);if(state.fail)throw Error('network offline');server[entity].delete(id);};
  }
  // Shared lock manager models Web Locks serialization across page instances.
  let lockTail=Promise.resolve();
  const lock=(_name,work)=>{const next=lockTail.then(work,work);lockTail=next.catch(()=>{});return next;};
  const build=()=>create({storage,cloud,isCurrent,lock});
  const journal=build();
  return {state,map,server,calls,storage,cloud,account,build,journal,
    sync:(j=journal)=>j.sync(account(),()=>copy(state.local),(entity,items)=>state.local[entity]=items)};
}
const deck=(id='d',name='Local')=>({id,name,cards:[{front:'Question',back:'Answer'}],created:1,isPublic:false,slug:null,color:null});
const note=(id='n',md='Local note')=>({id,title:'Note',md,created:1});
for(const [entity,value]of [['decks',deck()],['notes',note()]]) {
  test('failed '+entity+' bulk upload remains durable and never reports success',async()=>{
    const f=setup();f.state.fail=true;f.state.local[entity]=[value];
    f.journal.enqueue(f.account(),entity,'upsert',value);
    const r=await f.sync();assert.equal(r.failed,true);assert.equal(r.pending,1);
    assert.equal(f.journal.pending(f.account())[0].value.id,value.id);
    assert.equal(f.state.local[entity][0].id,value.id);
  });
  test('failed '+entity+' deletion cannot resurrect remote content',async()=>{
    const f=setup();f.server[entity].set(value.id,value);f.state.fail=true;
    f.journal.enqueue(f.account(),entity,'delete',value.id);
    const r=await f.sync();assert.equal(r.failed,true);assert.equal(f.state.local[entity].length,0);
    assert.equal(f.journal.pending(f.account())[0].type,'delete');
  });
}
test('reload retains failed saves and deletions and successful retry clears confirmed operations',async()=>{
  const f=setup();f.state.fail=true;f.journal.enqueue(f.account(),'decks','upsert',deck());f.journal.enqueue(f.account(),'notes','delete','n');
  await f.sync();const reloaded=f.build();assert.equal(reloaded.pending(f.account()).length,2);
  f.state.fail=false;const result=await f.sync(reloaded);assert.equal(result.pending,0);assert.equal(result.failed,false);
  assert.ok(f.server.decks.has('d'));assert.equal(reloaded.pending(f.account()).length,0);
});
test('old save confirmation cannot clear a newer edit queued while request waits',async()=>{
  const f=setup(),d=deferred();f.state.local.decks=[deck()];f.journal.enqueue(f.account(),'decks','upsert',deck());
  f.cloud.bulkUpsert=async rows=>{await d.promise;f.server.decks.set('d',copy(rows[0]));return rows;};
  const run=f.sync();await new Promise(r=>setImmediate(r));
  f.state.local.decks=[deck('d','Newer')];const newer=f.journal.enqueue(f.account(),'decks','upsert',f.state.local.decks[0]);
  d.resolve();await run;
  assert.equal(f.journal.pending(f.account()).length,1);
  assert.equal(f.journal.pending(f.account())[0].token,newer.token);
  assert.equal(f.state.local.decks[0].name,'Newer');
});
test('old save confirmation cannot consume a newer delete and reintroduce the item',async()=>{
  const f=setup(),d=deferred();f.state.local.decks=[deck()];f.journal.enqueue(f.account(),'decks','upsert',deck());
  f.cloud.bulkUpsert=async rows=>{await d.promise;return rows;};
  const run=f.sync();await new Promise(r=>setImmediate(r));f.state.local.decks=[];
  f.journal.enqueue(f.account(),'decks','delete','d');d.resolve();await run;
  assert.equal(f.state.local.decks.length,0);assert.equal(f.journal.pending(f.account())[0].type,'delete');
});
test('repeated offline edits collapse to the latest durable edit',async()=>{
  const f=setup();for(const name of ['one','two','three'])f.journal.enqueue(f.account(),'decks','upsert',deck('d',name));
  f.state.local.decks=[deck('d','three')];await f.sync();
  assert.equal(f.server.decks.get('d').name,'three');assert.equal(f.journal.pending(f.account()).length,0);
  assert.equal(f.calls.filter(x=>x[0]==='bulkUpsert').length,1);
});
test('concurrent sync calls are serialized and do not duplicate confirmed writes',async()=>{
  const f=setup();f.state.local.notes=[note()];f.journal.enqueue(f.account(),'notes','upsert',note());
  await Promise.all([f.sync(),f.sync(),f.sync(f.build())]);
  assert.equal(f.calls.filter(x=>x[0]==='bulkUpsertNotes').length,1);assert.equal(f.journal.pending(f.account()).length,0);
});
test('account A operations never run under B and stale responses never apply',async()=>{
  const f=setup(),d=deferred();f.journal.enqueue(f.account(),'decks','delete','A-d');
  f.cloud.listMyDecks=()=>d.promise;const run=f.sync();await new Promise(r=>setImmediate(r));
  f.state.id='B';f.state.generation++;f.state.local={decks:[],notes:[]};d.resolve([deck('A-d')]);await run;
  assert.equal(f.calls.filter(x=>x[0]==='deleteDeck').length,0);assert.equal(f.state.local.decks.length,0);
  assert.equal(f.journal.pending(f.account()).length,0);assert.ok([...f.map.keys()].some(k=>k.startsWith('fc_sync::A::op::')));
});
test('guest operations never create journals or issue cloud requests',async()=>{
  const f=setup();f.state.id=null;assert.equal(f.journal.enqueue(f.account(),'decks','upsert',deck()),null);
  assert.equal(await f.sync(),null);assert.equal(f.map.size,0);assert.equal(f.calls.length,0);
});
test('storage failure is explicit and prevents the first network call',()=>{
  const f=setup();f.state.storageFail=true;assert.throws(()=>f.journal.enqueue(f.account(),'notes','upsert',note()),/not safely queued/);
  assert.equal(f.calls.length,0);
});
test('corrupt journal fails closed rather than dropping pending work',async()=>{
  const f=setup();f.map.set('fc_sync::A::op::broken','not JSON');
  await assert.rejects(f.sync(),/journal is unreadable/);assert.equal(f.map.get('fc_sync::A::op::broken'),'not JSON');
});
test('conflicting same-ID records preserve both complete versions and never upload over remote',async()=>{
  const f=setup();f.state.local.decks=[deck('d','Local newer?')];f.server.decks.set('d',deck('d','Remote unique'));
  const r=await f.sync();assert.equal(r.conflicts,1);assert.equal(r.pending,1);
  assert.equal(f.server.decks.get('d').name,'Remote unique');assert.equal(f.state.local.decks[0].name,'Local newer?');
  const conflict=JSON.parse([...f.map].find(([k])=>k.includes('::conflict::'))[1]);
  assert.equal(conflict.versions.length,2);assert.equal(f.calls.filter(x=>x[0]==='bulkUpsert').length,0);
});
test('remote changes are adopted only when local still equals its confirmed baseline',async()=>{
  const f=setup();f.state.local.notes=[note()];f.server.notes.set('n',note());await f.sync();
  f.server.notes.set('n',note('n','Remote changed'));await f.sync();
  assert.equal(f.state.local.notes[0].md,'Remote changed');assert.equal(f.calls.filter(x=>x[0]==='bulkUpsertNotes').length,0);
});
test('confirmed tombstone suppresses an older cloud listing even after reload',async()=>{
  const f=setup();f.server.notes.set('n',note());f.journal.enqueue(f.account(),'notes','delete','n');await f.sync();
  f.cloud.listMyNotes=async()=>[note()];await f.sync(f.build());assert.equal(f.state.local.notes.length,0);
});
test('missing cross-tab locks prevents unsafe network retries',async()=>{
  const f=setup(),j=create({storage:f.storage,cloud:f.cloud,isCurrent:()=>true});
  await assert.rejects(j.sync(f.account(),()=>f.state.local,()=>{}),/Web Locks/);assert.equal(f.calls.length,0);
});
test('public sharing query and publish APIs are still present and narrowly selected',()=>{
  const fs=require('node:fs'),path=require('node:path'),cloud=fs.readFileSync(path.join(__dirname,'..','cloud.js'),'utf8');
  assert.match(cloud,/\.select\("name, cards, created_at, public_slug"\)/);
  assert.match(cloud,/\.eq\("public_slug", slug\)\.eq\("is_public", true\)/);
  assert.match(cloud,/async function publishDeck\(id\)/);assert.match(cloud,/async function unpublishDeck\(id\)/);
});


