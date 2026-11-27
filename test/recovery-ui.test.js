'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const api=require('../lib/sync-journal'),html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const block=html.slice(html.indexOf('$("exportAll").onclick'),html.indexOf('/* ========== base64 share'));
function setup(){
 const els=new Map(),storage=new Map(),inputs=[],calls=[];let n=0;
 function el(){const classes=new Set();return {children:[],textContent:'',value:'',style:{},classList:{add:k=>classes.add(k),remove:k=>classes.delete(k),toggle(k,on){if(on)classes.add(k);else classes.delete(k);},contains:k=>classes.has(k)},append(...a){this.children.push(...a);},appendChild(a){this.children.push(a);},click(){},removeAttribute(){}};}
 const $=id=>{if(!els.has(id))els.set(id,el());return els.get(id);};
 const state={decks:[],notesLib:[],user:{id:'A'},cur:null,cards:[],session:null,$,statusEl:el(),JSON,Date,Set,
   captureAccount:()=>({userId:state.user?.id||null,generation:1}),accountIsCurrent:a=>a.userId===(state.user?.id||null),
   Cloud:{uuid:()=> 'new-'+(++n)},window:{FCSyncJournal:api},
   document:{createElement(tag){const e=el();if(tag==='input')inputs.push(e);return e;}},
   renderDecks(){},renderNotesLib(){},saveDecks:()=>true,saveNotes:()=>true,pullAndMerge:async()=>calls.push('sync'),
   download:(name,content)=>calls.push(JSON.parse(content))};
 const mem={getItem:k=>storage.has(k)?storage.get(k):null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k),key:i=>[...storage.keys()][i],get length(){return storage.size;}};
 const journal=api.create({storage:mem,cloud:{},isCurrent:state.accountIsCurrent,lock:(_n,work)=>work()});
 state.getSyncJournal=()=>journal;vm.createContext(state);vm.runInContext(block,state);
 return {state,$,inputs,calls,journal};
}
const record={id:'old',name:'Recovered',cards:[{front:'Question',back:'Answer'}],created:1,isPublic:true,slug:'shared'};
test('recovery UI imports fresh private copies locally and upload requires its separate button',async()=>{
 const f=setup();f.$('importAll').onclick();const input=f.inputs[0];
 input.files=[{size:100,text:async()=>JSON.stringify({decks:[record],notes:[]})}];await input.onchange();
 assert.equal(f.state.decks[0].id,'new-1');assert.equal(f.state.decks[0].isPublic,false);
 assert.equal(f.calls.length,0);assert.match(f.state.statusEl.textContent,/nothing uploaded/);
 await f.$('uploadRecovery').onclick();assert.equal(f.calls[0],'sync');
});
test('import discards file read after account switching and never changes the next library',async()=>{
 const f=setup();let resolve;f.$('importAll').onclick();const input=f.inputs[0];
 input.files=[{size:100,text:()=>new Promise(r=>resolve=r)}];const run=input.onchange();
 f.state.user={id:'B'};resolve(JSON.stringify({decks:[record],notes:[]}));await run;
 assert.equal(f.state.decks.length,0);assert.match(f.state.statusEl.textContent,/Account changed/);
});
test('UI export produces versioned account backup including pending values',()=>{
 const f=setup();f.journal.enqueue(f.state.captureAccount(),'decks','upsert',record);f.$('exportAll').onclick();
 assert.equal(f.calls[0].version,2);assert.equal(f.calls[0].journal[0].value.type,'upsert');
});
test('guest conflict UI does not expose account copies',()=>{
 const f=setup();f.state.user=null;f.$('reviewConflicts').onclick();
 assert.match(f.$('recoveryList').textContent,/Sign in/);
});
test('private recovery content is cleared by the identity-change scrubber',()=>{
 const clear=html.slice(html.indexOf('function clearPrivateState()'),html.indexOf('(function migrateIds()'));
 assert.match(clear,/"recoveryList"/);assert.match(clear,/\$\("recoveryPanel"\)\.classList.add\("hide"\)/);
});


