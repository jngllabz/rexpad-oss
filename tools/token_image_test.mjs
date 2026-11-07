// Will a launched coin have an image anywhere outside this site?
//
// ⛔ TWO INDEPENDENT FAILURES, EITHER OF WHICH IS FATAL AND NEITHER OF WHICH RAISES AN ERROR.
//
//  1. THE ON-CHAIN METADATA URI. Every wallet, scanner, bot and terminal finds a token's image by
//     fetching the URI in its metadata. $BITE and $REXWEEN shipped with `uri=""`, so there was
//     nothing to fetch. These mints are created with TokenAuthorityOption.Immutable and a null
//     update authority — verified on $BITE: isMutable=false, updateAuthority=11111…111 — so the URI
//     CANNOT BE SET AFTERWARDS BY ANYONE. It is written at creation or it is never written. Those
//     two coins are imageless off-site permanently; the fix only protects future launches.
//
//  2. THE ARTWORK ITSELF. /api/chain/meta saved the upload to a file and recorded "/img/x.png".
//     dbc/confirm then did saveDbcLaunch({ ...body }) over `image=excluded.image`, and body.image
//     is the client's raw data: URL — so it overwrote the path with 632 KB of base64 on every DBC
//     launch. NO EXTERNAL PLATFORM CAN USE A data: URL, so even a working URI would have pointed at
//     something unusable.
//
//   node tools/token_image_test.mjs
import fs from 'node:fs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

const srv = fs.readFileSync('server.mjs', 'utf8');
const met = fs.readFileSync('lib/meteora.mjs', 'utf8');
const idx = fs.readFileSync('lib/indexer.mjs', 'utf8');

console.log('\n── the URI is set at creation, the only moment it can be');
{
  ok(/uriBase = ''/.test(met), 'buildLaunch accepts a uriBase');
  // buildCurveWithMarketCap is used in an EARLIER function, so anchoring on it finds nothing after
  // buildLaunch — take the declaration up to the next export instead.
  const fn = /export async function buildLaunch\{?[\s\S]*?(?=\nexport )/.exec(met)?.[0] || '';
  ok(/if \(uriBase && !uri\)/.test(fn), 'it derives the uri when one is not supplied');
  ok(/baseMint\.publicKey\.toBase58\(\)\}\.json/.test(fn), 'from the mint it just generated');
  // Set after the keypair exists, before the curve is built into the create instruction.
  const at = fn.indexOf('uriBase && !uri'), gen = fn.indexOf('baseMint = Keypair.generate()');
  ok(gen > -1 && at > gen, 'after the mint keypair exists, not before');
  ok(/uriBase: `\$\{originOf\(req\)\}\/api\/meta`/.test(srv), 'the launch route passes the canonical origin');
}

console.log('\n── the JSON an external app fetches');
{
  ok(/\/api\\\/meta\\\/\[1-9A-HJ-NP-Za-km-z\]\{32,44\}\\\.json/.test(srv), 'there is a /api/meta/<mint>.json route');
  const route = /if \(\/\^\\\/api\\\/meta[\s\S]*?return res\.end\(body\);/.exec(srv)?.[0] || '';
  ok(route.length > 0, 'the route body is found');
  ok(/'access-control-allow-origin': '\*'/.test(route),
    'it sends CORS — a browser wallet fetches it cross-origin and fails silently without it');
  ok(/'cache-control': 'public, max-age=\d+'/.test(route), 'and is cacheable, unlike the rest of the API');
  ok(/t\.image\.startsWith\('data:'\)/.test(route),
    'it refuses to emit a data: URL — a JSON that "has an image" nobody can load only looks fixed');
  ok(/external_url/.test(route) && /properties/.test(route), 'it carries the standard token-JSON fields');
}

console.log('\n── the artwork is a file, never an inline blob');
{
  const confirm = /sub === 'dbc\/confirm'\)([\s\S]*?)\n      \}/.exec(srv)?.[1] || '';
  ok(/saveImage\(body\.image\)/.test(confirm), 'dbc/confirm puts the upload through saveImage');
  // ⛔ ASSERT THE ORDER, NOT THE EXACT ARGUMENT LIST. This used to match the literal text
  // `creator: w, name, symbol, image })`, which pins every future field added to that call —
  // appending hookProgram broke it while the property it stands for was untouched. What actually
  // matters is that `image` is passed AFTER `...body`, so the spread's raw data: URL is overwritten
  // by the saved path rather than the other way round.
  const call = /saveDbcLaunch\(\{([^}]*)\}\)/.exec(confirm)?.[1] || '';
  ok(call.includes('...body'), 'saveDbcLaunch still spreads the request body');
  ok(call.indexOf('image') > call.indexOf('...body'),
    'and passes the saved PATH after it, so the spread cannot reintroduce the raw data: URL');
  ok(/COALESCE\(excluded\.image, tokens\.image\)/.test(idx),
    'a call carrying no image keeps the artwork already on the row rather than blanking it');
  // The /img files are fetched by other origins too.
  ok(/'\/img\/'\)[\s\S]{0,400}access-control-allow-origin/.test(srv), 'served images carry CORS as well');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
