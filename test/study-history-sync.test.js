'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {create}=require('../lib/study-history-sync');
const Analytics=require('../lib/study-analytics');
const copy=value=>JSON.parse(JSON.stringify(value));
const stamp=(day=28,hour=12)=>new Date(2026,10,day,hour).getTime();
const event=(deckId,rating,day=28)=>({deckId,deckName:deckId,rating,timestamp:stamp(day)});
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
function fixture(){
  const map=new Map(),rows=new Map(),calls=[];
  const state={userId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',generation:1,fail:false,failUpload:false,storageFail:false};
  const storage={
    getItem:key=>map.has(key)?map.get(key):null,
    setItem(key,value){if(state.storageFail)throw Error('quota');map.set(key,value);},
    removeItem:key=>map.delete(key),key:i=>[...map.keys()][i],get length(){return map.size;}
  };
  const account=()=>({userId:state.userId,generation:state.generation});
  const current=a=>a.userId===state.userId&&a.generation===state.generation;
  const cloud={
    async listMyStudyHistoryDevices(owner){
      calls.push(['list',owner]);if(state.fail)throw Error('offline');
      return copy([...rows.values()].filter(row=>row.user_id===owner));
    },
    async upsertMyStudyHistoryDevice(id,history,owner){
      calls.push(['upsert',owner,id,copy(history)]);if(state.fail||state.failUpload)throw Error('offline');
      const row={user_id:owner,device_id:id,history:copy(history),updated_at:new Date().toISOString()};
      rows.set(owner+'::'+id,row);return copy(row);
    }
  };
  let tail=Promise.resolve();
  const lock=(_name,work)=>{const next=tail.then(work,work);tail=next.catch(()=>{});return next;};
  let nextId=1;
  const sync=create({storage,cloud,analytics:Analytics,isCurrent:current,lock,
    uuid:()=> '11111111-1111-4111-8111-'+String(nextId++).padStart(12,'0')});
  return {map,rows,calls,state,storage,cloud,account,current,sync};
}
test('device ID is stable and persisted once per browser installation',()=>{
  const f=fixture(),a=f.sync.deviceId(),b=f.sync.deviceId();
  assert.equal(a,b);assert.equal(f.map.get('fc_study_device_id'),a);
});
test('legacy account history is migrated into the first device source without deletion',()=>{
  const f=fixture(),history=Analytics.recordReview(Analytics.createHistory(),event('deck',2));
  f.map.set('fc_study_history::'+f.state.userId,JSON.stringify(history));
  const result=f.sync.activate(f.account());
  assert.equal(result.deviceHistory.totals.reviews,1);
  assert.equal(result.history.totals.reviews,1);
  assert.ok(f.map.has('fc_study_history::'+f.state.userId));
  assert.ok(f.map.has('fc_study_history_sources::'+f.state.userId));
});
test('independent device histories are summed while repeated snapshots from one device merge by maximum',()=>{
  const f=fixture(),a=f.sync.deviceId();
  let first=Analytics.recordReview(Analytics.createHistory(),event('deck',2));
  let second=Analytics.recordReview(Analytics.createHistory(),event('deck',2,27));
  const sources={[a]:first,'22222222-2222-4222-8222-222222222222':second};
  const merged=f.sync.aggregateSources(sources);
  assert.equal(merged.totals.reviews,2);
  assert.equal(merged.decks[0].reviews,2);
  const repeated=Analytics.mergeHistory(first,first);
  assert.equal(repeated.totals.reviews,1);
});
test('recording changes only the current device component and aggregates immediately',async()=>{
  const f=fixture(),account=f.account();
  const a=await f.sync.recordReview(account,event('deck',2));
  const b=await f.sync.recordReview(account,event('deck',3,27));
  assert.equal(a.deviceHistory.totals.reviews,1);
  assert.equal(b.deviceHistory.totals.reviews,2);
  assert.equal(b.history.totals.reviews,2);
});
test('offline local progress survives and retries into the cloud when connectivity returns',async()=>{
  const f=fixture(),account=f.account();f.state.fail=true;
  await f.sync.recordReview(account,event('deck',2));
  await assert.rejects(f.sync.sync(account),/offline/);
  assert.equal(f.sync.activate(account).history.totals.reviews,1);
  f.state.fail=false;const result=await f.sync.sync(account);
  assert.equal(result.synced,true);assert.equal(result.history.totals.reviews,1);
  assert.equal(f.rows.size,1);
});
test('two devices with simultaneous offline progress converge without losing same-rating reviews',async()=>{
  const f=fixture(),account=f.account(),a=f.sync.deviceId();
  await f.sync.recordReview(account,event('deck',2));
  await f.sync.sync(account);
  const remote=f.sync.encodeEnvelope({[a]:f.sync.activate(account).deviceHistory});
  const b='22222222-2222-4222-8222-222222222222';
  f.rows.set(account.userId+'::'+b,{user_id:account.userId,device_id:b,history:remote});
  // Simulate a distinct device with an independent local history component.
  const bHistory=Analytics.recordReview(Analytics.createHistory(),event('deck',2,27));
  const bEnvelope=f.sync.encodeEnvelope({[b]:bHistory});
  f.rows.set(account.userId+'::'+b,{user_id:account.userId,device_id:b,history:bEnvelope});
  const result=await f.sync.sync(account);
  assert.equal(result.history.totals.reviews,2);
  assert.equal(result.history.totals.ratings[2],2);
  assert.equal(Object.keys(result.sources).length,2);
});
test('repeated sync is idempotent and does not double count replicated source vectors',async()=>{
  const f=fixture(),account=f.account();
  await f.sync.recordReview(account,event('deck',2));
  const first=await f.sync.sync(account),second=await f.sync.sync(account);
  assert.equal(first.history.totals.reviews,1);
  assert.equal(second.history.totals.reviews,1);
});
test('another account cannot read or modify local history and stale responses cannot upload',async()=>{
  const f=fixture(),account=f.account(),d=deferred(),started=deferred();
  f.cloud.listMyStudyHistoryDevices=async owner=>{started.resolve();return d.promise;};
  const run=f.sync.sync(account);await started.promise;
  f.state.userId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';f.state.generation++;
  d.resolve([]);await assert.rejects(run,/Account changed/);
  assert.equal(f.calls.some(c=>c[0]==='upsert'),false);
  assert.equal(f.map.has('fc_study_history_sources::'+f.state.userId),false);
});
test('storage failure prevents upload and leaves no false acknowledgement',async()=>{
  const f=fixture(),account=f.account();f.state.storageFail=true;
  await assert.rejects(f.sync.recordReview(account,event('deck',2)),/quota/);
  assert.equal(f.calls.some(c=>c[0]==='upsert'),false);
});
test('missing Web Locks allows local recording but blocks unsafe cloud synchronization',async()=>{
  const f=fixture(),noLock=create({storage:f.storage,cloud:f.cloud,analytics:Analytics,isCurrent:f.current,uuid:()=>f.sync.deviceId()});
  const account=f.account();await noLock.recordReview(account,event('deck',2));
  const result=await noLock.sync(account);
  assert.equal(result.pending,true);assert.equal(f.calls.length,0);
});
test('invalid remote history fails closed and is never overwritten',async()=>{
  const f=fixture(),account=f.account(),id='22222222-2222-4222-8222-222222222222';
  const invalid=Analytics.createHistory();invalid.totals.reviews=-1;
  f.rows.set(account.userId+'::'+id,{user_id:account.userId,device_id:id,
    history:{version:1,sources:[{sourceId:id,history:invalid}]}});
  await assert.rejects(f.sync.sync(account),/invalid lifetime total/i);
  assert.equal(f.rows.get(account.userId+'::'+id).history.sources[0].history.totals.reviews,-1);
});
test('backup import merges source vectors and legacy backups remain importable',async()=>{
  const f=fixture(),account=f.account(),id=f.sync.deviceId();
  const one=Analytics.recordReview(Analytics.createHistory(),event('deck',2));
  const two=Analytics.recordReview(Analytics.createHistory(),event('deck',3,27));
  const imported=f.sync.importBackup(account,null,[{sourceId:id,history:one},{sourceId:'22222222-2222-4222-8222-222222222222',history:two}]);
  assert.equal(imported.history.totals.reviews,2);
  const legacy=f.sync.importBackup(account,one,null);
  assert.equal(legacy.history.totals.reviews,2);
  assert.equal(f.sync.exportSources(account).length,2);
});
