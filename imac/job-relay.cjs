// A fresh, job-bound handoff from the iMac host. Mounted read-only into one
// network-disabled container; never used as an across-job artifact cache.
const fs=require('node:fs'),crypto=require('node:crypto'),assert=require('node:assert/strict');
exports.createRegistryFetch=()=>{
 const bundle=JSON.parse(fs.readFileSync('/relay/bundle.json','utf8'));
 assert.equal(bundle.jobId,process.env.TEST_RUN,'Relay job mismatch');
 assert.equal(bundle.targetId,process.env.TARGET_EXTENSION,'Relay target mismatch');
 assert.equal(bundle.provenance?.relayKind,'fresh-download-host-relay','Invalid relay provenance');
 const bytes=Buffer.from(bundle.vsixBase64,'base64');
 assert(bytes.length>0&&bytes.length<=23*1024*1024,'Invalid relay size');
 assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),bundle.sha256,'Relay transport hash mismatch');
 assert.equal(bundle.metadata.version,bundle.expectedVersion,'Relay version mismatch');
 let consumed=false;
 const fetchRegistry=async url=>{
  if(url===`https://open-vsx.org/api/aryansudhir/${bundle.target}`)return new Response(JSON.stringify(bundle.metadata));
  if(url===bundle.metadata.files.sha256)return new Response(bundle.sha256);
  if(url===bundle.metadata.files.download){assert(!consumed,'Artifact already consumed');consumed=true;return new Response(bytes);}
  throw new Error('Unexpected relay resource');
 };
 fetchRegistry.provenance=Object.freeze({...bundle.provenance});
 return fetchRegistry;
};
