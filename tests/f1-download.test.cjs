'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const APP = path.resolve(__dirname, '../app');
const { Workbench } = require(path.join(APP, 'workbench-service.js'));
const { AttachmentStore } = require(path.join(APP, 'attachment-store.js'));
for (const mode of ['valid','missing','deleted']) test('completed download attachment: '+mode, async () => {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'f1-download-')));
  const store=new AttachmentStore(), events=[]; let exists=mode!=='missing';
  let done; const end=new Promise(r=>done=r);
  const wb=new Workbench({ROOT:root, runs:{list:()=>[]}, defaultDir:()=>root, isPathAllowed:()=>true,
    sse:(_,ev)=>events.push(ev),endRes:()=>done(),
    attachmentSession:sid=>sid==='session-A'&&exists?sid:null,
    registerAttachment:record=>store.register(record)});
  wb._fetchFollow=async()=>{if(mode==='deleted') exists=false;return new Response('hello 中文',{headers:{'content-type':'text/plain'}});};
  try {
    const started=wb.startDownload({url:'https://example.com/hello.txt',filename:'中文 空格.txt',dir:root,sessionId:'session-A'},{});
    assert.equal(started.ok,true); await end;
    const completed=events.find(e=>e.status==='completed'); assert.ok(completed);
    if(mode==='valid') {
      assert.ok(completed.attachment); assert.equal(completed.attachment.sessionId,'session-A');
      assert.equal(store.resolve(completed.attachment.attachmentId,'session-A',{action:'open'}).ok,true);
      assert.equal(completed.attachment.sha256,completed.sha256);
      assert.match(completed.attachment.sourceId,/^download:dl_/);
    } else {assert.equal(completed.attachment,null); assert.ok(completed.attachmentError);}
  } finally {
    // Only remove the canonical temporary fixture created above, never downloaded/user data elsewhere.
    if(wb.saveTimer) clearTimeout(wb.saveTimer);
    fs.rmSync(root,{recursive:true,force:true});
  }
});
