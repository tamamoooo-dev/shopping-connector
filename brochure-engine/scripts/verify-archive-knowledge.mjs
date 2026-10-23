import fs from 'node:fs';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=new URL('../../../',import.meta.url),out=new URL('archive-knowledge-audit-2026-10-23/',root);
const summary=JSON.parse(fs.readFileSync(new URL('summary.json',out)));
const db=new DatabaseSync(new URL('product-knowledge.sqlite',out),{readOnly:true});
assert.equal(Object.values(db.prepare('PRAGMA integrity_check').get())[0],'ok');
assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
assert.equal(db.prepare('SELECT COUNT(*) n FROM observations').get().n,summary.observations);
assert.equal(summary.classified+summary.pendingClassification+summary.nonProductObservations,summary.observations);
assert.equal(db.prepare('SELECT COUNT(*) n FROM products WHERE product_type IS NULL OR aisle IS NULL').get().n,0);
assert.equal(db.prepare("SELECT COUNT(*) n FROM products WHERE id LIKE 'pr_%'").get().n,0);
const missingTranslations=db.prepare("SELECT id,name_en FROM brands WHERE status='canonical' AND (name_ar IS NULL OR name_ar='')").all();
assert.deepEqual(missingTranslations,[]);
for(const source of summary.sources){
 const digest=createHash('sha256').update(fs.readFileSync(new URL(source.file,root))).digest('hex');
 assert.equal(digest,source.sha256,'Source changed since build: '+source.file);
}
const productIds=new Set(JSON.parse(fs.readFileSync(new URL('product-knowledge-data/observations.json',root))).records.map(r=>r.product_id).filter(Boolean));
for(const r of db.prepare('SELECT DISTINCT registry_product_id id FROM observations WHERE registry_product_id IS NOT NULL').all())assert(productIds.has(r.id),'Archive projection cannot mint Registry identities');
const report={checkedAt:new Date().toISOString(),integrity:'ok',foreignKeys:'ok',observations:summary.observations,
 completeClassificationFields:true,canonicalArabicTranslations:true,sourceHashesUnchanged:true,registryIdsPreserved:true,published:false};
db.close();fs.writeFileSync(new URL('verification.json',out),JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
