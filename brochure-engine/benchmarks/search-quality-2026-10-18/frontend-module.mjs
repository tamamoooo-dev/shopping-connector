import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,posix} from 'node:path';
export async function frontendModule(source,root,readSource=(path)=>readFileSync(new URL(path,source))){
 const saved=new Set();
 function save(path){if(saved.has(path))return;saved.add(path);const bytes=readSource(path);const target=new URL(path,root);mkdirSync(dirname(target.pathname.replace(/^\/(.:)/,'$1')),{recursive:true});writeFileSync(target,bytes);for(const m of bytes.toString().matchAll(/from\s*['"]([.][^'"]+)['"]/g))save(posix.normalize(posix.join(posix.dirname(path),m[1])));}
 for(const p of ['match.js','compare.js','featured.js'])save(p);
 const marketplace=readSource('marketplace.js').toString();
 const pure=marketplace.slice(marketplace.indexOf('function entryRel('),marketplace.indexOf('// --- cards'));
 const imports=marketplace.match(/import \{[^;]*\} from '\.\/(?:match|featured)\.js';/g).join('\n');
 writeFileSync(new URL('ranking.mjs',root),imports+'\nconst t=()=>"";\n'+pure+'\nexport {makeComparator,dedupeFlyers,entryBand,entryStage};');
 return {compare:await import(new URL('compare.js',root)),match:await import(new URL('match.js',root)),rank:await import(new URL('ranking.mjs',root)),featured:await import(new URL('featured.js',root))};
}
