#!/usr/bin/env node
/** Build the browser's compact sample index from immutable capture evidence. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root=path.resolve(import.meta.dirname,'..');
const input=path.resolve(root,process.argv[2] || 'docs/animation/data/expanded-captures.json');
const destination=path.join(root,'docs/animation/panorama-samples.js');
const relative=path.relative(root,input).split(path.sep).join('/');
if(relative.startsWith('../') || path.isAbsolute(relative))throw Error('Capture evidence must be inside the workspace');
const inputBytes=fs.readFileSync(input);
const raw=JSON.parse(inputBytes);
if(!Array.isArray(raw.frames) || !raw.frames.length || !raw.stepBindings)throw Error('Expected raw frames and stepBindings');
const frameById=new Map();
const frames={};
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function assert(condition,message){if(!condition)throw Error(message);}
function readBytes(read){
  const bytes=read.hex || read.bytes;
  assert(typeof bytes==='string' && /^[0-9a-f]*$/i.test(bytes) && bytes.length===read.length*2,`Invalid bytes at ${read.address}`);
  return bytes;
}
function attribution(read){return read.attribution || read;}
function regionAt(address){
  const n=BigInt(address);
  return [[0x400n,'ivt'],[0x500n,'bda'],[0x7c00n,'low'],[0x7e00n,'boot'],[0x10000n,'loader-low'],[0xa0000n,'setup'],[0xc0000n,'vga'],[0x100000n,'rom'],[0x1000000n,'decompressor'],[0x3000000n,'kernel'],[0x20000000n,'ram']].find(([end])=>n<end)?.[1] || null;
}
for(const [i,frame] of raw.frames.entries()){
  assert(frame.cpu && typeof frame.captureId==='string' && typeof frame.sessionId==='string',`Frame ${i} has no capture attribution`);
  assert(!frameById.has(frame.frameId),`Duplicate frame ID ${frame.frameId}`);
  frameById.set(frame.frameId,frame);
  const memory=(frame.memory || []).map(m=>m.coverage==='recorded'?({...m,bytes:readBytes(m)}):({...m}));
  const physical=(raw.physicalReads || []).filter(m=>{
    const a=attribution(m);return a.sessionId===frame.sessionId && a.captureId===frame.captureId && a.frameId===frame.frameId;
  }).map(m=>({...m,bytes:readBytes(m),captureId:frame.captureId,region:m.region || regionAt(m.address)}));
  for(const read of physical)assert(read.addressSpace==='physical',`Physical read ${read.address} lacks physical address space`);
  const combined=[...memory];
  for(const read of physical)if(!combined.some(m=>m.addressSpace===read.addressSpace && m.address===read.address && m.length===read.length))combined.push(read);
  frames[`frame-${frame.frameId}`]={
    sessionId:frame.sessionId,epoch:frame.epoch,frameId:frame.frameId,captureId:frame.captureId,
    capturedAt:frame.committedAt || frame.capturedAt || raw.capturedAt, cpu:frame.cpu,
    source:frame.source,stop:frame.stop,os:frame.os || null,memory:combined,
    translations:(raw.translations || []).filter(t=>attribution(t).sessionId===frame.sessionId && attribution(t).captureId===frame.captureId),
    originalPath:`${relative}#/frames/${i}`,memoryCoverage:frame.coverage?.memory || 'selected-pages',
    note:'同一次启动的真实停点；扩展寄存器与物理窗口绑定该停止屏障。',
  };
}
const bindings={};
for(const [stepId,binding] of Object.entries(raw.stepBindings)){
  assert(binding && Number.isInteger(binding.frameId),`Invalid binding ${stepId}`);
  const frame=frameById.get(binding.frameId);
  assert(frame,`Missing frame ${binding.frameId} for ${stepId}`);
  assert(['entry','after','before','checkpoint','waiting'].includes(binding.position),`Missing sampling position for ${stepId}`);
  if(binding.address)assert(BigInt(binding.address)===BigInt(frame.cpu.linearPc || frame.stop.pc),`PC does not match ${stepId}`);
  const before=Number.isInteger(binding.beforeFrameId)?frameById.get(binding.beforeFrameId):null;
  if(Number.isInteger(binding.beforeFrameId))assert(before && before.sessionId===frame.sessionId && before.frameId<frame.frameId,`Invalid before endpoint for ${stepId}`);
  bindings[stepId]={...binding,evidenceKey:`frame-${frame.frameId}`,evidenceBeforeKey:before?`frame-${before.frameId}`:null};
}
for(const read of raw.physicalReads || []){
  const a=attribution(read);const frame=frameById.get(a.frameId);
  assert(frame && frame.sessionId===a.sessionId && frame.captureId===a.captureId,`Orphan physical read ${read.address}`);
  readBytes(read);
}
const lastFrame=raw.frames.at(-1);
const lowMemorySamples=(raw.physicalReads || []).filter(m=>{
  const a=attribution(m);return a.frameId===lastFrame.frameId && BigInt(m.address)<0x100000n;
}).map(m=>({...m,...attribution(m),region:m.region || regionAt(m.address),bytes:readBytes(m),hex:readBytes(m),kind:'recorded',note:m.note || '本次完成停点的只读物理内存样本；先前停点的字节另在对应帧内。'}));
const index={schema:'oslab.panorama-samples/2',capturedAt:raw.capturedAt,source:relative,sourceSha256:digest(inputBytes),sessionIds:[...new Set(raw.frames.map(f=>f.sessionId))],frames,bindings,lowMemorySamples,unboundSteps:raw.unboundSteps || [],terminal:raw.terminal || null};
const source='/** Generated by scripts/build-panorama-samples.mjs; edit the capture plan, not captured values. */\nexport default '+JSON.stringify(index,null,2)+';\n';
fs.writeFileSync(destination,source);
const coverage={schema:'oslab.panorama-sampling-coverage/1',capturedAt:raw.capturedAt,source:relative,sourceSha256:index.sourceSha256,frames:raw.frames.length,sampledSteps:Object.keys(bindings).length,physicalReads:(raw.physicalReads || []).length,sessionIds:index.sessionIds,bindings,unboundSteps:index.unboundSteps};
fs.writeFileSync(path.join(root,'docs/animation/data/sampling-coverage.json'),JSON.stringify(coverage,null,2)+'\n');
console.log(JSON.stringify({output:destination,frames:coverage.frames,sampledSteps:coverage.sampledSteps,physicalReads:coverage.physicalReads,unboundSteps:coverage.unboundSteps.length}));
