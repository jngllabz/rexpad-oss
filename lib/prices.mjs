// Quote assets + live USD prices (DexScreener, 60 s cache, static fallback so the UI never shows "…").
import { warn } from './config.mjs';
export const QUOTES = {
  // SOL leads while liquidity builds (Elio, 3 Oct). This object's order IS the order the launch
  // screen shows the chips in, so the swap has to happen here and not only in QUOTE_TABS.
  SOL:  { symbol: 'SOL',  name: 'Solana',          mint: 'So11111111111111111111111111111111111111112', decimals: 9, color: '#9945FF', category: 'native', usd: 210 },
  REX:  { symbol: 'REX',  name: 'REX',             mint: 'CmQJNJ185pjzQoebPbcqZu1kTykHxJbn4gER1Af7pump', decimals: 6, color: '#22c55e', category: 'native', usd: 0.00019, logo: '/brand/rex-glyph.png?v=2' },
  USDC: { symbol: 'USDC', name: 'USD Coin',        mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, color: '#2775CA', category: 'stable', usd: 1 },
  GP:   { symbol: 'GP',   name: 'RuneScape Gold',  mint: 'HTmQz7My6MehV7bjhJ6jde8nDND1yvsz68d24LP7YgUQ', decimals: 6, color: '#FFC24D', category: 'custom', usd: 0.0065, transferFeeBps: 300, payout: true },
  // $WIF — Fco, 4 Oct: "Pair to wif too important to get my wif whales". Mint, program, decimals
  // and supply verified on chain before being added: legacy SPL, 6dp, fixed supply, ~$6.9M in its
  // deepest pool. A wrong mint here is a pool nobody can trade and a launch that fails after the
  // user has already signed.
  WIF:  { symbol: 'WIF',  name: 'dogwifhat',       mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', decimals: 6, color: '#C8A2C8', category: 'native', usd: 0.2487 },
  // $PENGU — Elio, 5 Oct, in a list of seven. It is the only one of the seven that clears the same
  // bar WIF did. Verified on chain before being added, not from a symbol search: legacy SPL
  // (Tokenkeg), 6dp, 76,722,794,033 supply, and BOTH mint and freeze authority are null — fixed
  // supply, nobody can mint more and nobody can freeze a holder. Deepest Solana pool ~$4.3M.
  //
  // ⛔ THE OTHER SIX WERE NOT ADDED, and the numbers are why: $NEAR's deepest Solana pool is
  // ~$14K and $SHIB's ~$128K — the same range as the leveraged tokens rejected below, where a
  // launch priced against them is unusable. $BTC does not trade on Solana under that symbol at all
  // (it is wBTC / cbBTC / zBTC), and the $WXT contract supplied was an 0x EVM address, which cannot
  // be a Solana mint. $CARDS (~$335K) and $PEPE (~$332K) are marginal and share their tickers with
  // decoys, so they need the same on-chain verification this one got before they go in.
  PENGU: { symbol: 'PENGU', name: 'Pudgy Penguins', mint: '2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv', decimals: 6, color: '#5FC8F5', category: 'native', usd: 0.009665 },
  // LEVERAGE. Julz, 4 Oct: "stonk also has leverage pairs as options". Searched Solana for
  // leveraged products with liquidity that could actually support a pair, and JLP is the only one —
  // $2.6M liquidity and ~$700K daily volume, where every 2x/3x-style token found sat under $5K and
  // would make any launch priced against it unusable. Solana simply does not have the leveraged
  // token market some other chains do; JLP (Jupiter's perps LP) is the real instrument.
  //
  // ⚠️ UNLIKE EVERY OTHER QUOTE HERE, JLP HAS A LIVE MINT AND FREEZE AUTHORITY
  // (AVzP2GeRmqGphJsMxWoqjpUifPpCret7LqWhD8NWQK49). That is inherent to what it is — the token is
  // minted and burned as people enter and exit the pool — but it means the issuer can freeze
  // accounts, so it is not trustless the way SOL or a fixed-supply memecoin is. Surfaced in the UI
  // rather than buried here, because a launcher picking their pair deserves to know.
  JLP:  { symbol: 'JLP',  name: 'Jupiter Perps LP', mint: '27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4', decimals: 6, color: '#8B5CF6', category: 'leverage', usd: 4.89, note: 'Leveraged exposure to the Jupiter perps pool. ⚠️ The issuer can mint AND FREEZE accounts.' },
  // Hylo's leveraged tokens — the ones Julz pointed at on stonk. Every mint below came from
  // JUPITER'S token list, not a DexScreener name search: that search returned a decoy "xSOL" with
  // zero liquidity that was nonetheless routable, which is exactly how a wrong mint gets shipped.
  // There is also a completely unrelated "xBTC" (OKX Wrapped BTC) with a bigger pool than Hylo's —
  // same ticker, different asset. Each of these was then verified on chain: legacy SPL, 6dp, and
  // crucially NO FREEZE AUTHORITY, which makes them safer than JLP. They do carry a mint authority,
  // which is inherent — the protocol mints and redeems them.
  xSOL: { symbol: 'xSOL', name: 'Hylo Leveraged SOL',  mint: '4sWNB8zGWHkh6UnmwiEtzNxL4XrN7uK9tosbESbJFfVs', decimals: 6, color: '#14F195', category: 'leverage', usd: 0.0946, note: 'Leveraged SOL. ~$940K liquidity — the deepest leveraged pair here. Protocol can mint and redeem; it cannot freeze.' },
  xBTC: { symbol: 'xBTC', name: 'Hylo Leveraged BTC',  mint: '2zCo6bUowJMvr89ajxuWsPadAqJ2F9akCkxumNsSdgsL', decimals: 6, color: '#F7931A', category: 'leverage', usd: 2.2105, note: 'Leveraged BTC. ~$184K liquidity. Not to be confused with OKX Wrapped BTC, which uses the same ticker.' },
  xHYPE:{ symbol: 'xHYPE',name: 'Hylo Leveraged HYPE', mint: '7ga6rtE9qSb3wdEiDCpTu2kHqoGVfT52jD8ign1rYTvx', decimals: 6, color: '#2DD4A7', category: 'leverage', usd: 2.3059, note: '⚠️ Thin: a 0.1 SOL swap already moves it 4.4%. Fine for a small launch, punishing for a large one.' },
  // META — the Stonk cohort the spec aims the first launches at. Mints resolved from the live
  // DexScreener book and checked against wash pairs (a pair whose "liquidity" is half the whole
  // market cap is not a market), then ranked by 24h volume across every pair the mint trades in.
  // `payout: true` — the odd one out in this tab and the reason the tab is not the rule: read on
  // mainnet 26 Oct, $STONK is a LEGACY SPL mint with no mint authority and no freeze authority,
  // while the four below it are Token-2022 mints that take 1-3% out of every transfer.
  STONK:  { symbol: 'STONK',  name: 'STONK',           mint: '6GmAFSYs4gk3FDao5FzzySQpPZaWsa4rUJHacpMpUNgx', decimals: 9, color: '#4ade80', category: 'meta',  usd: 0.2502, payout: true },
  ZCAT:   { symbol: 'ZCAT',   name: 'Anonymous Cat',   mint: 'HcRLc9VDgjLeK154xDawfb1dmVJ98DoSqcwTHGqiDeJR', decimals: 9, color: '#a78bfa', category: 'meta',  usd: 0.03867, transferFeeBps: 300, payout: true },
  SI:     { symbol: 'SI',     name: 'Super Inu',       mint: 'DEW9dSN6QpWyNthphCpMmAbZP1Q4cEKR9xQXAri98WDP', decimals: 6, color: '#fb923c', category: 'meta',  usd: 0.04468, transferFeeBps: 100, payout: true },
  MASK:   { symbol: 'MASK',   name: 'Nullmask',        mint: 'HuAXPyDWDaMYFKuwQHpqL1oPnj93zdzWmtvFGzCeCUa7', decimals: 6, color: '#60a5fa', category: 'meta',  usd: 0.04954, transferFeeBps: 300, payout: true },
  ALLINU: { symbol: 'ALLINU', name: 'ALLINU',          mint: '4MMQY9bwkxxTtsK3W227Q5ABT6yFY8Pmn9Ze7wmAXKY8', decimals: 6, color: '#f472b6', category: 'meta',  usd: 0.007859, transferFeeBps: 100, payout: true },
  // ---------------------------------------------------------------- CARDS. Cyrus, 9 Oct.
  //
  // Flagged here on 5 Oct as "marginal at ~$335K and shares its ticker with decoys, needs the same
  // on-chain verification PENGU got before it goes in". It got it, and it is no longer marginal:
  // $3.46M of liquidity and $5.56M of daily volume, deeper than NVDAx and deeper than every stock
  // below. Resolved from Jupiter's verified list, not a ticker search, then read off the mint:
  // LEGACY SPL, 6dp, and BOTH MINT AND FREEZE AUTHORITY ARE NULL — fixed supply, nobody can mint
  // more and nobody can freeze a holder. That makes it cleaner than every tokenised stock here,
  // all of which can be frozen by their issuer. 0.29% impact on a 2.5 SOL buy.
  //
  // `payout: true` — re-read on mainnet 26 Oct for the holder-payout question, which is a different
  // question from the pair one above: legacy SPL, 82 bytes, mint authority null, freeze authority
  // null. A mint that short has no TLV region, so it cannot carry a transfer fee or a permanent
  // delegate however its issuer later feels about it.
  CARDS: { symbol: 'CARDS', name: 'Collector Crypt', mint: 'CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp', decimals: 6, color: '#f59e0b', category: 'custom', usd: 0.2750, payout: true },
  // ---------------------------------------------------------------- $SANTA. Julz asked for it in
  // the basket on 26 Oct and the owner's answer was "build the gross-up so santa works", so this
  // line arrives with `lib/payout.mjs` covering the fee and not before it.
  //
  // Read on mainnet 26 Oct: Token-2022, 6dp, TransferFeeConfig at 300 bps, mint authority null,
  // freeze authority null. ⛔ ITS transferFeeConfigAuthority IS LIVE
  // (5KXDF6QnqhBj72hDtJNkkpFaQVUfbFXNybMsp3DiK6tD), so the 3% can be changed under us — which is
  // exactly why the payout rail reads the rate off the mint at send time and asserts it on the
  // instruction, and why the number below is a DESCRIPTION for the form and never sizes a transfer.
  //
  // ⛔ IT CANNOT BE A PAIR HERE, AND THAT IS NOT AN OVERSIGHT. Meteora will not price a curve in a
  // mint that shrinks in transit (6081), and Raydium has no LaunchLab config for it — the PDA
  // EJ13WqSpaZieGCK2pTRUtZJBLPzpPF54wjxTgoWS87BH does not exist, checked the same morning. So the
  // pair chip greys out carrying both reasons, while the payout picker offers it: paying a holder
  // is a plain transfer, which is a different question from what a venue will build a curve in.
  SANTA: { symbol: 'SANTA', name: 'Santa Markets', mint: '3c7mmVSyEH8jfZXgxvpLsETtko1Y16DyRJ5XYB4snhGt', decimals: 6, color: '#d33a3a', category: 'custom', usd: 0.001233, transferFeeBps: 300, payout: true },
  // `payout: true` — Token-2022, but the extensions are MetadataPointer and TokenMetadata and
  // nothing else: no TransferFeeConfig, no freeze authority, no mint authority, supply fixed at
  // 987,193,221.414008. Read on mainnet 26 Oct. Extensions are fixed when a mint is initialised and
  // a nulled authority cannot be restored, so this reading cannot go stale — only be wrong.
  DOPE: { symbol: 'DOPE', name: 'Doge Pepe', mint: '33jENUQnjoitkMFpvNJcSHyLAHFWJuHwT6E3E8CNpump', decimals: 6, color: '#7cb342', category: 'custom', usd: 0.001685, payout: true },
  // ---------------------------------------------------------------- Ferrari, and the stocks that
  // have a real book. Cyrus, 9 Oct: "add CARDS pair, and more stocks like Ferrari".
  //
  // ⛔ FERRARI'S xSTOCK IS NOT THE ONE TO USE. RACEx exists (XsefS5bm…) and it is the obvious hit
  // for a ticker search, but it has ZERO liquidity, ZERO volume, and NO METEORA TOKEN BADGE — so
  // DBC refuses it as a quote outright and a launch against it could not be traded by anyone.
  // Ferrari with a market is BACKPACK SECURITIES' RACE: $516K liquidity, $1.21M daily volume.
  //
  // That is the pattern for this whole block. Two issuers tokenise equities on Solana — xStocks
  // and Backpack Securities — and which one holds the book depends entirely on the company.
  // Netflix is $179K on Backpack against $6.7K as NFLXx; AMD is $150K against $16K. Each entry is
  // whichever issuer actually trades that name, with liquidity, 24h volume and MEASURED price
  // impact on a 2.5 SOL (~$525) buy. All twenty came in under 1%.
  //
  // Every mint was read on chain before it was written down: token program, decimals (8 for
  // xStocks, 6 for Backpack — assuming either is a factor of a hundred), and the Meteora token
  // badge, without which DBC will not accept a Token-2022 mint as a quote at all.
  //
  // ⚠️ AND THE PART THAT MATTERS MOST. Every tokenised stock on this list — both issuers, and the
  // ones already below — carries PermanentDelegate, PausableConfig, DefaultAccountState and a live
  // freeze authority. The issuer can freeze an account, pause all transfers, and MOVE TOKENS OUT
  // OF ANY HOLDER'S WALLET without their signature. That is inherent to a regulated security on
  // chain and is not a reason to leave them out, but a launcher pairing against one takes that
  // risk on behalf of every holder they will ever have — so it is said on the tab, not left in a
  // comment. $CARDS above, and SOL, carry none of it.
  RACE:  { symbol: 'RACE',  name: 'Ferrari',          mint: 'RACEyWiM2ztEZcJx2AHXU2eWjhxU57x3vXn92b39dLD', decimals: 6, color: '#ff2800', category: 'stock', usd: 390.35, note: 'Ferrari, via Backpack Securities. $516K liquidity, $1.21M daily volume, fills with no measurable impact. \u26d4 NOT the Ferrari xStock (RACEx), which has no liquidity and no Meteora badge.' },
  MU:    { symbol: 'MU',    name: 'Micron',           mint: 'MUxEsUKSMACyw5fZf68wxf5FLnZVhtU9CwH8uNNGay1', decimals: 6, color: '#0066b3', category: 'stock', usd: 1030.56, note: '$3.40M liquidity \u2014 the deepest stock here. 0.11% impact on a $525 buy.' },
  SKHY:  { symbol: 'SKHY',  name: 'SK Hynix',         mint: 'SKHYhSjuRWHgikq8eRKbtBbpABgJSkd7ytQV14i9EQ3', decimals: 6, color: '#e60012', category: 'stock', usd: 170.41, note: '$1.68M liquidity, 0.10% impact.' },
  QQQx:  { symbol: 'QQQx',  name: 'Nasdaq 100',       mint: 'Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ', decimals: 8, color: '#6366f1', category: 'stock', usd: 750.75, note: 'The whole Nasdaq 100 as one pair. $2.07M liquidity, 0.07% impact.' },
  MSTRx: { symbol: 'MSTRx', name: 'Strategy',         mint: 'XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ', decimals: 8, color: '#f7931a', category: 'stock', usd: 155.70, note: 'MicroStrategy \u2014 the bitcoin treasury. $1.18M liquidity, 0.04% impact.' },
  COINx: { symbol: 'COINx', name: 'Coinbase',         mint: 'Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu', decimals: 8, color: '#0052ff', category: 'stock', usd: 179.26, note: '$787K liquidity, 0.97% impact on a $525 buy \u2014 the thinnest of the deep ones.' },
  GMEx:  { symbol: 'GMEx',  name: 'GameStop',         mint: 'Xsf9mBktVB9BSU5kf4nHxPq5hCBJ2j2ui3ecFGxPRGc', decimals: 8, color: '#e4002b', category: 'stock', usd: 26.63, note: '$663K liquidity, fills with no measurable impact.' },
  HOODx: { symbol: 'HOODx', name: 'Robinhood',        mint: 'XsvNBAYkrDRNhA7wPHQfX3ZUXZyZLdnCQDfHZ56bzpg', decimals: 8, color: '#00c805', category: 'stock', usd: 109.06, note: '$572K liquidity, 0.28% impact.' },
  DJT:   { symbol: 'DJT',   name: 'Trump Media',      mint: 'DJTu7vi8norVzdVAffgvb39VP7wjKeTsgaMBJrzfxvoF', decimals: 6, color: '#b91c1c', category: 'stock', usd: 8.09, note: '$504K liquidity, $1.40M daily volume, 0.05% impact.' },
  MCDx:  { symbol: 'MCDx',  name: "McDonald's",       mint: 'XsqE9cRRpzxcGKDXj1BJ7Xmg4GRhZoyY1KpmGSxAWT2', decimals: 8, color: '#ffc72c', category: 'stock', usd: 236.67, note: '$400K liquidity, 0.14% impact.' },
  PLTRx: { symbol: 'PLTRx', name: 'Palantir',         mint: 'XsoBhf2ufR8fTyNSjqfU71DYGaE6Z3SUGAidpzriAA4', decimals: 8, color: '#101113', category: 'stock', usd: 208.41, note: '$319K liquidity, 0.42% impact.' },
  TTWO:  { symbol: 'TTWO',  name: 'Take-Two',         mint: 'TTWofwAge91oFhZs7kpQdyrVRkmevgM88xijGvQFbKo', decimals: 6, color: '#d6001c', category: 'stock', usd: 212.96, note: "GTA's publisher. $278K liquidity, fills with no measurable impact." },
  DKNG:  { symbol: 'DKNG',  name: 'DraftKings',       mint: 'DKNGQFNGQmoBdXSRGKJ8tTu7uPDasw5JDcfMmWniNfow', decimals: 6, color: '#53d337', category: 'stock', usd: 19.94, note: '$254K liquidity, 0.20% impact.' },
  HIMS:  { symbol: 'HIMS',  name: 'Hims & Hers',      mint: 'HiMSSzzwkZkrXJ4PGVJRdtfLaANeAztjjcgk5Dxe7Lwx', decimals: 6, color: '#2f5f4f', category: 'stock', usd: 30.96, note: '$216K liquidity but $1.79M of daily volume \u2014 it turns over eight times its own book. 0.06% impact.' },
  NKE:   { symbol: 'NKE',   name: 'Nike',             mint: 'NKEda5nHhNGgjrE9nDdMvaEmkmJ96qqxzBVZEcKmjSg', decimals: 6, color: '#111111', category: 'stock', usd: 34.74, note: '$195K liquidity, 0.27% impact.' },
  NFLX:  { symbol: 'NFLX',  name: 'Netflix',          mint: 'NFLX7qV57zuVxCoHy3s1jiGZyALraLNwttbxdvmYJLJ', decimals: 6, color: '#e50914', category: 'stock', usd: 70.10, note: '$179K liquidity, 0.36% impact. The Netflix xStock holds $6.7K and is not worth pairing against \u2014 this is the one that trades.' },
  AMD:   { symbol: 'AMD',   name: 'AMD',              mint: 'AMD8XwJXgQ9WV45Wyj9yFLejxzf2J6VM1PJY8bJEjeES', decimals: 6, color: '#ed1c24', category: 'stock', usd: 609.08, note: '$150K liquidity, 0.28% impact \u2014 ten times the book of the AMD xStock.' },
  MRNA:  { symbol: 'MRNA',  name: 'Moderna',          mint: 'MRNAzXzhNcaEXJPibHEn8cd4vyekCDiivTyEwswLUCT', decimals: 6, color: '#e2001a', category: 'stock', usd: 223.43, note: '$246K liquidity, 0.60% impact \u2014 use this rather than MRNAx, which moves ~50% on the same trade.' },
  SNDK:  { symbol: 'SNDK',  name: 'Sandisk',          mint: 'SNDKbwMUQvZhnLnxLduradgLHG5KrPuKwpnrkkGRhfH', decimals: 6, color: '#e31937', category: 'stock', usd: 1589.71, note: '$404K liquidity, 0.13% impact \u2014 deeper than SNDKx.' },
  // Stocks — xStocks. All real xStock mints carry the Xs prefix; the lookalikes that do not were
  // the wash pairs the filter above threw out.
  NVDAx:  { symbol: 'NVDAx',  name: 'NVIDIA xStock',   mint: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh', decimals: 8, color: '#76b900', category: 'stock', usd: 235.99 },
  SPCXx:  { symbol: 'SPCXx',  name: 'SpaceX xStock',   mint: 'Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8', decimals: 8, color: '#e2e8f0', category: 'stock', usd: 156.35 },
  CRCLx:  { symbol: 'CRCLx',  name: 'Circle xStock',   mint: 'XsueG8BtpquVJX9LVLLEGuViXUungE6WmK5YZ3p3bd1', decimals: 8, color: '#2775CA', category: 'stock', usd: 81.72 },
  SPYx:   { symbol: 'SPYx',   name: 'SP500 xStock',    mint: 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W', decimals: 8, color: '#94a3b8', category: 'stock', usd: 773.16 },
  // Julz's list, 4 Oct. Added only the ones with liquidity that can actually carry a launch —
  // every mint from Jupiter's token list and verified on chain. The five below complete the
  // Magnificent 7 (NVDAx and GOOGLx were already here).
  AAPLx:  { symbol: 'AAPLx',  name: 'Apple xStock',     mint: 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp', decimals: 8, color: '#A2AAAD', category: 'stock', usd: 333.18 },
  MSFTx:  { symbol: 'MSFTx',  name: 'Microsoft xStock', mint: 'XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX', decimals: 8, color: '#00A4EF', category: 'stock', usd: 516.76 },
  AMZNx:  { symbol: 'AMZNx',  name: 'Amazon xStock',    mint: 'Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg', decimals: 8, color: '#FF9900', category: 'stock', usd: 251.27 },
  METAx:  { symbol: 'METAx',  name: 'Meta xStock',      mint: 'Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu', decimals: 8, color: '#0866FF', category: 'stock', usd: 729.56 },
  TSLAx:  { symbol: 'TSLAx',  name: 'Tesla xStock',     mint: 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB', decimals: 8, color: '#E31937', category: 'stock', usd: 371.03 },
  // The only commodity of the four he asked for that has a real book. SLVx ($14), URAx ($31) and
  // the "Copper Miners ETF" (which on Solana is an unrelated memecoin called Copx Coin, $4) were
  // left out rather than shipped as pairs that cannot absorb a single trade.
  GLDx:   { symbol: 'GLDx',   name: 'Gold xStock',      mint: 'Xsv9hRk1z5ystj9MhnA7Lq4vjSsLwzL2nxrwmwtD3re', decimals: 8, color: '#D4AF37', category: 'stock', usd: 379.99 },
  // The rest of Julz's list, added in full on his call after I flagged the liquidity. Each carries
  // its REAL measured slippage rather than a generic caution, because "thin" covers both a 1.2%
  // fill and a 74% one and those are not the same decision. Impact measured on a 0.05 SOL swap.
  COPX:   { symbol: 'COPX',   name: 'Copper Miners ETF', mint: 'CzLTZppPdZtTjyq3WGpHLstoc3GLhu7zH5Zg6xUa6Gv5', decimals: 6, color: '#B87333', category: 'stock', usd: 85.20, note: 'Global X Copper Miners ETF (Backed). ~$122K liquidity, fills cleanly. NOT the memecoin also ticking COPX.' },
  SNDKx:  { symbol: 'SNDKx',  name: 'Sandisk xStock',    mint: 'Xswbpc8UqU6e1j9QZEWCjBMjyvz4twqD7PCy6j2e7jj', decimals: 8, color: '#E31937', category: 'stock', usd: 1779.50, note: 'Thin: about 1.2% slippage on a small swap. Workable for a small launch.' },
  MRNAx:  { symbol: 'MRNAx',  name: 'Moderna xStock',    mint: 'XsViHjyRbiSBskjizb1gszGTmZqtAH8TuqwJ7sB5AcP', decimals: 8, color: '#E2001A', category: 'stock', usd: 127.19, note: '⚠️ Very thin — roughly 50% slippage on a small swap. A launch priced against this will move it hard.' },
  SLVx:   { symbol: 'SLVx',   name: 'Silver xStock',     mint: 'XsxAd6okt8y1RRK6gNg7iJaqiWNiq5Md5EDf3ZrF2dm', decimals: 8, color: '#C0C0C0', category: 'stock', usd: 59.92, note: '⚠️ Almost no book — about 73% slippage on a small swap. Listed because it was asked for, not because it trades.' },
  URAx:   { symbol: 'URAx',   name: 'Uranium ETF xStock',mint: 'Xsq9sEQjYiUTSZ55RrbHAzVfz8HotwFGrqgxkgiv4LB', decimals: 8, color: '#7FFF00', category: 'stock', usd: 40.70, note: '⚠️ Almost no book — about 75% slippage on a small swap. Listed because it was asked for, not because it trades.' },
  // ⛔ DELLx is BADGED and priced but Jupiter returns TOKEN_NOT_TRADABLE: there is no route at all
  // today, so a launch quoted in it could not be traded by anyone. Included because the whole list
  // was asked for, and marked `unavailable` so the launch form blocks it rather than letting
  // somebody discover it after signing.
  DELLx:  { symbol: 'DELLx',  name: 'Dell xStock',       mint: 'Xsu7Tc5J2fVUE4H5vYAiSr34cvLJeCsYPMjAYnayQn6', decimals: 8, color: '#007DB8', category: 'stock', usd: 697.59, unavailable: 'no route — Jupiter cannot trade it today', note: '⛔ No trading route exists right now. Nobody could buy or sell a coin priced against it.' },
  GOOGLx: { symbol: 'GOOGLx', name: 'Alphabet xStock', mint: 'XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN', decimals: 8, color: '#fbbc05', category: 'stock', usd: 343.28 },
  // ALTS — the majors, bridged onto Solana. Elio asked for "top 5-10 alts to pair to", naming ZEC,
  // HYPE, XRP and Monero.
  //
  // These were NOT resolved by searching DexScreener for the ticker, which is how the META list was
  // built. For a major that method returns almost nothing but clones: every top hit for ZEC, HYPE,
  // XRP and XMR came back with liquidity equal to its entire market cap, several of them claiming
  // $1.6B of depth against $300K of daily volume. A launch quoted against one of those pays its
  // holders in paper. They come from Jupiter's VERIFIED list instead — the list wallets and
  // aggregators route against — and each one was then checked for real depth by mint address.
  //
  // XRP is deliberately absent: it is not on the verified list, and a wrong XRP is worse than no XRP.
  // PEPE. Asked for so a payout basket can actually pay it — Elio wanted "doge/pepe/anthropic"
  // and only DOGE existed, so a basket naming PEPE was refused by normalizeBasket.
  //
  // ⛔ THE DECOYS HERE ARE WORSE THAN USUAL, which is why the note further up this file said PEPE
  // "shares its ticker with decoys" and had to be verified before going in. A Jupiter search for
  // PEPE returns Pimp Pepe, Pepe Kimchi, Duck Duck Pepe, Pepecat Bonk and PEPE BROCK, all
  // routable. Worse, TWO verified entries are literally named "Pepe", so picking by name is not
  // enough either. Both were read off the chain before this one was chosen.
  //
  //   PEPEqnuu…  4dp, legacy SPL, 271.2B supply, $544K liquidity, $1.71M 24h volume, 24,577 holders
  //   B5WTLaRw…  6dp, legacy SPL,   999M supply, $178K liquidity,  $47K 24h volume, 25,100 holders
  //
  // ⛔ NEITHER CAN FREEZE A HOLDER, which is the property that decided WBTC over cbBTC above, so
  // that test does not separate them. Liquidity does: a launch priced against a thin asset is
  // unusable, which is why $NEAR at ~$14K and $SHIB at ~$128K were rejected outright. At 36x the
  // volume and 3x the book, PEPEqnuu is the one people actually trade.
  //
  // ⚠️ IT CARRIES A MINT AUTHORITY (HiRmjPfmXKuGgHh4ESPUMoAjfTGx8pHi8Pycqrc5eb2c) AND THAT IS NOT
  // INHERENT THE WAY WBTC'S IS. WBTC mints because BTC is locked on the other side; nothing backs
  // a mint here, so the holder of that key can dilute the asset a launch is priced against. The
  // other candidate, B5WTLaRw, has a null mint authority and is the safer token on that one axis —
  // it was passed over for liquidity alone, and if its book ever deepens it is the better choice.
  // Recorded rather than buried, like JLP's: a launcher picking their pair deserves to know.
  PEPE: { symbol: 'PEPE', name: 'Pepe',          mint: 'PEPEqnuuCDbBC89p1u9vpnP1KQ2oj1xTcQBsjt9X55m', decimals: 4,  color: '#4caf50', category: 'alt', usd: 0.00000465293, note: '~$544K liquidity, $1.7M daily volume. ⚠️ The issuer can mint more; it cannot freeze a holder.' },
  // BITCOIN. Julz, 23 Oct: "add Bitcoin option also, we don't have it" — and he was right. The
  // only BTC here was xBTC, which is Hylo's LEVERAGED BTC over in the Leverage tab, not bitcoin.
  // $BTC does not trade on Solana under that ticker at all.
  //
  // ⛔ A TICKER SEARCH FOR BTC IS A MINEFIELD — the same trap the xSOL decoy set earlier in this
  // file. Jupiter's own search returns "Big Titty Coin" ($420K), "Buy The Cat", "betcuin" and a
  // plain "BTC / Bitcoin" holding $67K, every one of them routable and none of them bitcoin. The
  // mint below came off Jupiter's VERIFIED list and was then read back from the chain.
  //
  // ⛔ WHY PORTAL'S WBTC AND NOT COINBASE'S cbBTC, which was the only other real candidate:
  // cbBTC CARRIES A FREEZE AUTHORITY (DSFAkPhfrSR95J9oq9Sh8rUetbj5vgFmwiSuHw6rAVnz). Coinbase can
  // freeze a holder's account, and a launch priced against an asset whose issuer can seize it is
  // precisely what JLP is flagged for above. WBTC has no freeze authority and deeper liquidity
  // besides — $38.2M against $28.5M. Verified on chain: legacy SPL, 8dp (matching Jupiter, which
  // is the check that catches the STONK/ZCAT class of error), supply 2,451.76.
  //
  // ⚠️ It does carry a mint authority (BCD75RNBHrJJpW4dXVagL5mPjzRLnVZq4YirJdjEYMV7). That is
  // inherent to a bridge — wBTC is minted as BTC is locked on the other side — and is equally true
  // of cbBTC, so it is not what decided this. The freeze authority is.
  WBTC: { symbol: 'WBTC', name: 'Bitcoin (Portal)', mint: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh', decimals: 8,  color: '#F7931A', category: 'alt', usd: 81100.78, note: '~$38M liquidity. Mints as BTC is locked; cannot freeze a holder.' },
  ZEC:  { symbol: 'ZEC',  name: 'Zcash',       mint: 'A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS', decimals: 8,  color: '#f4b728', category: 'alt', usd: 1264 },
  HYPE: { symbol: 'HYPE', name: 'Hyperliquid', mint: '98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g', decimals: 9,  color: '#97fce4', category: 'alt', usd: 89.13 },
  ETH:  { symbol: 'ETH',  name: 'Ether',       mint: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', decimals: 8,  color: '#8c8dfc', category: 'alt', usd: 2681 },
  XMR:  { symbol: 'XMR',  name: 'Monero',      mint: 'WXMRyRZhsa19ety5erZhHg4N3xj3EVN92u94422teJp',  decimals: 12, color: '#ff6600', category: 'alt', usd: 533.68 },
  DOGE: { symbol: 'DOGE', name: 'Dogecoin',    mint: 'DoGEV7LASBkQbibMc5k5vKnTZoMg423GpJ5QtJEGfm7R', decimals: 8,  color: '#c2a633', category: 'alt', usd: 0.09337 },
  SUI:  { symbol: 'SUI',  name: 'Sui',         mint: 'suifhC9gU1VbJAPYPTBkHJyyyStKGLLYPVDTmPoqbvA',  decimals: 8,  color: '#4da2ff', category: 'alt', usd: 1.18 },
  TAO:  { symbol: 'TAO',  name: 'Bittensor',   mint: 'taoC6xyv2v8tDLcev4uaGUgV4vdQsWJrGft2kcBRrBY',  decimals: 9,  color: '#14b8a6', category: 'alt', usd: 294.97 },
};
/** The launch screen's tabs, in the spec's order. Quote is the default; REX is the one-tap upgrade. */
export const QUOTE_TABS = [
  { key: 'quote', label: 'Quote',  note: 'SOL leads while liquidity builds. $REX is one tap away — your holders get paid in $REX, and holding it gets you a better rate.', symbols: ['SOL', 'REX', 'USDC', 'CARDS', 'GP', 'DOPE'] },
  { key: 'meta',  label: 'META',   note: 'Top Stonk coins, as pairs.',               symbols: ['STONK', 'ZCAT', 'SI', 'MASK', 'ALLINU'] },
  { key: 'alt',   label: 'ALTS',   note: 'The majors, bridged onto Solana — from Jupiter\'s verified list.', symbols: ['ZEC', 'HYPE', 'ETH', 'XMR', 'DOGE', 'SUI', 'TAO'] },
  { key: 'stock', label: 'Stocks', note: 'Real equities, from the two issuers that tokenise them on Solana. \u26a0\ufe0f Every one can be frozen, paused or moved out of your wallet by its issuer.', symbols: ['RACE', 'MU', 'QQQx', 'NVDAx', 'MSTRx', 'SPCXx', 'COINx', 'SPYx'] },
];
// ---------- cluster
// Every mint above is a MAINNET address. On devnet they hold nothing, so a launch quoted against one
// has nothing real to price against and the create transaction fails on an account that does not
// exist. tools/devnet-mints.mjs creates stand-ins with the crank as mint authority — so the faucet
// can hand them out — and writes them to devnet-mints.json, which is checked in because they are
// public addresses on a throwaway cluster.
//
// A quote with no stand-in is REMOVED rather than left pointing at a mainnet address, because an
// option that cannot work is worse than one that is not offered. That is what empties the META and
// Stocks tabs on devnet.
import fsx from 'node:fs';
import pathx from 'node:path';

export const CLUSTER = (() => {
  const u = process.env.RPC_URL || '';
  if (!u) return 'paper';
  if (/devnet/i.test(u)) return 'devnet';
  if (/localhost|127\.0\.0\.1/.test(u)) return 'localnet';
  if (/testnet/i.test(u)) return 'testnet';
  return 'mainnet';
})();

if (CLUSTER === 'devnet' || CLUSTER === 'localnet') {
  let map = {};
  try {
    const f = process.env.DEVNET_MINTS_FILE || pathx.join(process.cwd(), 'devnet-mints.json');
    if (fsx.existsSync(f)) map = JSON.parse(fsx.readFileSync(f, 'utf8'));
  } catch (e) { warn('devnet mints', e.message); }
  if (process.env.DEV_QUOTE_MINT) map.REX = process.env.DEV_QUOTE_MINT;
  if (!map.REX) {
    // Nothing to remap onto. Removing every quote would leave the site with no pairs at all and
    // throw on the first request, so say so loudly and leave the table alone — a cluster build
    // pointed at mainnet mints is broken in an obvious way, which is the better of the two.
    warn(`no ${CLUSTER} stand-in mints (devnet-mints.json missing or empty) — quotes still point at`
      + ' mainnet addresses and launches against them will fail. Run tools/devnet-mints.mjs.');
  } else {
    // Deleting the quotes with no stand-in emptied the META, ALTS and Stocks tabs — you clicked them
    // and nothing appeared, with nothing saying why. Elio, and he was right to call it the most
    // important one: a tab that silently has nothing in it reads as broken software, where a tab that
    // says "mainnet only" reads as a test network. So they stay listed and are marked unavailable.
    for (const sym of Object.keys(QUOTES)) {
      if (map[sym]) QUOTES[sym].mint = map[sym];
      else QUOTES[sym].unavailable = CLUSTER;
    }
  }
  for (const tab of QUOTE_TABS) {
    const live = tab.symbols.filter((sym) => !QUOTES[sym]?.unavailable).length;
    if (!live) tab.note = `These are mainnet pairs — the mints do not exist on ${CLUSTER}, so they cannot be launched against here. They come back on mainnet.`;
  }
  const q = QUOTE_TABS.find((t) => t.key === 'quote');
  if (q) q.note = `SOL leads while liquidity builds. $REX is one tap away. These are ${CLUSTER} stand-in mints and the faucet hands them out.`;
} else if (process.env.DEV_QUOTE_MINT) {
  QUOTES.REX.mint = process.env.DEV_QUOTE_MINT;
}

export const QUOTE_BY_MINT_LIVE = () => Object.fromEntries(Object.values(QUOTES).map((q) => [q.mint, q.symbol]));
// ⛔ DEXSCREENER ANSWERS A CALLER IT IS THROTTLING WITH HTTP 200 AND `pairs: null`, NOT A 429.
// That is why this was broken for so long without looking broken. The old loop asked for one mint
// at a time — thirty-eight requests in a burst every sixty seconds, against a budget that is three
// hundred a minute but shaped per second, so the back half of every burst came home empty. Nothing
// threw. `pairs` was just null, the price kept the constant compiled into this file, and the only
// trace was a warning line per symbol per minute in a log nobody tails.
//
// Sixteen of thirty-eight quotes were in that state in production: ZCAT was showing 0.03867, the
// figure seeded here on 6 Oct, while it traded at 0.05376. Every USD number computed off one of
// those quotes — pair volume, the earnings panel, a payout's dollar value — was wrong by whatever
// the asset had moved since the seed was written.
//
// Three things, and the shape of each matters:
//   · ONE REQUEST PER THIRTY MINTS. Thirty-eight quotes is two requests a minute, not thirty-eight.
//   · A CANARY IN EVERY CHUNK. An empty answer is indistinguishable from "none of these trade", so
//     each chunk carries SOL, which always has pools. SOL missing means we were not answered, and
//     then nothing in that chunk is believed — where before, being ignored and being untraded both
//     silently resolved to "keep the seed".
//   · A MISS IS REMEMBERED. A symbol that failed was never cached, so it was retried on the very
//     next tick, in the same burst, and failed again. Permanently. Both outcomes are cached now,
//     with a short life for a real price and a long one for a mint no aggregator carries.
const CANARY = 'So11111111111111111111111111111111111111112'; // SOL — its absence means silence, not a price of zero
const DEX_CHUNK = 30;        // DexScreener's documented ceiling for a batched token lookup
const PRICE_TTL = 60_000;    // a confirmed price is good for a minute
const NONE_TTL = 15 * 60_000; // a mint the aggregator does not carry is not worth asking about every minute
const COOLDOWN_MS = 5 * 60_000;
const cache = new Map();     // symbol -> { at, ok } — ok false means "asked, and it genuinely has no pools"
let dexSilentUntil = 0;

/**
 * ⛔ AND THE OTHER HALF OF THE SAME LESSON: ONE PRICE SOURCE IS ONE OUTAGE FROM NO PRICES.
 *
 * Batching stopped us tripping DexScreener's limit, and then, within the hour, DexScreener itself
 * went quiet — `/latest/dex/tokens`, `/tokens/v1` and even `/latest/dex/search?q=SOL` all answering
 * 200 with nothing in them, from two unrelated IPs at once. No amount of politeness survives that.
 * It is the same shape as the RPC failure found the same afternoon: a single provider, no fallback,
 * and a whole subsystem that stops the moment it does.
 *
 * So prices come from a LIST, tried in order until one actually answers. A source returns
 * Map(mint -> {usd, liq}) or null, and null means "this source did not serve us" — never "these
 * assets have no price". The canary is what tells those two apart.
 */
const SOURCES = [
  // Jupiter's price API: one request for the lot, and it carries liquidity, so the canary works.
  {
    name: 'jupiter',
    async fetchBatch(mints) {
      const r = await fetch(`https://lite-api.jup.ag/price/v3?ids=${mints.join(',')}`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) return null;
      const j = await r.json();
      if (!j || typeof j !== 'object') return null;
      const best = new Map();
      for (const [mint, v] of Object.entries(j)) {
        const usd = Number(v?.usdPrice);
        if (usd > 0) best.set(mint, { usd, liq: Number(v?.liquidity) || 0 });
      }
      return best;
    },
  },
  // DexScreener, which was the only source until the afternoon it stopped answering.
  {
    name: 'dexscreener',
    async fetchBatch(mints) {
      const r = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mints.join(',')}`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) return null;
      const j = await r.json();
      const rows = Array.isArray(j) ? j : (j?.pairs || []);
      const best = new Map();
      for (const row of rows) {
        const mint = row.baseToken?.address;
        const usd = Number(row.priceUsd);
        if (!mint || !(usd > 0)) continue;
        const liq = Number(row.liquidity?.usd || 0);
        const cur = best.get(mint);
        if (!cur || liq > cur.liq) best.set(mint, { usd, liq }); // deepest pool wins — a junk pool must not set the price
      }
      return best;
    },
  },
];

/** Which source last served us, so /api/health can say where the figures come from. */
let _lastSource = null;
export const priceSource = () => _lastSource;

/**
 * Ask each source in turn for one batch of mints.
 *
 * ⛔ THE CANARY IS THE WHOLE DESIGN. An empty answer and a throttled one are byte-identical, so
 * every batch carries SOL, which always has pools everywhere. SOL missing means we were not served,
 * and then NOTHING in that batch is believed. Without it, being ignored and being genuinely
 * untraded both resolve to "keep the constant compiled into this file" — which is how sixteen
 * quotes came to be priced from figures typed in October.
 */
async function priceBatch(mints) {
  const list = mints.includes(CANARY) ? [...mints] : [CANARY, ...mints];
  for (const src of SOURCES) {
    let got = null;
    try { got = await src.fetchBatch(list); } catch { got = null; }
    if (got && got.has(CANARY)) { _lastSource = src.name; return got; }
  }
  return null;
}

export async function refreshPrices() {
  // Stand-in mints are not traded anywhere, so asking a price aggregator about them is a guaranteed
  // miss and a warning line per quote per minute. The static figures stay, which is all a devnet
  // market needs to show plausible numbers.
  if (CLUSTER === 'devnet' || CLUSTER === 'localnet') return;
  if (Date.now() < dexSilentUntil) return;
  const due = Object.values(QUOTES).filter((q) => {
    if (q.category === 'stable') return false;
    const c = cache.get(q.symbol);
    return !c || Date.now() - c.at >= (c.ok ? PRICE_TTL : NONE_TTL);
  });
  if (!due.length) return;
  for (let i = 0; i < due.length; i += DEX_CHUNK - 1) {
    const chunk = due.slice(i, i + DEX_CHUNK - 1);
    const got = await priceBatch(chunk.map((q) => q.mint));
    if (!got) {
      // Being ignored is not news about any particular asset, so no price moves and no symbol is
      // marked dead. One line, and we stand down long enough for the budget to refill.
      dexSilentUntil = Date.now() + COOLDOWN_MS;
      warn('prices', `no price source answered for a batch of ${chunk.length} (tried ${SOURCES.map((x) => x.name).join(', ')})`,
        `— holding last known prices for ${COOLDOWN_MS / 60_000}m`);
      return;
    }
    for (const q of chunk) {
      const b = got.get(q.mint);
      if (b) { q.usd = b.usd; cache.set(q.symbol, { at: Date.now(), ok: true }); }
      else cache.set(q.symbol, { at: Date.now(), ok: false });
    }
  }
}

/**
 * How old a quote's price is, in ms, or null if it has never been confirmed against the market.
 *
 * A caller that shows money needs to be able to tell the difference. `usd` is always a number, and
 * before this there was no way to ask whether that number came from the market a minute ago or
 * from this file in October — which is precisely how sixteen stale quotes went unnoticed.
 */
export const priceAgeOf = (symbol) => { const c = cache.get(symbol); return c?.ok ? Date.now() - c.at : null; };
/**
 * Check every quote's decimals against the chain, and say so loudly when they disagree.
 *
 * ⛔ A WRONG DECIMAL IN THIS TABLE IS A SILENT THOUSAND-FOLD ERROR. The figures here are typed by
 * hand, and two of them were wrong: STONK and ZCAT sat at 6 when the chain says 9. Nothing looked
 * broken — the symbol resolved, the price resolved, the pair appeared in the picker — right up
 * until a curve was sized with it and the coin opened at a $5 market cap. Julz hit it, reported it,
 * and asked why it keeps happening.
 *
 * The launch path no longer trusts this table for anything that decides money; it reads the mint.
 * But the table is still used to format what people see, so a mistake in it is still a lie, and a
 * hand-maintained list of numbers nobody verifies will drift again the next time a pair is added.
 * One sweep at boot, thirty-odd reads, and the next wrong row announces itself.
 */
export async function auditQuoteDecimals(conn) {
  if (CLUSTER === 'devnet' || CLUSTER === 'localnet' || CLUSTER === 'paper') return [];
  const { PublicKey } = await import('@solana/web3.js');
  const wrong = [];
  for (const q of Object.values(QUOTES)) {
    if (q.unavailable) continue;
    try {
      const info = await conn.getParsedAccountInfo(new PublicKey(q.mint));
      const d = info?.value?.data?.parsed?.info?.decimals;
      // ⛔ Only a number we actually read counts. An unreachable RPC is not a disagreement, and
      // reporting it as one would cry wolf every time the endpoint hiccups.
      if (!Number.isInteger(d) || d === q.decimals) continue;
      wrong.push({ symbol: q.symbol, ours: q.decimals, chain: d, mint: q.mint });
      q.decimals = d;   // believe the chain, now, rather than waiting for a deploy
    } catch { /* unreachable is not wrong */ }
  }
  if (wrong.length) {
    warn('quotes', '⛔ QUOTE DECIMALS DISAGREE WITH THE CHAIN —',
      wrong.map((w) => `${w.symbol} ours=${w.ours} chain=${w.chain}`).join(', '),
      '· corrected in memory for now; fix the table in lib/prices.mjs.',
      'Every amount formatted with the wrong figure was out by a factor of',
      wrong.map((w) => 10 ** Math.abs(w.chain - w.ours)).join('/'));
  }
  return wrong;
}

/** The quotes whose price has never once been confirmed. Reported by /api/health. */
export const unpricedQuotes = () => Object.values(QUOTES)
  .filter((q) => q.category !== 'stable' && !cache.get(q.symbol)?.ok)
  .map((q) => q.symbol);

/**
 * The starting position for the badge gate, measured against mainnet on 2026-10-06.
 *
 * ⛔ THIS IS A SEED, NOT A DENY-LIST, and the difference matters. The gate is supposed to be read
 * off the chain — Meteora can badge a mint any day and a list in the source would go on refusing
 * the pair long after it started working. But a sweep costs about thirty chain reads, and the first
 * one in production met an exhausted RPC key: every read failed, every symbol was correctly left
 * alone, and the sweep produced nothing. A gate that only works when the chain is healthy is not a
 * gate, and meanwhile Elio picks SUPER INU and hits the wall again.
 *
 * So these four start blocked, because that is what the chain said when it was asked. The first
 * sweep that completes overwrites them in both directions and persists the result, so a badge
 * issued tomorrow opens the pair tomorrow with nobody editing this file.
 *
 * All of them are Token-2022 mints carrying a transfer fee (extension 1), which DBC will not accept
 * as a quote without a badge. STONK, the fifth META pair, is clean and stays open.
 *
 * ⛔ $SANTA IS SEEDED HERE THE DAY IT IS ADDED, not left for the first sweep. Between boot and a
 * sweep an unseeded pair reads as OPEN, so the chip offers it and the launch gets as far as
 * Meteora refusing the quote with 6081 — after the launcher has filled the form. It is also the
 * one pair with no second venue to fall back to: Raydium has no LaunchLab config for it either
 * (EJ13WqSpaZieGCK2pTRUtZJBLPzpPF54wjxTgoWS87BH does not exist), so the chip greys out for good.
 * None of this touches `payableAsset`, which asks the cluster block and not this one — paying a
 * holder is a transfer, and a transfer needs no badge from anybody.
 */
const BADGE_SEED = ['ZCAT', 'SI', 'MASK', 'ALLINU', 'SANTA'];
const BADGE_SEED_REASON = 'Meteora has not issued a token badge for it, and DBC will not take a quote mint with a transfer fee without one';
for (const sym of BADGE_SEED) if (QUOTES[sym]) QUOTES[sym].badgeBlock = BADGE_SEED_REASON;

/**
 * Why this quote cannot be used as a pair right now, or null.
 *
 * Two separate reasons, one answer. `unavailable` is set at boot when a cluster has no stand-in for
 * a mainnet mint; `badgeBlock` is set by the chain sweep when Meteora has issued no token badge.
 * The cluster reason wins because it is the more fundamental one — on devnet the mint does not even
 * exist, so what Meteora has or has not badged is beside the point.
 *
 * Everything that gates a pair goes through here, so the greyed-out button in the form and the
 * server's refusal can never disagree about which pairs are open.
 */
export const quoteBlock = (symbol) => QUOTES[symbol]?.unavailable || QUOTES[symbol]?.badgeBlock || null;

/**
 * Can a HOLDER be paid in this asset?
 *
 * The categories are where the hazards live, and this is the only place they are all known:
 *   · native / stable / alt — ordinary liquid assets. Payable.
 *   · stock / leverage      — a regulated security or a leveraged wrapper whose ISSUER can freeze,
 *                             pause or seize the account. A dividend the payer can confiscate
 *                             afterwards is not a dividend.
 *   · meta / custom         — launched coins, most of which charge a TRANSFER FEE. That used to
 *                             end the matter; it no longer does — see below.
 *
 * ⛔ A CATEGORY IS A PROXY FOR THE HAZARD, NOT THE HAZARD, AND IT WAS WRONG IN BOTH DIRECTIONS.
 * Julz, 26 Oct: "add to basket options — Rex, Dope, Santa". $REX was already in; $DOPE was not, and
 * the only thing standing in its way was the word `custom`. Reading the mints that morning settled
 * it and turned up two more the same word was hiding:
 *
 *   $DOPE   Token-2022, MetadataPointer + TokenMetadata and nothing else. No fee, no authorities.
 *   $CARDS  legacy SPL, 82 bytes exactly — a mint that short has no TLV region to put one in.
 *   $STONK  legacy SPL, no authorities. Sitting in META beside four mints that take 1-3%.
 *   $SANTA  Token-2022, 3% transfer fee. Asked for in the same breath, and the same reading is
 *           what refuses it: byte for byte the hazard $GP is. It is not in QUOTES.
 *
 * And the fee itself was never uniform — $ZCAT and $MASK take 3%, $SI and $ALLINU take 1% — which
 * no category could have told anyone.
 *
 * ⛔⛔ A TRANSFER FEE IS NO LONGER A REFUSAL, BECAUSE THE RAIL NOW COVERS IT. Julz asked for
 * $SANTA in the basket on 26 Oct and the owner's answer was "build the gross-up so santa works".
 * `lib/payout.mjs` works every leg backwards from its ARRIVAL — `transferFeeOf` reads the live
 * rate off the mint and `grossFor` finds the smallest amount that lands whole — so the fee comes
 * out of the fee claimer's balance and never out of the holder's reward. **This flag and that rail
 * are one change.** Opening this gate against a rail that still sends the promise verbatim is the
 * original bug, restored: every holder short 1–3%, every epoch, in units too small to notice.
 *
 * `transferFeeBps` stays on the mint as a DESCRIPTION — it is what the launch form tells a creator
 * an asset costs to pay in. It never sizes a transfer: the rate is mutable ($SANTA's authority is
 * live) so the rail asks the chain, every time.
 *
 * ⛔ AND THE BADGE BLOCK IS NOT ASKED HERE, ON PURPOSE. `quoteBlock` folds together "this mint is
 * not on this cluster" and "Meteora has issued no token badge for it". The second answers whether
 * a VENUE will build a curve priced in the asset — it has nothing to say about a plain transfer to
 * a holder, and asking it here would refuse every fee-bearing mint all over again by a different
 * route. The cluster half is asked, because on devnet the mint genuinely is not there.
 *
 * The default stays CLOSED — a new quote is unpayable until somebody reads its mint — because the
 * two failures are not symmetrical. A clean asset left off is a question from Julz and a mint read;
 * a fee-bearing one let in takes 3% from every holder on every epoch, for ever, in units too small
 * for anyone to notice. So an asset opts in by name, carrying the reading that earned it, and
 * `tools/payout_pick_test.mjs` holds those figures so the flag cannot be written without them.
 *
 * ⛔ IT LIVES HERE, NOT IN ai_alloc, BECAUSE THE AI WAS NEVER THE ONLY WAY IN. The allowlist was
 * written for the model to pick from, and `normalizeBasket` — which is what a launch form and the
 * launch route both validate through — asked only "is it a quote?". So the model could not choose
 * $GP and a request to /api/chain/meta could, and that coin would have shortchanged its holders 3%
 * on every epoch, for ever, in units too small to notice. Found 25 Oct while adding the picker.
 *
 * ⛔ AND IT IS ENFORCED ON THE WRITE, NOT ON THE READ. `payoutBasket` keeps paying whatever a coin
 * was already promised — tightening the reader would silently stop a live coin's epochs instead of
 * refusing a new mistake. Nothing live can be affected: every stored basket was written through
 * `normalizeBasket` from the presets or the model, and both were already inside this set.
 */
export const PAYABLE_CATEGORIES = new Set(['native', 'stable', 'alt']);
export const payableAsset = (symbol) => {
  const q = QUOTES[symbol];
  if (!q) return false;
  return (q.payout === true || PAYABLE_CATEGORIES.has(q.category)) && !q.unavailable;
};

/**
 * The same answer, but saying WHICH of the two reasons it is.
 *
 * ⛔ THE CHIP CANNOT PHRASE A BLOCK IT CANNOT TELL APART. The form had one reason to describe —
 * "this mint does not exist on devnet" — so it wrote the text around it: `${name} exists on mainnet
 * only — not on ${unavailable}`, with "mainnet only" under the ticker. Feeding a badge sentence
 * into that slot produced "Anonymous Cat exists on mainnet only — not on Meteora has not issued a
 * token badge for it", which is worse than no tooltip at all.
 */
export function quoteBlockKind(symbol) {
  const q = QUOTES[symbol];
  if (q?.unavailable) return { kind: 'cluster', why: q.unavailable };
  if (q?.badgeBlock) return { kind: 'badge', why: q.badgeBlock };
  return null;
}
/**
 * Why this quote cannot be used as a pair ON A GIVEN VENUE, or null.
 *
 * ⛔ A METEORA BLOCK IS NOT A SITE BLOCK, AND THE LAUNCH ROUTE TREATED IT AS ONE. Julz, 24 Oct:
 * "Trying to pair it to different ones different errors" — MASK came back with the badge sentence,
 * which ENDS with "It launches on Raydium LaunchLab instead, which takes fee-bearing pairs." The
 * form agreed: it shows those five pairs open, labelled "via LaunchLab", and posts
 * `venue: 'launchlab'`. The server then refused them anyway, because the guard asked
 * `quoteBlock()` — which is Meteora's verdict OR the cluster's, collapsed into one string — before
 * it ever looked at which venue was asked for. GP, ZCAT, SI, MASK and ALLINU were unlaunchable
 * while the site offered them and the refusal text named the venue that would have taken them.
 *
 * The two reasons are not interchangeable and never were:
 *   cluster — the mint has no stand-in on this cluster, so there is nothing to pair with anywhere.
 *   badge   — Meteora will not price a curve in it. That closes the Meteora door and no other.
 *
 * Whether LaunchLab actually carries the pair is a separate question with its own answer, and the
 * launch route asks it right after (`llQuoteOf`) in words that name the pairs Raydium has configs
 * for. Do not fold that in here: this file must not import the venue modules, and a block that
 * silently means two things is the bug being fixed.
 */
export function venueBlock(symbol, venue) {
  const k = quoteBlockKind(symbol);
  if (!k) return null;
  if (k.kind === 'cluster') return k.why;                 // no venue can help: the asset is not here
  return String(venue) === 'launchlab' ? null : k.why;
}
/** Apply a { SYMBOL: null | reason } verdict from the chain sweep. A symbol left out is untouched. */
export function setBadgeBlocks(verdicts) {
  let blocked = 0;
  for (const [sym, reason] of Object.entries(verdicts || {})) {
    if (!QUOTES[sym]) continue;
    QUOTES[sym].badgeBlock = reason || null;
    if (reason) blocked++;
  }
  return blocked;
}
export const usdOf = (symbol) => QUOTES[symbol]?.usd || 0;
// `note` is included deliberately: it is where an asset's caveats live — JLP's freeze authority,
// for one — and a warning that stops at the server is a warning nobody reads.
export const quoteList = () => Object.values(QUOTES).map((q) => ({ symbol: q.symbol, name: q.name, mint: q.mint, decimals: q.decimals, color: q.color, logo: q.logo || null, category: q.category, usd: q.usd, priceLive: !!cache.get(q.symbol)?.ok || q.category === 'stable', note: q.note || null, transferFeeBps: q.transferFeeBps || 0, unavailable: quoteBlock(q.symbol), block: quoteBlockKind(q.symbol) }));
