/**
 * One-shot: dump the full Keepa response for one ASIN so we can see
 * where review count + rating actually live. Used because the
 * verifyKeepaSpec.ts inspection logic missed them on every ASIN.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

const KEEPA_API_KEY = process.env.KEEPA_API_KEY;
const ASIN = process.argv[2] ?? 'B07BGLT25K'; // default to toilet paper sample

async function main() {
  if (!KEEPA_API_KEY) {
    console.error('Set KEEPA_API_KEY in .env.local');
    process.exit(1);
  }
  const url = `https://api.keepa.com/product?key=${KEEPA_API_KEY}&domain=1&asin=${ASIN}&stats=1&history=1`;
  const res = await fetch(url);
  const data = await res.json();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = data as any;
  const product = d.products?.[0];

  if (!product) {
    console.log('No product returned:', JSON.stringify(d, null, 2).slice(0, 2000));
    return;
  }

  // Top-level scalar fields — what's actually in product?
  console.log(`Top-level product fields:`);
  for (const key of Object.keys(product).sort()) {
    const value = product[key];
    const t = typeof value;
    if (value === null) {
      console.log(`  ${key.padEnd(30)} = null`);
    } else if (t === 'number' || t === 'boolean' || t === 'string') {
      const s = String(value).slice(0, 80);
      console.log(`  ${key.padEnd(30)} = (${t}) ${s}`);
    } else if (Array.isArray(value)) {
      console.log(`  ${key.padEnd(30)} = array, length ${value.length}, first: ${JSON.stringify(value[0]).slice(0, 80)}`);
    } else {
      console.log(`  ${key.padEnd(30)} = (${t}) ${JSON.stringify(value).slice(0, 80)}`);
    }
  }

  // stats subobject
  if (product.stats) {
    console.log(`\nproduct.stats fields:`);
    for (const key of Object.keys(product.stats).sort()) {
      const v = product.stats[key];
      if (Array.isArray(v)) {
        console.log(`  ${key.padEnd(20)} = array len ${v.length}, first 3: ${JSON.stringify(v.slice(0, 3))}`);
      } else {
        console.log(`  ${key.padEnd(20)} = ${JSON.stringify(v).slice(0, 120)}`);
      }
    }
  }

  // csv array — find non-null entries
  if (Array.isArray(product.csv)) {
    console.log(`\nproduct.csv (${product.csv.length} entries):`);
    for (let i = 0; i < product.csv.length; i++) {
      const arr = product.csv[i];
      if (Array.isArray(arr) && arr.length > 0) {
        // Keepa csv format: alternating timestamp,value pairs. Show last value.
        const lastValue = arr[arr.length - 1];
        const len = arr.length;
        console.log(`  csv[${i.toString().padStart(2)}] len ${len.toString().padStart(4)}  last value: ${lastValue}`);
      }
    }
  }

  // Also save the full thing to disk for inspection
  const fs = await import('node:fs/promises');
  const path = `keepa-sample-${ASIN}.json`;
  await fs.writeFile(path, JSON.stringify(d, null, 2));
  console.log(`\nFull response written to ${path} (${JSON.stringify(d).length} bytes)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
