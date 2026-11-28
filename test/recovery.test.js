'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {create,recoverBackup}=require('../lib/sync-journal');
const Analytics=require('../lib/study-analytics');
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

async function conflictFixture() {
 const f=setup();f.state.local.decks=[deck('d','Local')];f.server.decks.set('d',{...deck('d','Remote'),_revision:'r1'});
 f.state.local.notes=[note('n','Local note')];f.server.notes.set('n',{...note('n','Remote note'),_revision:'r2'});
 f.cloud.resolveVersion=async(entity,value,revision,owner)=>{
   assert.equal(owner,f.state.id);
   if(f.server[entity].get(value.id)?._revision!==revision)return null;
   const row={...copy(value),_revision:revision+'-next'};f.server[entity].set(value.id,row);return row;
 };
 await f.sync();return f;
}
const apply=f=>(entity,id,value)=>{f.state.local[entity]=f.state.local[entity].filter(x=>x.id!==id).concat(value);};
test('lists multiple deck/note conflicts and all preserved versions for only current account',async()=>{
 const f=await conflictFixture(),list=f.journal.conflicts(f.account());assert.equal(list.length,2);assert.equal(list[0].versions.length,2);
 f.server.decks.set('d',{...deck('d','Third version'),_revision:'r3'});await f.sync();
 assert.equal(f.journal.conflicts(f.account()).find(x=>x.entity==='decks').versions.length,3);
 f.state.id='B';f.state.generation++;assert.equal(f.journal.conflicts(f.account()).length,0);
});
for(const choice of ['local','remote'])test('explicit '+choice+' selection confirms then archives all unique versions',async()=>{
 const f=await conflictFixture(),review=f.journal.conflicts(f.account()).find(x=>x.entity==='decks');
 const result=await f.journal.resolve(f.account(),review,choice,apply(f));
 assert.equal(result.name,choice==='local'?'Local':'Remote');assert.equal(f.state.local.decks[0].name,result.name);
 assert.equal(f.server.decks.get('d').name,result.name);
 assert.equal(f.journal.conflicts(f.account()).filter(x=>x.entity==='decks').length,0);
 const archive=[...f.map].find(([k])=>k.includes('archive::decks'));assert.ok(archive);
 assert.equal(JSON.parse(archive[1]).versions.length,2);
});
test('failed local resolution remains intact and succeeds on explicit retry',async()=>{
 const f=await conflictFixture(),review=f.journal.conflicts(f.account())[0],normal=f.cloud.resolveVersion;
 f.cloud.resolveVersion=async()=>{throw Error('offline');};
 await assert.rejects(f.journal.resolve(f.account(),review,'local',apply(f)),/offline/);
 assert.equal(f.journal.conflicts(f.account()).length,2);
 f.cloud.resolveVersion=normal;await f.journal.resolve(f.account(),review,'local',apply(f));assert.equal(f.journal.conflicts(f.account()).length,1);
});
test('remote changes after review cancel resolution and preserve the new version',async()=>{
 const f=await conflictFixture(),review=f.journal.conflicts(f.account()).find(x=>x.entity==='decks');let writes=0;
 f.cloud.resolveVersion=async()=>{writes++;};f.server.decks.set('d',{...deck('d','Changed'),_revision:'r9'});
 await assert.rejects(f.journal.resolve(f.account(),review,'local',apply(f)),/Cloud version changed/);
 assert.equal(writes,0);assert.equal(f.journal.conflicts(f.account()).find(x=>x.id==='d').versions.length,3);
});
test('server compare-and-swap rejection protects a version changed after the recheck',async()=>{
 const f=await conflictFixture(),review=f.journal.conflicts(f.account())[0];
 f.cloud.resolveVersion=async()=>null;
 await assert.rejects(f.journal.resolve(f.account(),review,'local',apply(f)),/Cloud version changed/);
 assert.equal(f.journal.conflicts(f.account()).length,2);
});
test('new local edit invalidates old review without consuming its pending operation',async()=>{
 const f=await conflictFixture(),review=f.journal.conflicts(f.account())[0];
 const op=f.journal.enqueue(f.account(),'decks','upsert',deck('d','Edited again'));
 await assert.rejects(f.journal.resolve(f.account(),review,'remote',apply(f)),/Local version changed/);
 assert.ok(f.journal.pending(f.account()).some(x=>x.token===op.token));
});
test('account change during resolution prevents apply and acknowledgement',async()=>{
 const f=await conflictFixture(),review=f.journal.conflicts(f.account())[0],d=deferred(),started=deferred();
 f.cloud.listMyDecks=()=>{started.resolve();return d.promise;};const account=f.account();
 const run=f.journal.resolve(account,review,'remote',()=>assert.fail('must not apply'));
 await started.promise;f.state.id='B';f.state.generation++;d.resolve([review.remote]);
 await assert.rejects(run,/Account changed/);assert.ok([...f.map].some(([k])=>k.includes('A::conflict')));
});
test('local persistence failure does not acknowledge or remove active conflict',async()=>{
 const f=await conflictFixture(),review=f.journal.conflicts(f.account())[0];
 await assert.rejects(f.journal.resolve(f.account(),review,'remote',()=>{throw Error('storage failed');}),/storage failed/);
 assert.equal(f.journal.conflicts(f.account()).length,2);
});
test('export includes pending upserts, conflicts, archives, tombstones and holds without auth fields',async()=>{
 const f=await conflictFixture();f.journal.holdRecovery(f.account(),'decks',deck('recovered'));
 f.journal.enqueue(f.account(),'notes','delete','deleted-note');await f.sync();
 f.state.local.decks[0].password='secret-marker';
 const backup=f.journal.backup(f.account(),f.state.local);
 assert.equal(backup.version,4);assert.equal(backup.ownerId,'A');
 for(const kind of ['op','conflict','deleted','hold'])assert.ok(backup.journal.some(x=>x.key.startsWith(kind+'::')),kind);
 assert.doesNotMatch(JSON.stringify(backup),/secret-marker|password|SUPABASE|access_token/);
});
test('version 4 backups include validated study history while excluding unrelated fields',()=>{
 const f=setup();let history=Analytics.createHistory();
 history=Analytics.recordReview(history,{deckId:'d',deckName:'Study',rating:2,timestamp:new Date(2026,10,25,12).getTime()});
 history.extraSecret='must-not-export';
 const backup=f.journal.backup(f.account(),f.state.local,history);
 assert.equal(backup.version,4);assert.equal(backup.studyHistory.totals.reviews,1);
 assert.equal(backup.studyHistory.extraSecret,undefined);
 assert.deepEqual(backup.studyHistory,Analytics.validateHistory(backup.studyHistory));
 const recovered=recoverBackup(backup,f.account(),()=> 'fresh');
 assert.equal(recovered.studyHistory.totals.reviews,1);
});
test('version 4 backups preserve per-device source histories for safe cross-device recovery',()=>{
 const f=setup(),historyA=Analytics.recordReview(Analytics.createHistory(),{deckId:'d',deckName:'Study',rating:2,timestamp:new Date(2026,10,25,12).getTime()});
 const historyB=Analytics.recordReview(Analytics.createHistory(),{deckId:'d',deckName:'Study',rating:2,timestamp:new Date(2026,10,26,12).getTime()});
 const sources=[
  {sourceId:'11111111-1111-4111-8111-111111111111',history:historyA},
  {sourceId:'22222222-2222-4222-8222-222222222222',history:historyB}
 ];
 const aggregate=Analytics.createHistory();
 aggregate.totals={reviews:2,ratings:[0,0,2,0],sessions:0,sessionCards:0,completedCards:0,activeDays:2};
 aggregate.decks=[{...historyA.decks[0],reviews:2,ratings:[0,0,2,0]}];
 aggregate.days=[...historyA.days,...historyB.days];
 const backup=f.journal.backup(f.account(),f.state.local,Analytics.validateHistory(aggregate),sources);
 const recovered=recoverBackup(backup,f.account(),()=> 'fresh');
 assert.equal(backup.version,4);
 assert.equal(recovered.studyHistorySources.length,2);
 assert.equal(recovered.studyHistorySources[1].history.totals.reviews,1);
});
test('version 3 backups remain recoverable after the version 4 source-vector upgrade',()=>{
 const legacy={format:'flushcard',version:3,ownerId:'A',decks:[],notes:[],
  studyHistory:Analytics.createHistory(),journal:[]};
 const recovered=recoverBackup(legacy,{userId:'A'},()=> 'fresh');
 assert.equal(recovered.studyHistory.version,1);
 assert.equal(recovered.studyHistorySources,null);
});
test('version 4 backups reject duplicate or malformed source histories',()=>{
 const f=setup(),backup=f.journal.backup(f.account(),f.state.local,Analytics.createHistory(),[
  {sourceId:'11111111-1111-4111-8111-111111111111',history:Analytics.createHistory()}
 ]);
 backup.studyHistorySources.push(copy(backup.studyHistorySources[0]));
 assert.throws(()=>recoverBackup(backup,f.account(),()=> 'fresh'),/study-history source/i);
});
test('version 2 backups remain recoverable without fabricating study history',()=>{
 const legacy={format:'flushcard',version:2,ownerId:'A',decks:[],notes:[],journal:[]};
 const recovered=recoverBackup(legacy,{userId:'A'},()=> 'fresh');
 assert.equal(recovered.studyHistory,null);
});
test('version 4 backups reject malformed study history before recovering records',()=>{
 const f=setup(),backup=f.journal.backup(f.account(),f.state.local,Analytics.createHistory());
 backup.studyHistory.totals.reviews=-1;
 assert.throws(()=>recoverBackup(backup,f.account(),()=> 'fresh'),/invalid lifetime total/i);
});
test('recovery restores unique conflict and pending copies with new private IDs and never replays deletes',async()=>{
 const f=await conflictFixture();f.journal.enqueue(f.account(),'notes','delete','n-deleted');await f.sync();
 const backup=f.journal.backup(f.account(),f.state.local);let count=0;
 const recovered=recoverBackup(backup,f.account(),()=> 'new-'+(++count));
 assert.ok(recovered.recoveryCopies>=2);assert.ok(recovered.decks.length>=2);
 assert.ok(recovered.decks.every(x=>x.id.startsWith('new-')&&!x.isPublic&&x.slug===null));
 assert.ok(recovered.notes.every(x=>x.id.startsWith('new-')));
 assert.equal(f.journal.pending(f.account()).filter(x=>x.type==='delete').length,0);
});
test('cross-account and guest imports reject account-specific journals',async()=>{
 const f=await conflictFixture(),backup=f.journal.backup(f.account(),f.state.local);
 assert.throws(()=>recoverBackup(backup,{userId:'B'},()=> 'x'),/another account/);
 assert.throws(()=>recoverBackup(backup,{userId:null},()=> 'x'),/another account/);
});
test('old backup formats remain compatible with deduplication and new IDs',()=>{
 for(const input of [[deck()],{decks:[deck(),deck()],notes:[note()]}]){
 let i=0;const r=recoverBackup(input,{userId:null},()=> 'fresh-'+(++i));
 assert.equal(r.decks.length,1);assert.equal(r.decks[0].id,'fresh-1');assert.equal(r.decks[0].slug,null);
 }
});
test('malformed JSON shapes, unknown versions and duplicate generated IDs are rejected',()=>{
 assert.throws(()=>recoverBackup({decks:'wrong'},{userId:null},()=> 'x'),/Invalid backup/);
 assert.throws(()=>recoverBackup({version:99},{userId:null},()=> 'x'),/Unsupported/);
 assert.throws(()=>recoverBackup({decks:[{...deck(),cards:[{front:5,back:'x'}]}]},{userId:null},()=> 'x'),/Invalid backup text/);
 assert.throws(()=>recoverBackup({decks:[deck()],notes:[note()]},{userId:null},()=> 'same'),/collision/);
});
test('recovered copies remain local across sync and edits until explicit upload',async()=>{
 const f=setup(),value=deck('fresh');
 f.state.local.decks=[value];f.journal.holdRecovery(f.account(),'decks',value);
 let r=await f.sync();assert.equal(r.pending,1);assert.equal(f.server.decks.size,0);
 f.state.local.decks=[deck('fresh','Edited locally')];f.journal.enqueue(f.account(),'decks','upsert',f.state.local.decks[0]);
 await f.sync();assert.equal(f.server.decks.size,0);
 f.journal.uploadRecovered(f.account());await f.sync();assert.equal(f.server.decks.get('fresh').name,'Edited locally');
});
test('export and recovery-hold storage errors are explicit',()=>{
 const f=setup();f.state.storageFail=true;
 assert.throws(()=>f.journal.holdRecovery(f.account(),'notes',note()),/storage failed/);
 f.map.set('fc_sync::A::op::broken','bad JSON');
 assert.throws(()=>f.journal.backup(f.account(),f.state.local),/unreadable/);
});
test('guest export has no account journal and guest recovery does not enqueue',()=>{
 const f=setup();f.state.id=null;
 f.journal.holdRecovery(f.account(),'notes',note());const backup=f.journal.backup(f.account(),{decks:[deck()],notes:[]});
 assert.equal(backup.ownerId,null);assert.equal(backup.journal.length,0);assert.equal(f.map.size,0);
});
test('deleting a held recovery copy prevents later explicit uploads from resurrecting it',async()=>{
 const f=setup();f.state.local.decks=[deck('restored')];f.journal.holdRecovery(f.account(),'decks',f.state.local.decks[0]);
 f.state.local.decks=[];f.journal.enqueue(f.account(),'decks','delete','restored');await f.sync();
 f.journal.uploadRecovered(f.account());await f.sync();
 assert.equal(f.server.decks.size,0);assert.equal(f.state.local.decks.length,0);
 const backup=f.journal.backup(f.account(),f.state.local);
 assert.ok(backup.journal.some(x=>x.key.startsWith('conflict::decks')));
});
test('cloud resolution uses owner and exact revision conditions and returns updated revision',async()=>{
 const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');let auth;const filters=[];
 const row={id:'d',user_id:'A',name:'Local',cards:[],created_at:new Date(1).toISOString(),updated_at:'r2'};
 const query={eq(k,v){filters.push([k,v]);return this;},select(){return this;},maybeSingle:async()=>({data:row,error:null})};
 const window={SUPABASE_URL:'synthetic',SUPABASE_ANON_KEY:'synthetic',sessionStorage:{},supabase:{createClient:()=>({
 auth:{onAuthStateChange:fn=>auth=fn,getSession:()=>new Promise(()=>{})},
 from:entity=>{assert.equal(entity,'decks');return {update:()=>query};}
 })}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'..','cloud.js'),'utf8'),{window});
 window.Cloud.init();auth('SIGNED_IN',{user:{id:'A'}});
 const result=await window.Cloud.resolveVersion('decks',deck(),'r1','A');
 assert.deepEqual(filters,[['id','d'],['user_id','A'],['updated_at','r1']]);assert.equal(result._revision,'r2');
 await assert.rejects(window.Cloud.resolveVersion('decks',deck(),'r1','B'),/Account changed/);
});


