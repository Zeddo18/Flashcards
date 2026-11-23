/* Durable per-account sync. No credentials or database configuration are stored. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FCSyncJournal = api;
})(typeof window === "undefined" ? globalThis : window, function () {
  "use strict";
  const clone = x => JSON.parse(JSON.stringify(x));
  // Compare only fields supported by cloud.js; normalize object key ordering.
  function canonical(x) {
    if (Array.isArray(x)) return x.map(canonical);
    if (x && typeof x === "object") return Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])]));
    return x;
  }
  function data(entity, x) {
    return entity === "decks"
      ? {id:x.id,name:x.name,color:x.color||null,cards:x.cards||[],created:x.created,
         isPublic:!!x.isPublic,slug:x.slug||null}
      : {id:x.id,title:x.title,md:x.md,created:x.created};
  }
  const same = (entity,a,b) => !!a && !!b && JSON.stringify(canonical(data(entity,a))) === JSON.stringify(canonical(data(entity,b)));
  function create({storage, cloud, isCurrent, lock}) {
    let tail = Promise.resolve(), sequence = 0;
    const prefix = account => "fc_sync::" + encodeURIComponent(account.userId) + "::";
    function read(key) {
      const raw = storage.getItem(key);
      if (raw === null) return null;
      try { return JSON.parse(raw); } catch { throw Error("Sync journal is unreadable. Export your local backup before repairing storage."); }
    }
    function write(key,value) {
      try { storage.setItem(key,JSON.stringify(value)); }
      catch { throw Error("Local storage failed. This change is not safely queued. Export a backup and free storage before retrying."); }
    }
    function keys(start) {
      const result=[];
      for(let i=0;i<storage.length;i++){const k=storage.key(i);if(k && k.startsWith(start))result.push(k);}
      return result.sort();
    }
    function ops(account) {
      return keys(prefix(account)+"op::").map(key=>({key,...read(key)}));
    }
    function marker(account,entity,id,kind) {
      return prefix(account)+kind+"::"+entity+"::"+encodeURIComponent(id);
    }
    function enqueue(account,entity,type,value) {
      if (!account.userId) return null;
      if (!isCurrent(account)) return null;
      const id = type === "delete" ? value : value.id;
      if (!["decks","notes"].includes(entity) || !["upsert","delete"].includes(type) || typeof id !== "string") throw Error("Invalid sync operation.");
      const token=String(Date.now()).padStart(16,"0")+"-"+String(++sequence).padStart(8,"0")+"-"+Math.random().toString(36).slice(2);
      const op={entity,type,id,token,value:type==="upsert"?clone(value):null};
      write(prefix(account)+"op::"+token,op);
      return op;
    }
    function latest(account,entity) {
      const map=new Map();
      for(const op of ops(account))if(op.entity===entity)map.set(op.id,op);
      return map;
    }
    function rememberConflict(account,entity,id,local,remote) {
      const key=marker(account,entity,id,"conflict");
      // Preserve earlier remote variants too; never silently replace a unique copy.
      const record=read(key)||{versions:[]};
      for(const value of [local,remote])if(value && !record.versions.some(x=>same(entity,x,value)))record.versions.push(clone(value));
      write(key,record);
    }
    function compact(account,entity) {
      const newest=latest(account,entity);
      for(const op of ops(account))if(op.entity===entity && newest.get(op.id).token!==op.token)storage.removeItem(op.key);
      return newest;
    }
    async function entitySync(account,entity,getLocal) {
      const remote=await (entity==="decks"?cloud.listMyDecks():cloud.listMyNotes());
      if(!isCurrent(account))return null;
      const remotes=new Map(remote.map(x=>[x.id,x]));
      let pending=latest(account,entity);
      for(const local of getLocal()[entity]) {
        if(pending.has(local.id) || read(marker(account,entity,local.id,"deleted")))continue;
        const server=remotes.get(local.id),base=read(marker(account,entity,local.id,"base"));
        if(!server)enqueue(account,entity,"upsert",local);
        else if(same(entity,local,server))write(marker(account,entity,local.id,"base"),server);
        else if(!base || !same(entity,local,base))enqueue(account,entity,"upsert",local);
      }
      pending=compact(account,entity);
      let failed=false,conflicts=0;
      for(const op of pending.values()) {
        if(!isCurrent(account))return null;
        const server=remotes.get(op.id),base=read(marker(account,entity,op.id,"base"));
        // Without an unchanged confirmed baseline, preserve both sides and stop.
        if(op.type==="upsert" && server && !same(entity,server,op.value) ) {
          rememberConflict(account,entity,op.id,op.value,server);conflicts++;continue;
        }
        try {
          let confirmed=op.value;
          if(op.type==="delete") {
            if (server) rememberConflict(account,entity,op.id,null,server);
            await (entity==="decks"?cloud.deleteDeck(op.id):cloud.deleteNote(op.id));
          } else if(!same(entity,server,op.value)) {
            const rows=await (entity==="decks"?cloud.bulkUpsert([op.value]):cloud.bulkUpsertNotes([op.value]));
            if(!rows || !rows.some(row=>row.id===op.id))throw Error("Cloud did not confirm the saved record.");
            confirmed=rows.find(row=>row.id===op.id);
          }
          if(!isCurrent(account))return null;
          if(op.type==="delete") {
            write(marker(account,entity,op.id,"deleted"),{token:op.token});
            remotes.delete(op.id);
          } else {
            write(marker(account,entity,op.id,"base"),confirmed);
            storage.removeItem(marker(account,entity,op.id,"deleted"));
            remotes.set(op.id,confirmed);
          }
          // Exact-key acknowledgement cannot consume edits queued during await.
          storage.removeItem(op.key);
        } catch(error) {
          if(!isCurrent(account))return null;
          // Storage errors must fail loudly; a network error leaves the op intact.
          if(/storage|journal/i.test(error.message))throw error;
          failed=true;
        }
      }
      if(!isCurrent(account))return null;
      const current=latest(account,entity);
      // Retain current local content, but accept remote updates when local equals base.
      for(const local of getLocal()[entity]) {
        const base=read(marker(account,entity,local.id,"base"));
        if(!remotes.has(local.id) || !base || !same(entity,local,base))remotes.set(local.id,local);
      }
      for(const k of keys(prefix(account)+"deleted::"+entity+"::"))remotes.delete(decodeURIComponent(k.split("::").pop()));
      for(const op of current.values())if(op.type==="delete")remotes.delete(op.id);else remotes.set(op.id,op.value);
      return {items:[...remotes.values()].sort((a,b)=>(b.created||0)-(a.created||0)),failed,conflicts};
    }
    function sync(account,getLocal,apply) {
      if(!account.userId)return Promise.resolve(null);
      const task=async()=>{
        if(!isCurrent(account))return null;
        if(!lock)throw Error("Safe cloud retry requires browser Web Locks support. Your local library is unchanged.");
        return lock("fc-sync-"+account.userId,async()=>{
          if(!isCurrent(account))return null;
          const decks=await entitySync(account,"decks",getLocal);
          if(!decks || !isCurrent(account))return null;
          apply("decks",decks.items);
          const notes=await entitySync(account,"notes",getLocal);
          if(!notes || !isCurrent(account))return null;
          apply("notes",notes.items);
          const remaining=ops(account).length;
          return {pending:remaining,conflicts:decks.conflicts+notes.conflicts,failed:decks.failed||notes.failed};
        });
      };
      const next=tail.then(task,task);tail=next.catch(()=>{});
      return next;
    }
    return {enqueue,sync,pending:account=>ops(account),same};
  }
  return {create,same};
});


