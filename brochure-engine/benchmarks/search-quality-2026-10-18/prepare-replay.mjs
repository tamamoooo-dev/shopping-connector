import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {dirname,posix,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {frontendModule} from './frontend-module.mjs';
const dir=new URL('./',import.meta.url),seen=new Set();
function baseline(path){
 if(seen.has(path))return;seen.add(path);
 const target=new URL('baseline/'+path,dir);
 const bytes=execFileSync('git',['show','8fe94ac:brochure-engine/src/'+path]);
 mkdirSync(dirname(target.pathname.replace(/^\/(.:)/,'$1')),{recursive:true});writeFileSync(target,bytes);
 for(const m of bytes.toString().matchAll(/(?:from\s*|import\s*)['"]([.][^'"]+)['"]/g))baseline(posix.normalize(posix.join(posix.dirname(path),m[1])));
}
if(!existsSync(new URL('baseline/engine.js',dir))||process.argv.includes('--refresh')){baseline('engine.js');baseline('storage/offerStore.js');}
const frontendRoot=resolve(process.argv.slice(2).find(a=>!a.startsWith('--'))||'../../live-shopping-assistant');
const oldStore=execFileSync('git',['show','8fe94ac:brochure-engine/src/storage/offerStore.js']).toString()
 .replace(/from\s*(['"])([.][^'"]+)\1/g,(_,q,path)=>`from ${q}${pathToFileURL(resolve('src/storage',path)).href}${q}`);
writeFileSync(new URL('store-before-alias.mjs',dir),oldStore);
await frontendModule(pathToFileURL(resolve(frontendRoot,'src')+'/'),new URL('frontend-baseline/',dir),path=>execFileSync('git',['show','59748de:src/'+path],{cwd:frontendRoot}));
console.log('Prepared exact engine 8fe94ac and frontend 59748de baselines; replay needs no credential.');
