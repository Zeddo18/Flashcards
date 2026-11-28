'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'..','cloud.js'),'utf8');
function clientFixture(){
  let auth,listed=[],upserted=null,fail=null;const calls=[];
  const query={
    select(columns){calls.push(['select',columns]);return this;},
    eq(key,value){calls.push(['eq',key,value]);return this;},
    order(key,options){calls.push(['order',key,options]);return Promise.resolve({data:listed,error:fail});},
    upsert(row,options){calls.push(['upsert',row,options]);upserted=row;return this;},
    single(){return Promise.resolve({data:upserted,error:fail});}
  };
  const window={SUPABASE_URL:'synthetic',SUPABASE_ANON_KEY:'synthetic',sessionStorage:{},
    supabase:{createClient:()=>({
      auth:{onAuthStateChange:fn=>auth=fn,getSession:()=>new Promise(()=>{})},
      from:table=>{calls.push(['from',table]);return query;}
    })}};
  vm.runInNewContext(source,{window,Date,crypto:{randomUUID:()=> '11111111-1111-4111-8111-111111111111'}});
  window.Cloud.init();auth('SIGNED_IN',{user:{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}});
  return {window,calls,setRows(rows){listed=rows;},setError(error){fail=error;},get upserted(){return upserted;},auth};
}
test('study-history list is account-filtered and orders rows deterministically',async()=>{
  const f=clientFixture();f.setRows([{device_id:'11111111-1111-4111-8111-111111111111'}]);
  const rows=await f.window.Cloud.listMyStudyHistoryDevices('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.equal(rows.length,1);
  assert.ok(f.calls.some(c=>c[0]==='from'&&c[1]==='study_history_devices'));
  assert.ok(f.calls.some(c=>c[0]==='eq'&&c[1]==='user_id'&&c[2]==='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'));
  assert.ok(f.calls.some(c=>c[0]==='order'&&c[1]==='updated_at'));
});
test('study-history upsert uses composite key and sends the authenticated owner',async()=>{
  const f=clientFixture(),id='11111111-1111-4111-8111-111111111111';
  const envelope={version:1,sources:[]};
  const row=await f.window.Cloud.upsertMyStudyHistoryDevice(id,envelope,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.equal(row.device_id,id);assert.equal(f.upserted.user_id,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.equal(f.calls.find(c=>c[0]==='upsert')[2].onConflict,'user_id,device_id');
});
test('study-history methods reject mismatched accounts before issuing requests',async()=>{
  const f=clientFixture(),before=f.calls.length;
  await assert.rejects(f.window.Cloud.listMyStudyHistoryDevices('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),/Account changed/);
  await assert.rejects(f.window.Cloud.upsertMyStudyHistoryDevice('11111111-1111-4111-8111-111111111111',{},'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),/Account changed/);
  assert.equal(f.calls.length,before);
});
test('study-history methods surface Data API errors without claiming success',async()=>{
  const f=clientFixture();f.setError(new Error('table unavailable'));
  await assert.rejects(f.window.Cloud.listMyStudyHistoryDevices('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),/table unavailable/);
  await assert.rejects(f.window.Cloud.upsertMyStudyHistoryDevice('11111111-1111-4111-8111-111111111111',{},'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),/table unavailable/);
});
