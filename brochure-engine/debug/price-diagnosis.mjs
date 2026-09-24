// Read-only: are D4D offer prices now zero, since when, and where did they go?
const HOST = 'https://d4donline.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
async function search(company, slug, limit = 500) {
  const pageUrl = `${HOST}/en/saudi-arabia/riyadh/offers/${slug}`;
  const pr = await fetch(pageUrl, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
  const html = await pr.text();
  const csrf = (/name="_csrf-frontend" value="([^"]+)"/.exec(html) || [])[1];
  const cookie = (pr.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  const res = await fetch(`${HOST}/products/search`, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest', Referer: pageUrl, Cookie: cookie },
    body: new URLSearchParams({ search: '', offset: '0', limit: String(limit), company: String(company), country: 'SACR', '_csrf-frontend': csrf }),
  });
  return res.json();
}
const stores = [[63, 'lulu-hypermarket-63'], [62, 'carrefour-62'], [72, 'othaim-markets-72'], [556, 'city-flower-556'], [471, 'prime-supermarket-471'], [68, 'tamimi-market-68']];
let sample = null;
for (const [c, slug] of stores) {
  const d = await search(c, slug);
  const items = d.items || [];
  const byFlyer = {};
  for (const it of items) {
    const k = it.idoffer_company;
    const b = (byFlyer[k] ||= { n: 0, pricePos: 0, wasPos: 0, created: new Set() });
    b.n++;
    if (Number(it.price) > 0) b.pricePos++;
    if (Number(it.was_price) > 0) b.wasPos++;
    b.created.add(String(it.CreationDate).slice(0, 10));
    if (!sample && !(Number(it.price) > 0)) sample = it;
  }
  for (const b of Object.values(byFlyer)) b.created = [...b.created].sort().join(',');
  console.log(slug, 'items', items.length, JSON.stringify(byFlyer));
  if (d.price_range) console.log('  price_range', JSON.stringify(d.price_range));
  if (d.products) console.log('  products', JSON.stringify(d.products).slice(0, 400));
}
if (sample) {
  console.log('\n== zero-price sample: every field except branch lists ==');
  for (const [k, v] of Object.entries(sample)) {
    if (/branch/.test(k)) continue;
    console.log(`  ${k}: ${JSON.stringify(v).slice(0, 300)}`);
  }
}
