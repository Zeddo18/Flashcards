'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function section(start, end) {
  const i = html.indexOf(start), j = html.indexOf(end, i);
  assert.ok(i >= 0 && j > i, 'production source section exists');
  return html.slice(i, j);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((a,b) => { resolve=a; reject=b; });
  return {promise, resolve, reject};
}
function fixture() {
  const elements = new Map(), storage = new Map(), writes = [], calls = [];
  let auth;
  function $(id) {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, {textContent:'PRIVATE', value:'', disabled:false,
        style:{width:'100%'}, oninput(){}, removeAttribute(k){ delete this[k]; },
        classList:{add(...v){v.forEach(x=>classes.add(x));},remove(x){classes.delete(x);},
          toggle(x,on){if(on)classes.add(x);else classes.delete(x);},contains(x){return classes.has(x);}}}
      );
    }
    return elements.get(id);
  }
  const state = {user:{id:'A',email:'a@example.test'}, cloudReady:true,
    cur:{id:'A-deck',cards:[{front:'PRIVATE A'}]}, cards:[{front:'PRIVATE A'}],
    idx:1,flipped:true,session:{private:true},editTarget:{id:'A-deck'},
    editCards:[{front:'PRIVATE A'}], editReturn:'study',notesMd:'PRIVATE A',
    quizState:{private:true},quizSource:{private:true},quizTimerInterval:1,progAiTimer:2,
    busy:true,pdfFiles:[],urlData:{text:'PRIVATE A'},decks:[],notesLib:[],todayTodos:[],
    localStorage:{getItem:k=>storage.has(k)?storage.get(k):null,setItem:(k,v)=>storage.set(k,v),
      removeItem:k=>storage.delete(k),key:i=>[...storage.keys()][i],get length(){return storage.size;}},
    Map, console:{warn(){}}, clearInterval:id=>calls.push(['clearTimer',id]),
    window:{FCSyncJournal:require('../lib/sync-journal'),navigator:{locks:{request:(_name,work)=>work()}},speechSynthesis:{cancel(){calls.push(['cancelSpeech']);}}},
    $,statusEl:{textContent:''},renderAuth(){},renderDecks(){calls.push(['renderDecks']);},
    renderNotesLib(){calls.push(['renderNotes']);},renderFileList(){},
    show:view=>calls.push(['show',view]),
    storageKey:base=>state.user?base+'::'+state.user.id:base,
    load:(key,fallback)=>JSON.parse(storage.get(key)||JSON.stringify(fallback)),
    loadDecks:()=>state.load(state.storageKey('fc_decks'),[]),
    loadNotes:()=>state.load(state.storageKey('fc_notes'),[]),
    saveDecks:()=>{const key=state.storageKey('fc_decks');writes.push(key);storage.set(key,JSON.stringify(state.decks));},
    saveNotes:()=>{const key=state.storageKey('fc_notes');writes.push(key);storage.set(key,JSON.stringify(state.notesLib));},
    Cloud:{onAuth:fn=>auth=fn,isConfigured:()=>true,
      listMyDecks:async()=>{calls.push(['listDecks']);return [];},
      listMyNotes:async()=>{calls.push(['listNotes']);return [];},
      bulkUpsert:async rows=>{calls.push(['pushDecks',rows]);return rows;},
      bulkUpsertNotes:async rows=>{calls.push(['pushNotes',rows]);return rows;}}
  };
  vm.createContext(state);
  vm.runInContext(section('let accountGeneration =','\n(function migrateIds()'), state);
  vm.runInContext(section('async function pullAndMerge()', '$("syncNow").onclick = pullAndMerge;'), state);
  return {state,$,storage,writes,calls,auth:u=>auth(u)};
}
test('logout scrubs study, editor, quiz, note DOM and memory without deleting libraries',()=>{
  const f=fixture();
  f.storage.set('fc_decks::A','[{"id":"A-deck"}]');
  f.storage.set('fc_notes::A','[{"id":"A-note"}]');
  f.storage.set('fc_decks','[{"id":"guest"}]');
  const before=[...f.storage];
  f.auth(null);
  for(const k of ['cur','session','editTarget','quizState','quizSource'])assert.equal(f.state[k],null,k);
  for(const k of ['cards','editCards'])assert.equal(f.state[k].length,0,k);
  assert.equal(f.state.notesMd,'');
  for(const id of ['front','back','editList','qbox','out','out2','noteTitle','genNoteTitle','summary'])
    assert.equal(f.$(id).textContent,'',id);
  assert.ok(f.$('quizSetupModal').classList.contains('hide'));
  assert.ok(f.$('quizLoading').classList.contains('hide'));
  assert.deepEqual([...f.storage],before);
  assert.equal(f.state.decks[0].id,'guest');
  assert.ok(f.calls.some(c=>c[0]==='cancelSpeech'));
});
test('account switch loads correct saved library and preserves both accounts',async()=>{
  const f=fixture();
  f.storage.set('fc_decks::A','[{"id":"A-deck"}]');
  f.storage.set('fc_notes::A','[{"id":"A-note"}]');
  f.storage.set('fc_decks::B','[{"id":"B-deck"}]');
  f.storage.set('fc_notes::B','[{"id":"B-note"}]');
  const pending=deferred();f.state.Cloud.listMyDecks=()=>pending.promise;
  f.auth({id:'B',email:'b@example.test'});
  assert.equal(f.state.decks[0].id,'B-deck');
  assert.equal(f.state.notesLib[0].id,'B-note');
  assert.equal(f.storage.get('fc_decks::A'),'[{"id":"A-deck"}]');
  pending.resolve([]);await new Promise(r=>setImmediate(r));
  assert.equal(f.storage.get('fc_decks::B'),'[{"id":"B-deck"}]');
});
for(const phase of ['deck-read','deck-push','note-read','note-push']) {
  test('account switch discards late '+phase+' results before cache/render/next operation',async()=>{
    const f=fixture(),d=deferred();
    f.state.busy=false;
    f.state.decks=phase==='deck-push'?[{id:'local-A'}]:[];
    f.state.notesLib=phase==='note-push'?[{id:'local-note-A'}]:[];
    const operation={'deck-read':'listMyDecks','deck-push':'bulkUpsert','note-read':'listMyNotes','note-push':'bulkUpsertNotes'}[phase];
    f.state.Cloud[operation]=()=>d.promise;
    const old=f.state.pullAndMerge();
    await new Promise(r=>setImmediate(r));
    // Auth callback invalidates A; B sync stays pending, with no writes of its own.
    f.state.Cloud.listMyDecks=()=>new Promise(()=>{});
    f.auth({id:'B',email:'b@example.test'});
    const writeCount=f.writes.length,callCount=f.calls.length;
    d.resolve([{id:'private-A',cards:[{front:'PRIVATE A'}]}]);
    await old;
    assert.equal(f.writes.length,writeCount);
    assert.equal(f.storage.has('fc_decks::B'),false);
    assert.equal(f.storage.has('fc_notes::B'),false);
    assert.equal(f.calls.length,callCount);
    assert.equal(f.state.decks.length,0);
    assert.equal(f.state.notesLib.length,0);
  });
}
test('A logout then A login invalidates the old session even with same user ID',async()=>{
  const f=fixture(),d=deferred();f.state.Cloud.listMyDecks=()=>d.promise;
  const old=f.state.pullAndMerge();f.auth(null);
  f.state.Cloud.listMyDecks=()=>new Promise(()=>{});
  f.auth({id:'A',email:'a@example.test'});
  d.resolve([{id:'stale-A'}]);await old;
  assert.equal(f.writes.length,0);
});
test('late rejected sync cannot replace next account status',async()=>{
  const f=fixture(),d=deferred(),started=deferred();
  f.state.Cloud.listMyDecks=()=>{started.resolve();return d.promise;};
  const old=f.state.pullAndMerge();
  await started.promise; // The scheduler has started and is awaiting this request.
  f.auth(null);
  const msg=f.state.statusEl.textContent;
  d.reject(Error('private A error'));await old;
  assert.equal(f.state.statusEl.textContent,msg);
});
test('sign-out before scheduled sync starts prevents the request entirely',async()=>{
  const f=fixture();let requests=0;
  f.state.Cloud.listMyDecks=async()=>{requests++;throw Error('must not start');};
  const old=f.state.pullAndMerge();f.auth(null);await old;
  assert.equal(requests,0);assert.equal(f.writes.length,0);
});
test('current-account request failure is caught and reported without claiming success',async()=>{
  const f=fixture();f.state.Cloud.listMyDecks=async()=>{throw Error('offline');};
  await f.state.pullAndMerge();
  assert.match(f.state.statusEl.textContent,/Cloud synchronization failed: offline/);
  assert.equal(f.writes.length,0);
});
test('same-account token refresh keeps active study and in-flight sync valid',async()=>{
  const f=fixture(),d=deferred();f.state.Cloud.listMyDecks=()=>d.promise;
  const old=f.state.pullAndMerge(),cur=f.state.cur;
  f.auth({id:'A',email:'a@example.test'});
  assert.equal(f.state.cur,cur);
  d.resolve([{id:'cloud-A'}]);await old;
  assert.equal(JSON.parse(f.storage.get('fc_decks::A'))[0].id,'cloud-A');
});
test('normal sync merges local and remote libraries into only current cache',async()=>{
  const f=fixture();f.state.decks=[{id:'local-A',created:1}];f.state.notesLib=[{id:'local-note-A',created:1}];
  f.state.Cloud.listMyDecks=async()=>[{id:'remote-A',created:2}];
  f.state.Cloud.listMyNotes=async()=>[{id:'remote-note-A',created:2}];
  await f.state.pullAndMerge();
  assert.equal(JSON.parse(f.storage.get('fc_decks::A')).length,2);
  assert.equal(JSON.parse(f.storage.get('fc_notes::A')).length,2);
  assert.deepEqual(f.writes,['fc_decks::A','fc_notes::A']);
  assert.ok(f.calls.some(c=>c[0]==='pushDecks'));
  assert.ok(f.calls.some(c=>c[0]==='pushNotes'));
});
test('guest startup keeps guest study state and never starts cloud sync',async()=>{
  const f=fixture();f.state.user=null;const cur=f.state.cur;
  f.auth(null);await f.state.pullAndMerge();
  assert.equal(f.state.cur,cur);
  assert.equal(f.calls.some(c=>c[0]==='listDecks'),false);
  assert.equal(f.writes.length,0);
});
test('delayed mixed quiz stops before sending another private-source request',async()=>{
  const f=fixture(),d=deferred();let count=0;
  f.state.quizTypeLabel=t=>t;
  f.state.generateQuizQuestions=async()=>{count++;return d.promise;};
  vm.runInContext(section('async function prepareQuizQuestions(', 'async function generateQuizQuestions('),f.state);
  const old=f.state.prepareQuizQuestions(['mc','tf'],2,{cards:[]});
  f.auth(null);d.resolve([{prompt:'PRIVATE A',correct:'A'}]);
  assert.equal((await old).length,0);assert.equal(count,1);
});
test('every inline script parses',()=>{
  const scripts=[...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(m=>!/\bsrc\s*=/.test(m[1]));
  assert.equal(scripts.length,2);scripts.forEach(m=>new vm.Script(m[2]));
});
for (const mode of ['flashcards', 'notes']) test('late '+mode+' generation cannot restore private content after logout',async()=>{
  const f=fixture(),d=deferred();
  Object.assign(f.state,{busy:false,sourceMode:'text',startProgress(){},setProgress(){},startAiPhase(){},
    fetch:()=>d.promise});
  f.$('rawText').value='Synthetic study material: plants convert light into chemical energy using photosynthesis.';
  f.$('mode').value=mode;
  vm.runInContext(section('async function generate()', '/* ========== decks'),f.state);
  const pending=f.state.generate();f.auth(null);
  d.resolve({ok:true,json:async()=>({cards:[{front:'PRIVATE A',back:'A'}],notes:'PRIVATE A'})});
  await pending;
  assert.equal(f.writes.length,0);
  assert.equal(f.state.notesMd,'');
  assert.equal(f.$('out2').textContent,'');
  assert.equal(f.state.cur,null);
});
test('late quiz setup result cannot reopen a cleared private quiz',async()=>{
  const f=fixture(),d=deferred();
  f.state.selectedQuizTypes=()=>['mc'];f.state.prepareQuizQuestions=()=>d.promise;
  f.$('quizCount').value='1';f.$('quizTimer').value='0';
  vm.runInContext(section('$("quizStartBtn").onclick = async () => {','async function prepareQuizQuestions('),f.state);
  const pending=f.$('quizStartBtn').onclick();f.auth(null);
  d.resolve([{prompt:'PRIVATE A',correct:'A'}]);await pending;
  assert.equal(f.state.quizState,null);assert.equal(f.state.quizSource,null);
  assert.ok(f.$('quizLoading').classList.contains('hide'));
});
test('failed local uploads retain account libraries',async()=>{
  const f=fixture();f.state.decks=[{id:'local-A'}];f.state.notesLib=[{id:'local-note-A'}];
  f.state.Cloud.bulkUpsert=async()=>{throw Error('offline');};
  f.state.Cloud.bulkUpsertNotes=async()=>{throw Error('offline');};
  await f.state.pullAndMerge();
  assert.equal(JSON.parse(f.storage.get('fc_decks::A'))[0].id,'local-A');
  assert.equal(JSON.parse(f.storage.get('fc_notes::A'))[0].id,'local-note-A');
});




