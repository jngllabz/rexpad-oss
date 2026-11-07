// Finding the REX NFT in somebody's wallet, so their profile picture can be the one they already
// own rather than another file to upload.
//
// This reads Metaplex metadata straight off the chain rather than through an indexing API. The
// reason is deliberate: a DAS provider is a paid key and an outage we do not control, and the only
// question being asked here — "does this wallet hold an NFT from OUR collection" — is answerable
// from accounts the RPC already serves. It costs two getTokenAccountsByOwner calls and one
// getMultipleAccounts.
//
// Trust: an NFT counts only when its collection field is BOTH our collection AND marked verified.
// `verified` is set by the collection authority signing, so it cannot be forged. Without that check
// anyone could mint a token that merely NAMES our collection and wear our art as their badge.
import { PublicKey } from '@solana/web3.js';
import { cfg, warn } from './config.mjs';
import * as CH from './chain.mjs';

const METADATA_PROGRAM = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

export const collection = () => cfg.rexNftCollection || '';
export const enabled = () => !!collection();

const metadataPda = (mint) =>
  PublicKey.findProgramAddressSync([Buffer.from('metadata'), METADATA_PROGRAM.toBuffer(), mint.toBuffer()], METADATA_PROGRAM)[0];

/**
 * Decode the fields we need out of a Metaplex Metadata account.
 *
 * Hand-rolled because the alternative is pulling in the whole Token Metadata SDK to read four
 * fields. Borsh is positional, so everything before `collection` has to be walked even though it is
 * thrown away — and any mis-step would silently land on the wrong bytes, so every read is bounds
 * checked and the whole thing returns null rather than guessing.
 */
export function decodeMetadata(buf) {
  try {
    let o = 0;
    const need = (n) => { if (o + n > buf.length) throw new Error('short'); };
    const u8 = () => { need(1); return buf[o++]; };
    const str = () => { need(4); const n = buf.readUInt32LE(o); o += 4; need(n); const s = buf.slice(o, o + n).toString('utf8').replace(/\0+$/, ''); o += n; return s; };
    const key = u8();
    if (key !== 4) return null;                 // 4 = MetadataV1; anything else is not this account
    o += 32 + 32;                               // updateAuthority, mint
    const name = str(), symbol = str(), uri = str();
    o += 2;                                     // sellerFeeBasisPoints
    if (u8()) { need(4); const n = buf.readUInt32LE(o); o += 4; o += n * 34; }   // creators: 32 + verified + share
    o += 2;                                     // primarySaleHappened, isMutable
    if (u8()) o += 1;                           // editionNonce
    if (u8()) o += 1;                           // tokenStandard
    let coll = null;
    if (u8()) { const verified = !!u8(); need(32); coll = { verified, key: new PublicKey(buf.slice(o, o + 32)).toBase58() }; o += 32; }
    return { name, symbol, uri, collection: coll };
  } catch { return null; }
}

/** Every NFT mint the wallet holds exactly one of. */
async function nftMintsOf(wallet) {
  const owner = new PublicKey(wallet);
  const out = [];
  for (const programId of [TOKEN, TOKEN_2022]) {
    const r = await CH.conn().getParsedTokenAccountsByOwner(owner, { programId }).catch(() => null);
    for (const { account } of r?.value || []) {
      const info = account.data?.parsed?.info;
      const amt = info?.tokenAmount;
      // An NFT is the one-of-one case: a single indivisible unit. Decimals matter as much as the
      // amount — a fungible token someone happens to hold exactly 1 of is not an NFT.
      if (amt && amt.decimals === 0 && amt.amount === '1') out.push(info.mint);
    }
  }
  return out;
}

/**
 * The REX NFTs this wallet holds, newest-looking first. Empty when the collection is not configured,
 * when the wallet holds none, or when the RPC cannot answer — a profile picture is not worth
 * failing a sign-in over, so every failure here degrades to "no NFT found".
 */
export async function rexNftsOf(wallet) {
  if (!enabled() || !CH.enabled()) return [];
  try {
    const want = collection();
    const mints = await nftMintsOf(wallet);
    if (!mints.length) return [];
    const found = [];
    // getMultipleAccounts caps at 100 per call.
    for (let i = 0; i < mints.length; i += 100) {
      const slice = mints.slice(i, i + 100);
      const infos = await CH.conn().getMultipleAccountsInfo(slice.map((m) => metadataPda(new PublicKey(m))));
      infos.forEach((acc, j) => {
        if (!acc?.data) return;
        const md = decodeMetadata(acc.data);
        // Verified AND ours. Either alone is worthless: unverified means anyone could claim it.
        if (md?.collection?.verified && md.collection.key === want) found.push({ mint: slice[j], name: md.name, symbol: md.symbol, uri: md.uri });
      });
    }
    return found;
  } catch (e) { warn('rex nfts', e.message); return []; }
}

/**
 * Resolve an NFT's picture. The on-chain `uri` points at a JSON document whose `image` is the
 * artwork, so this is one fetch — bounded, because the URI is attacker-controlled in the general
 * case and we are the ones making the request.
 */
export async function imageOf(nft) {
  if (!/^https:\/\//i.test(nft?.uri || '')) return null;
  try {
    const ac = AbortSignal.timeout(6000);
    const r = await fetch(nft.uri, { signal: ac, redirect: 'follow' });
    if (!r.ok) return null;
    const len = Number(r.headers.get('content-length') || 0);
    if (len > 512_000) return null;
    const j = await r.json();
    const img = String(j?.image || '');
    return /^https:\/\//i.test(img) ? img : null;
  } catch { return null; }
}

/** The NFTs plus their artwork, which is what a profile picker needs. */
export async function rexProfileOptions(wallet) {
  const nfts = await rexNftsOf(wallet);
  return (await Promise.all(nfts.slice(0, 24).map(async (n) => ({ ...n, image: await imageOf(n) }))))
    .filter((n) => n.image);
}
