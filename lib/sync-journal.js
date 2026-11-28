/* Durable per-account sync. No credentials or database configuration are stored. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FCSyncJournal = api;
})(typeof window === "undefined" ? globalThis : window, function (root) {
  "use strict";
  const clone = x => JSON.parse(JSON.stringify(x));
  function getStudyAnalytics() {
    if (root && root.FCStudyAnalytics) return root.FCStudyAnalytics;
    if (typeof require === "function") return require("./study-analytics");
    throw Error("Study analytics module is unavailable.");
  }
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
    function enqueue(account,entity,type,value,releaseHold=false) {
      if (!account.userId) return null;
      if (!isCurrent(account)) return null;
      const id = type === "delete" ? value : value.id;
      if (!["decks","notes"].includes(entity) || !["upsert","delete"].includes(type) || typeof id !== "string") throw Error("Invalid sync operation.");
      if(type==="upsert" && !releaseHold && read(marker(account,entity,id,"hold"))) {
        write(marker(account,entity,id,"hold"),value);return null;
      }
      const token=String(Date.now()).padStart(16,"0")+"-"+String(++sequence).padStart(8,"0")+"-"+Math.random().toString(36).slice(2);
      const op={entity,type,id,token,value:type==="upsert"?clone(value):null};
      write(prefix(account)+"op::"+token,op);
      if(type==="delete") {
        const held=read(marker(account,entity,id,"hold"));
        if(held) {
          rememberConflict(account,entity,id,null,held);
          storage.removeItem(marker(account,entity,id,"hold"));
        }
      }
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
      record.remote = remote ? clone(remote) : record.remote;
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
        if(pending.has(local.id) || read(marker(account,entity,local.id,"deleted")) || read(marker(account,entity,local.id,"hold")))continue;
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
          const remaining=ops(account).length + ["decks","notes"].reduce((n,e)=>n+keys(prefix(account)+"hold::"+e+"::").length,0);
          return {pending:remaining,conflicts:decks.conflicts+notes.conflicts,failed:decks.failed||notes.failed};
        });
      };
      const next=tail.then(task,task);tail=next.catch(()=>{});
      return next;
    }

    function conflicts(account) {
      if(!account.userId || !isCurrent(account))return [];
      return ["decks","notes"].flatMap(entity=>keys(prefix(account)+"conflict::"+entity+"::").map(key=>{
        const id=decodeURIComponent(key.split("::").pop()),record=read(key),op=latest(account,entity).get(id);
        if(!op || op.type!=="upsert")return null;
        return {entity,id,versions:clone(record.versions),local:clone(op.value),
          remote:record.remote||record.versions[record.versions.length-1],
          revision:JSON.stringify([record,op.token])};
      }).filter(Boolean));
    }
    function backup(account,libraries,studyHistory,studyHistorySources) {
      if(!isCurrent(account))throw Error("Account changed. Export again.");
      const entries=account.userId?keys(prefix(account)).map(key=>{
        const suffix=key.slice(prefix(account).length),parts=suffix.split("::"),raw=read(key);
        let value;
        if(parts[0]==="op") value={entity:raw.entity,type:raw.type,id:raw.id,token:raw.token,value:raw.type==="upsert"?data(raw.entity,raw.value):null};
        else if(["conflict","archive"].includes(parts[0]))value={versions:raw.versions.map(v=>data(parts[1],v))};
        else if(["base","hold"].includes(parts[0]))value=data(parts[1],raw);
        else if(parts[0]==="deleted")value={token:raw.token};
        else throw Error("Unknown sync journal entry.");
        return {key:suffix,value};
      }):[];
      const analytics=getStudyAnalytics();
      const history=analytics.validateHistory(analytics.normalizeHistory(
        studyHistory===undefined?analytics.createHistory():studyHistory
      ));
      if(studyHistorySources!==undefined && !Array.isArray(studyHistorySources))
        throw Error("Invalid study-history source backup.");
      const sources=(studyHistorySources||[]).map(source=>{
        if(!source || typeof source.sourceId!=="string" ||
           !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(source.sourceId))
          throw Error("Invalid study-history source backup.");
        return {sourceId:source.sourceId,history:analytics.validateHistory(source.history)};
      });
      if(sources.length>32 || new Set(sources.map(source=>source.sourceId)).size!==sources.length)
        throw Error("Study-history source backup contains duplicates or too many devices.");
      return {format:"flushcard",version:4,ownerId:account.userId||null,
        decks:libraries.decks.map(v=>clone(data("decks",v))),notes:libraries.notes.map(v=>clone(data("notes",v))),
        studyHistory:clone(history),studyHistorySources:clone(sources),journal:entries};
    }
    function resolve(account,review,choice,apply) {
      const work=async()=>{
        if(!isCurrent(account))throw Error("Account changed. Review conflicts again.");
        if(!lock)throw Error("Conflict resolution requires Web Locks.");
        return lock("fc-sync-"+account.userId,async()=>{
          function unchanged() {
            if(!isCurrent(account))throw Error("Account changed. Review conflicts again.");
            const now=conflicts(account).find(x=>x.entity===review.entity && x.id===review.id);
            if(!now || now.revision!==review.revision)throw Error("Local version changed. Review the conflict again.");
            return now;
          }
          const current=unchanged();
          const acknowledgements=ops(account).filter(op=>op.entity===review.entity && op.id===review.id).map(op=>op.key);
          if(!["local","remote"].includes(choice))throw Error("Choose a local or cloud version.");
          const rows=await (review.entity==="decks"?cloud.listMyDecks():cloud.listMyNotes());
          unchanged();
          const remote=rows.find(x=>x.id===review.id);
          if(!remote || !same(review.entity,remote,current.remote) || remote._revision!==current.remote._revision) {
            if(remote)rememberConflict(account,review.entity,review.id,current.local,remote);
            throw Error("Cloud version changed. Sync and review the conflict again.");
          }
          let confirmed=remote;
          if(choice==="local") {
            const expected=remote._revision;
            if(typeof expected!=="string" || !expected)throw Error("Cloud revision unavailable. Export copies before retrying.");
            confirmed=await cloud.resolveVersion(review.entity,current.local,expected,account.userId);
            unchanged();
            if(!confirmed)throw Error("Cloud version changed. Sync and review again.");
          }
          // Preserve every unselected version before retiring the active conflict.
          const archiveKey=marker(account,review.entity,review.id,"archive");
          const archived=read(archiveKey)||{versions:[]};
          for(const value of [...current.versions,current.local,remote,confirmed])
            if(!archived.versions.some(v=>same(review.entity,v,value)))archived.versions.push(clone(value));
          write(archiveKey,archived);
          write(marker(account,review.entity,review.id,"base"),confirmed);
          apply(review.entity,review.id,clone(confirmed)); // Must persist or throw before acknowledgement.
          for(const key of acknowledgements)storage.removeItem(key);
          storage.removeItem(marker(account,review.entity,review.id,"conflict"));
          return confirmed;
        });
      };
      const next=tail.then(work,work);tail=next.catch(()=>{});return next;
    }
    function holdRecovery(account,entity,value) {
      if(!account.userId || !isCurrent(account))return;
      write(marker(account,entity,value.id,"hold"),value);
    }
    function uploadRecovered(account) {
      if(!isCurrent(account))throw Error("Account changed.");
      for(const entity of ["decks","notes"])for(const k of keys(prefix(account)+"hold::"+entity+"::")) {
        enqueue(account,entity,"upsert",read(k),true);storage.removeItem(k);
      }
    }

    return {enqueue,sync,pending:account=>ops(account),same,conflicts,resolve,backup,holdRecovery,uploadRecovered};
  }

  function recoverBackup(input,account,newId) {
    if(!input || typeof input!=="object" || JSON.stringify(input).length>12000000)throw Error("Invalid or oversized backup.");
    const modern=input.version===2 || input.version===3 || input.version===4;
    if(input.version!==undefined && !modern)throw Error("Unsupported backup version.");
    if(modern && (input.format!=="flushcard" || input.ownerId!==(account.userId||null)))throw Error("Backup belongs to another account. Sign in to its owner before recovery.");
    const analytics=input.version===3 || input.version===4?getStudyAnalytics():null;
    const studyHistory=input.version===3 || input.version===4?analytics.validateHistory(input.studyHistory):null;
    let studyHistorySources=null;
    if(input.version===4) {
      if(!Array.isArray(input.studyHistorySources) || input.studyHistorySources.length>32)
        throw Error("Invalid study-history source backup.");
      const seenSources=new Set();
      studyHistorySources=input.studyHistorySources.map(source=>{
        if(!source || typeof source.sourceId!=="string" ||
           !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(source.sourceId) ||
           seenSources.has(source.sourceId))
          throw Error("Invalid study-history source backup.");
        seenSources.add(source.sourceId);
        return {sourceId:source.sourceId,history:analytics.validateHistory(source.history)};
      });
    }
    const result={decks:[],notes:[],recoveryCopies:0,studyHistory,studyHistorySources},seen=new Set(),ids=new Set();
    function add(entity,item,recovered) {
      if(!item || typeof item!=="object")throw Error("Malformed backup record.");
      if(result.decks.length+result.notes.length>=2000)throw Error("Too many recovery records.");
      const str=(s,max)=>{if(typeof s!=="string" || s.length>max)throw Error("Invalid backup text.");return s;};
      let clean;
      if(entity==="decks") {
        if(!Array.isArray(item.cards)||item.cards.length>10000)throw Error("Invalid cards.");
        clean={name:str(item.name,200),cards:item.cards.map(c=>{
          const card={front:str(c.front,100000),back:str(c.back,100000)};
          if(c.srs && typeof c.srs==="object")card.srs=Object.fromEntries(Object.entries(c.srs).filter(([k,v])=>["interval","ease","reps","lapses","due","last"].includes(k)&&typeof v==="number"&&Number.isFinite(v)));
          return card;
        }),color:typeof item.color==="string"&&/^#[a-f0-9]{6}$/i.test(item.color)?item.color:null,isPublic:false,slug:null};
      }else clean={title:str(item.title,200),md:str(item.md,4000000)};
      const signature=entity+JSON.stringify(canonical(clean));
      if(seen.has(signature))return;
      seen.add(signature);
      const id=newId();if(typeof id!=="string"||ids.has(id))throw Error("Recovery ID collision.");
      ids.add(id);clean.id=id;clean.created=Date.now();
      result[entity].push(clean);if(recovered)result.recoveryCopies++;
    }
    const decks=Array.isArray(input)?input:input.decks,notes=Array.isArray(input)?[]:input.notes||[];
    if(!Array.isArray(decks)||!Array.isArray(notes))throw Error("Invalid backup libraries.");
    decks.forEach(d=>add("decks",d,false));notes.forEach(n=>add("notes",n,false));
    if(modern) {
      if(!Array.isArray(input.journal)||input.journal.length>10000)throw Error("Invalid backup journal.");
      for(const entry of input.journal) {
        if(!entry || typeof entry.key!=="string" || !entry.value || typeof entry.value!=="object")throw Error("Invalid journal entry.");
        const parts=entry.key.split("::"),kind=parts[0],value=entry.value;
        if(kind==="op") {
          if(!["decks","notes"].includes(value.entity)||!["upsert","delete"].includes(value.type))throw Error("Invalid pending operation.");
          if(value.type==="upsert")add(value.entity,value.value,true);
        }else if(["conflict","archive"].includes(kind)) {
          if(!["decks","notes"].includes(parts[1])||!Array.isArray(value.versions))throw Error("Invalid preserved versions.");
          value.versions.forEach(v=>add(parts[1],v,true));
        }else if(kind==="hold") {
          if(!["decks","notes"].includes(parts[1]))throw Error("Invalid recovered record.");
          add(parts[1],value,true);
        }else if(!["deleted","base"].includes(kind))throw Error("Unknown journal entry.");
      }
    }
    return result; // Never imports operation IDs, owners, publication state or deletion actions.
  }

  return {create,same,recoverBackup};
});




