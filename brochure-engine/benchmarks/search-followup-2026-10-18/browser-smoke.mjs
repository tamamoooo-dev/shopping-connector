import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,writeFileSync,mkdtempSync} from 'node:fs';
import {resolve,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawn} from 'node:child_process';
const dir=new URL('./',import.meta.url),front=resolve(process.argv[2]);
const index=readFileSync(resolve(front,'index.html'),'utf8');
assert.ok(index.includes('type="importmap"'));
const smoke=`<script type="module">
try {
const [match,compare,market]=await Promise.all([import('./src/match.js'),import('./src/compare.js'),import('./src/marketplace.js')]);
const offer={id:'test',store:'test',nameAr:'كلوت جاميو هجين هجيز',category:'baby-diapers',brandSlug:'huggies',price:99.99,unitPrice:null};
const listing=compare.flyerListing(offer,'huggies diapers');
if(!listing || listing.up!==null || listing.name!==offer.nameAr || match.productFamily('وافل فراولة')!=='biscuit' || typeof market.createMarketplace!=='function')throw Error('browser matching/module check failed');
if(match.matchStage({name:'TR-MU570 Rechargeable Wireless Mouse',brand:'TRANDS'},'ماوس تراندز')<3 || match.productFamily('كريمة بندق بنده')!=='spread')throw Error('new follow-up matching missing');
if(!compare.flyerListing({id:'mouse',store:'lulu',name:'TR-MU570 Rechargeable Wireless Mouse',brandSlug:'trands',price:30},'ماوس تراندز'))throw Error('observed brand missing in browser');
document.body.dataset.qualityPass='true';
const pre=document.createElement('pre');pre.id='quality-result';pre.textContent=JSON.stringify({passed:true,name:listing.name,modules:performance.getEntriesByType('resource').map(r=>r.name).filter(n=>/src\\/(match|compare|marketplace)\\.js/.test(n))});document.body.append(pre);
}catch(error){document.body.dataset.qualityPass='false';const pre=document.createElement('pre');pre.textContent=error.stack;document.body.append(pre);}
</script>`;
const html=index.replace(/<script type="module" src="[^\"]*app\.js[^\"]*"><\/script>/,smoke);
const requested=[];
const oldMarketplace=execFileSync('git',['show','aa2addc:src/marketplace.js'],{cwd:front});
const server=createServer((request,response)=>{
 const url=new URL(request.url,'http://localhost');requested.push(url.pathname+url.search);
 if(request.method!=='GET'){response.writeHead(405);response.end();return;}
 if(url.pathname==='/quality-smoke.html'){response.setHeader('Content-Type','text/html');response.end(html);return;}
 const name=url.pathname.split('/').at(-1);
 if(!url.search&&['match.js','compare.js','marketplace.js'].includes(name)){
  response.setHeader('Content-Type','text/javascript');response.end(name==='marketplace.js'?oldMarketplace:readFileSync(new URL('frontend-baseline/'+name,dir)));return;
 }
 const file=resolve(front,'.'+url.pathname);
 if(!file.startsWith(front+'\\')&&!file.startsWith(front+'/')){response.writeHead(403);response.end();return;}
 try{response.setHeader('Content-Type',extname(file)==='.js'?'text/javascript':extname(file)==='.css'?'text/css':'application/octet-stream');response.end(readFileSync(file));}catch{response.writeHead(404);response.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const profile=mkdtempSync(fileURLToPath(new URL('browser-profile-',dir)));
const child=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--no-proxy-server','--host-resolver-rules=MAP * 0.0.0.0, EXCLUDE 127.0.0.1, EXCLUDE localhost','--user-data-dir='+profile,'--virtual-time-budget=10000','--dump-dom',`http://127.0.0.1:${server.address().port}/quality-smoke.html`],{windowsHide:true,stdio:['ignore','pipe','pipe']});
let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);
const timeout=setTimeout(()=>child.kill(),45000);
await new Promise(r=>child.on('close',r));clearTimeout(timeout);server.close();
writeFileSync(new URL('browser-smoke.html',dir),out);writeFileSync(new URL('browser-smoke.log',dir),err);
assert.ok(out.includes('data-quality-pass="true"'),'real browser module loading and matching: '+out.slice(-1500));
for(const file of ['match.js','compare.js','marketplace.js']){assert.ok(requested.includes('/src/'+file+'?v=20261018.search2'));assert.ok(!requested.includes('/src/'+file),'stale unversioned module was avoided');}
writeFileSync(new URL('browser-smoke.json',dir),JSON.stringify({checkedAt:new Date().toISOString(),passed:true,simulatedOldCachedModules:true,productionNetworkDisabled:true,requested},null,2));
console.log('Chrome passed: actual module graph, stale-module simulation, recovered offer, unchanged display name and withheld unit price.');
