import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
const dir=new URL('./',import.meta.url);mkdirSync(new URL('images/',dir),{recursive:true});
const selected=JSON.parse(readFileSync(new URL('eligible.json',dir),'utf8'));
for(let i=0;i<selected.length;i++){
 const row=selected[i],response=await fetch(row.image);if(!response.ok)throw Error(`${i+1}: ${response.status}`);
 const bytes=Buffer.from(await response.arrayBuffer());writeFileSync(new URL(`images/${i+1}.jpg`,dir),bytes);
 row.reviewIndex=i+1;row.sha256=createHash('sha256').update(bytes).digest('hex');
}
writeFileSync(new URL('review-cases.json',dir),JSON.stringify(selected,null,2));console.log({downloaded:selected.length});
