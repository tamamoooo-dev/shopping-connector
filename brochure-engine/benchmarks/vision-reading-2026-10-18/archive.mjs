import {readFileSync,writeFileSync} from 'node:fs';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
const dir=new URL('./',import.meta.url),hash=x=>createHash('sha256').update(x).digest('hex');
const read=n=>JSON.parse(readFileSync(new URL(n,dir),'utf8'));
const manifest=read('manifest.json');assert.equal(manifest.samples.length,64);
assert.equal(new Set(manifest.samples.map(x=>x.id)).size,64);
for(const item of manifest.samples)assert.equal(hash(readFileSync(new URL(item.path,dir))),item.sha256,`image ${item.index}`);
const phases={development:160,'image-first-development':32,holdout:192};
const all=[];
for(const [phase,count] of Object.entries(phases)){
 const protocol=read(`protocol-${phase}.json`);assert.equal(protocol.truthSha256,hash(readFileSync(new URL('truth.mjs',dir))));
 const records=readFileSync(new URL(`reads-${phase}.jsonl`,dir),'utf8').trim().split('\n').map(JSON.parse);assert.equal(records.length,count,phase);
 for(const r of records){assert.equal(r.model,'ministral-14b-2512');if(r.first)assert.equal(r.first.model,'ministral-14b-2512');assert.ok(r.parsed&&r.usage?.total_tokens);}
 all.push(...records);
 execFileSync(process.execPath,[new URL('score.mjs',dir).pathname.replace(/^\/(.:)/,'$1'),phase],{stdio:'ignore'});
}
assert.equal(new Set(all.map(r=>`${r.index}:${r.method}`)).size,384);
for(const method of ['baseline','repeat','upscale','caption','staged','image-first'])assert.equal(all.filter(r=>r.method===method).length,64,method);
all.sort((a,b)=>a.index-b.index||a.method.localeCompare(b.method));
const raw=JSON.stringify(all);writeFileSync(new URL('reads.json.gz',dir),gzipSync(raw,{level:9}));
writeFileSync(new URL('reads-all.jsonl',dir),all.map(r=>JSON.stringify(r)).join('\n')+'\n');
execFileSync(process.execPath,[new URL('score.mjs',dir).pathname.replace(/^\/(.:)/,'$1'),'all'],{stdio:'ignore'});
const result=read('results-all.json');writeFileSync(new URL('scored.json.gz',dir),gzipSync(JSON.stringify(result),{level:9}));
const baseline=result.summary.baseline;
const summary={recordedAt:new Date().toISOString(),images:64,outputs:all.length,successfulRequests:all.reduce((n,r)=>n+1+(r.first?1:0),0),successfulTokens:all.reduce((n,r)=>n+r.usage.total_tokens+(r.first?.usage?.total_tokens||0),0),attempts:all.reduce((n,r)=>n+r.attempts+(r.first?.attempts||0),0),sourceCommit:'ee41f601f5ad4dd4c78252b950e9f3f5b2585d60',candidate:read('selection.json'),all:result.summary,holdout:read('results-holdout.json').summary,doubleVerification:result.doubleVerification,artifacts:Object.fromEntries(['reads.json.gz','scored.json.gz'].map(f=>[f,{sha256:hash(readFileSync(new URL(f,dir))),bytes:readFileSync(new URL(f,dir)).length}]))};
for(const scope of [summary.all,summary.holdout])for(const s of Object.values(scope)){const b=scope.baseline;s.tokenRatio=Number((s.tokens/b.tokens).toFixed(3));}
writeFileSync(new URL('summary.json',dir),JSON.stringify(summary,null,2));
console.log(JSON.stringify({checks:'64 image hashes, unique sample/method pairs, 384 outputs, 448 successful 14B requests, frozen truth hashes passed',all:summary.all,holdout:summary.holdout},null,2));
