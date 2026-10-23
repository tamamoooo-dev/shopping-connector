import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
const dir=new URL('../../../archive-knowledge-audit-2026-10-23/',import.meta.url);
const summary=JSON.parse(fs.readFileSync(new URL('summary.json',dir)));
const db=new DatabaseSync(new URL('product-knowledge.sqlite',dir),{readOnly:true});
const products=db.prepare(`SELECT p.id,p.name_en en,p.name_ar ar,p.title_source titleSource,p.product_type type,
 c.name_ar aisle,c.department dept,p.classification_source method,p.review_required review,p.product_status status,
 p.size_printed size,EXISTS(SELECT 1 FROM observations o WHERE o.product_id=p.id AND o.title_review=1) titleReview,GROUP_CONCAT(DISTINCT COALESCE(b.name_ar,b.name_en)) brands
 FROM products p JOIN classifications c ON c.id=p.aisle
 LEFT JOIN product_brands pb ON pb.product_id=p.id LEFT JOIN brands b ON b.id=pb.brand_id
 GROUP BY p.id`).all();
const brands=db.prepare(`SELECT b.id,b.name_en en,b.name_ar ar,b.status,COUNT(DISTINCT pb.product_id) products
 FROM brands b LEFT JOIN product_brands pb ON pb.brand_id=b.id GROUP BY b.id ORDER BY products DESC`).all();
db.close();
const sources={retailer_category:'تصنيف المنشور',english_dictionary:'قاموس إنجليزي',arabic_dictionary:'قاموس عربي',
 archive_consensus:'اتفاق مشاهدات مؤرشفة',explicit_category_terms:'مفردات الصنف',image_review:'مراجعة الصورة',
 brand_archive_consensus:'ارتباط البراند — يحتاج مراجعة',product_title_dictionary:'قاموس اسم المنتج',retailer_ocr_terms:'نص المصدر — يحتاج مراجعة'};
