// Marc.TCG — yuyu-tei restock watcher (runs on GitHub Actions, every ~10 min)
// Reads the wishlist from Supabase, checks each card's yuyu-tei stock,
// notifies via ntfy on a sold-out -> in-stock transition, and saves stock
// state back to Supabase (row id="restock-state") so the app can display it.
//
// Run: node scripts/restock-watcher.mjs   (NTFY_TOPIC via env var or arg)
import https from 'node:https';

const SUPABASE_URL = 'https://jiglwblfamhoaxayistu.supabase.co';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImppZ2x3YmxmYW1ob2F4YXlpc3R1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkxOTQ3MjYsImV4cCI6MjA5NDc3MDcyNn0.jXb_4j9pHfsPRYL04AT8116M2PqQJbFRrJKnliWqXfs';
const NTFY_TOPIC = process.env.NTFY_TOPIC || process.argv[2] || 'marc-tcg-restock-99a17b4000de';

function req(url, { method = 'GET', headers = {} } = {}, body = null) {
  return new Promise((resolve, reject) => {
    const r = https.request(new URL(url), { method, headers }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

const sbHeaders = { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' };
async function sbGet(id) {
  const { status, body } = await req(`${SUPABASE_URL}/rest/v1/card_collection?id=eq.${id}&select=cards`, { headers: sbHeaders });
  if (status !== 200) console.log(`  ! sbGet(${id}) HTTP ${status}: ${String(body).slice(0, 160)}`);
  let rows = [];
  try { rows = JSON.parse(body || '[]'); } catch { console.log(`  ! sbGet(${id}) non-JSON body: ${String(body).slice(0, 160)}`); }
  return (Array.isArray(rows) && rows[0]) ? rows[0].cards : null;
}
async function sbUpsert(id, cards) {
  const { status, body } = await req(`${SUPABASE_URL}/rest/v1/card_collection`, { method: 'POST', headers: { ...sbHeaders, Prefer: 'resolution=merge-duplicates,return=minimal' } }, JSON.stringify({ id, cards }));
  console.log(`  sbUpsert(${id}) -> HTTP ${status}${status >= 300 ? ' ' + String(body).slice(0, 200) : ''}`);
}

function parseCard(html) {
  let availability = null, price = null, name = null, code = null, image = null, count = null;
  const m = html.match(/<script type="application\/ld\+json">(\{"@context[^<]*?"@type":"Product"[^<]*?\})<\/script>/);
  if (m) { try { const j = JSON.parse(m[1]); name = j.name; code = j.description; image = j.image; if (j.offers) { price = j.offers.price ? Number(j.offers.price) : null; availability = j.offers.availability || ''; } } catch {} }
  const z = html.match(/sell_zaiko_pc[^>]*>([^<]*)</);
  if (z) { const cm = z[1].match(/(\d+)\s*点/); if (cm) count = Number(cm[1]); if (availability == null && /×/.test(z[1])) availability = 'OutOfStock'; }
  const inStock = availability ? /InStock/i.test(availability) : (count != null && count > 0);
  return { inStock, count, price, name, code, image, availability };
}

async function ntfy(payload) {
  if (!NTFY_TOPIC) { console.log('  (no ntfy topic — notification skipped)'); return; }
  const body = JSON.stringify({ topic: NTFY_TOPIC, ...payload });
  await req('https://ntfy.sh/', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, body);
}

(async () => {
  const wishlist = await sbGet('wishlist') || [];
  const prevRaw = await sbGet('restock-state');
  const prev = (prevRaw && typeof prevRaw === 'object' && !Array.isArray(prevRaw)) ? prevRaw : {};
  const next = {};
  const watched = wishlist.filter(w => w.yuyuUrl && w.yuyuUrl.trim());
  console.log(`[${new Date().toISOString()}] wishlist=${wishlist.length}, watched=${watched.length}`);

  for (const w of watched) {
    next[w.id] = prev[w.id];
    try {
      const { status, body } = await req(w.yuyuUrl.trim(), { headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
        'Referer': 'https://yuyu-tei.jp/',
        'Upgrade-Insecure-Requests': '1',
      } });
      if (status !== 200) { console.log(`  ${w.name}: HTTP ${status} - skipped`); continue; }
      const info = parseCard(body);
      const wasInStock = prev[w.id] ? prev[w.id].inStock : undefined;
      next[w.id] = { inStock: info.inStock, count: info.count, price: info.price, checkedAt: new Date().toISOString() };
      console.log(`  ${w.name}: ${info.inStock ? 'IN STOCK' : 'sold out'}${info.count != null ? ` (${info.count})` : ''}${info.price != null ? ` Y${info.price}` : ''}`);

      if (wasInStock === false && info.inStock === true) {
        const photo = w.hasImage
          ? `${SUPABASE_URL}/storage/v1/object/public/card-images/wish-${w.id}.jpg`
          : (info.image && !/noimage/.test(info.image) ? info.image : undefined);
        const code = w.code || info.code || '';
        const line1 = [w.rarity, code].filter(Boolean).join(' · ');
        const line2 = [info.price != null ? `¥${Number(info.price).toLocaleString()}` : '', info.count != null ? `${info.count} available` : ''].filter(Boolean).join(' · ');
        await ntfy({
          title: `🎉 Back in stock: ${w.name}`,
          message: [line1, line2, 'Tap to open on yuyu-tei'].filter(Boolean).join('\n'),
          tags: ['shopping_cart'],
          click: w.yuyuUrl,
          ...(photo ? { attach: photo } : {}),
        });
        console.log('    -> RESTOCK notification sent!');
      }
    } catch (e) { console.log(`  ${w.name}: error - ${e.message}`); }
  }

  await sbUpsert('restock-state', next);
  console.log('Saved restock-state.');
})();