const payload=JSON.stringify({products,brands}).replaceAll('<','\\u003c');
fs.writeFileSync(new URL('review.html',dir),`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>قاعدة معرفة المنتجات — أولوية القروسري</title>
<style>body{font:16px system-ui;background:#f5f7fa;color:#15283e;margin:24px}main{max-width:1300px;margin:auto}p{line-height:1.9}h1{font-size:26px}input,select,button{font:inherit;padding:10px;border:1px solid #a4b5c9;border-radius:7px;margin:5px}table{border-collapse:collapse;width:100%;background:white}td,th{padding:12px;text-align:right;border-bottom:1px solid #d9e1eb;vertical-align:top}strong{display:block}small{display:block;color:#52637a}a{color:#174e92}.warning{color:#865314}#stats{background:white;padding:18px;border-radius:12px}</style>
<main><h1>قاعدة معرفة المنتجات — القروسري أولًا</h1><div id="stats">
<p><b>${summary.observations.toLocaleString('en')} مشاهدة مؤرشفة</b> من ${summary.stores} متجرًا و${summary.brochures} منشورًا، مرتبطة بـ${summary.products.toLocaleString('en')} سجل منتج داخلي. منها ${summary.groceryPriority.observations.toLocaleString('en')} مشاهدة في أقسام الغذاء.</p>
<p>القاموس يضم ${summary.canonicalBrands} براندًا باسم عربي وإنجليزي. توجد أيضًا ${summary.observedBrandCandidates.toLocaleString('en')} صيغة براند مرصودة تحتاج مراجعة؛ بعضها أسماء أصناف أو منشأ أو أخطاء قراءة، ولا تُعامل كبراند معتمد.</p>
<p>توجد خانة تصنيف لكل مشاهدة منتج (${summary.classified.toLocaleString('en')}). استُبعدت صورة واحدة ثبت أنها تذييل صفحة. اكتمال التغطية لا يعني دقة 100٪؛ مصدر التصنيف ظاهر أدناه، والاستنتاج من البراند أو نص المصدر يحتاج مراجعة.</p>
<p>المراجعة البصرية المسجلة: 517 حالة. أغلب بقية التصنيفات مصدرها المنشور أو القاموس، وليست مراجعة بصرية جديدة لكل الأرشيف. العمل محلي ولم يُنشر.</p>
<p><a href="../panda-reading-audit-2026-10-23/review-grocery.html">صور تجربة بنده ومقارنة القراءة</a> · <a href="product-knowledge.sqlite">قاعدة البيانات الكاملة</a> · <a href="summary.json">تقرير التغطية ومصادره</a> · <a href="brand-review.json">الأسماء المرصودة للمراجعة</a></p></div>
<select id="mode" aria-label="نوع السجل"><option value="products">المنتجات</option><option value="brands">البراندات</option></select>
<select id="scope" aria-label="الأولوية"><option value="grocery">القروسري — الغذاء أولًا</option><option value="household">المنزل والعناية والطفل</option><option value="all">جميع الأقسام</option></select>
<select id="state" aria-label="حالة السجل"><option value="all">كل الحالات</option><option value="review">تحتاج مراجعة</option><option value="canonical">المعتمد في القاموس</option></select>
<input id="query" type="search" placeholder="بحث بالمنتج أو البراند" aria-label="بحث"><p id="count" role="status"></p><table><thead></thead><tbody></tbody></table><button id="prev">السابق</button><button id="next">التالي</button></main>
<script id="data" type="application/json">${payload}</script><script>
const data=JSON.parse(document.getElementById('data').textContent),methods=${JSON.stringify(sources)},food=new Set(['fresh','dairy-eggs','beverages','pantry','snacks-sweets','bakery','frozen']);
const mode=document.getElementById('mode'),scope=document.getElementById('scope'),state=document.getElementById('state'),query=document.getElementById('query'),tbody=document.querySelector('tbody');let page=0;
const foodBrands=new Set(data.products.filter(p=>food.has(p.dept)).flatMap(p=>(p.brands||'').split(',')));
const homeBrands=new Set(data.products.filter(p=>['baby','beauty-health','household'].includes(p.dept)).flatMap(p=>(p.brands||'').split(',')));
function cell(tr,value,tag='td'){const c=document.createElement(tag);c.textContent=value||'—';tr.append(c);return c}
function render(){const isBrand=mode.value==='brands',q=query.value.trim().toLowerCase();const rows=data[mode.value].filter(r=>
 (!q||[r.en,r.ar,r.brands,r.id].join(' ').toLowerCase().includes(q))&&
 (scope.value==='all'||(isBrand?(scope.value==='grocery'?foodBrands:homeBrands).has(r.ar||r.en):(scope.value==='grocery'?food.has(r.dept):['baby','beauty-health','household'].includes(r.dept))))&&
 (state.value==='all'||(isBrand?(state.value==='canonical'?r.status==='canonical':r.status==='observed_needs_review'):(state.value==='review'?r.review||r.titleReview||r.titleSource!=='dictionary':r.titleSource==='dictionary'))));
 page=Math.max(0,Math.min(page,Math.ceil(rows.length/100)-1));tbody.replaceChildren();const head=document.querySelector('thead');head.replaceChildren();const tr=document.createElement('tr');for(const label of isBrand?['البراند','الحالة','عدد المنتجات']:['الاسم','البراند والحجم','التصنيف','مصدر التصنيف'])cell(tr,label,'th');head.append(tr);
 for(const r of rows.slice(page*100,page*100+100)){const tr=document.createElement('tr'),name=cell(tr,'');name.textContent='';const ar=document.createElement('strong');ar.textContent=r.ar||'اسم عربي يحتاج مراجعة';name.append(ar);const en=document.createElement('strong');en.textContent=r.en||'—';en.dir='ltr';name.append(en);const id=document.createElement('small');id.textContent=r.id;name.append(id);if(!isBrand){const note=document.createElement('small');note.textContent=r.titleSource==='dictionary'?(r.titleReview?'تفاصيل الاسم تحتاج مراجعة':'اسم مبني من القاموس'):r.titleSource==='vision_fallback'?'اسم فيجن — يحتاج مراجعة':'لا يوجد اسم عربي متاح';if(r.titleReview||r.titleSource!=='dictionary')note.className='warning';name.append(note);}
 if(isBrand){cell(tr,{canonical:'معتمد بالقاموس',observed_needs_review:'صيغة مرصودة تحتاج مراجعة',non_brand_attribute:'صفة أو منشأ'}[r.status]);cell(tr,String(r.products));}
 else{cell(tr,(r.brands||'—')+' · '+(r.size||'حجم غير متاح'));cell(tr,r.aisle);cell(tr,methods[r.method]||r.method);}tbody.append(tr)}
 document.getElementById('count').textContent=rows.length+' سجل · الصفحة '+(page+1)+' من '+Math.max(1,Math.ceil(rows.length/100));document.getElementById('prev').disabled=page===0;document.getElementById('next').disabled=(page+1)*100>=rows.length;}
for(const el of [mode,scope,state,query])el.addEventListener(el===query?'input':'change',()=>{page=0;render()});document.getElementById('next').onclick=()=>{page++;render()};document.getElementById('prev').onclick=()=>{page--;render()};render();
</script></html>`);
console.log(JSON.stringify({products:products.length,brands:brands.length,report:'review.html'}));
