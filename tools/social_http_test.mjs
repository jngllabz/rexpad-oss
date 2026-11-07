// The growth layer under hostility, over HTTP: junk into every social route, a sybil farm run end
// to end, and self-referral through the API.
// Needs a SIM server with the gate off:
//   DATA_DIR=/tmp/rexqa SIM=1 PORT=8787 LAUNCH_HOLD_USD=0 node server.mjs
//   node tools/social_http_test.mjs
const B = process.argv[2] || process.env.BASE || "http://127.0.0.1:8787";

// This whole suite drives demo wallets, paper trades and seeded referrals, all of which exist only
// in SIM mode — they must NOT exist on a cluster where the money is real. Run against a live
// deployment it used to die on a stack trace halfway through, which reads like a regression and is
// not one. Check once, say so, and exit clean.
{
  const st = await fetch(B + '/api/state').then((r) => r.json()).catch(() => null);
  if (!st) { console.log(`Cannot reach ${B} — is the server running?`); process.exit(1); }
  if (!st.sim) {
    console.log(`${B} is not in SIM mode — this suite needs demo wallets and paper trades, which`);
    console.log('only exist there. Skipping (not a failure). Start a SIM server to run it:');
    console.log('  SIM=1 PORT=8787 DATA_DIR=/tmp/rexqa node server.mjs');
    process.exit(0);
  }
}
let pass=0, fail=0; const ok=(c,m)=>{c?(pass++,console.log("✅",m)):(fail++,console.log("❌",m));};
const call=async(p,b,H={})=>{const r=await fetch(B+p,{method:b===undefined?"GET":"POST",headers:{"content-type":"application/json",...H},body:b===undefined?undefined:JSON.stringify(b)});return{status:r.status,body:await r.json().catch(()=>({}))};};
const fresh=async()=>{const a=(await call("/api/auth/demo",{})).body;const H={authorization:"Bearer "+a.token};await call("/api/faucet",{},H);return{H,w:a.wallet};};
const PNG="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

// junk into every social route — nothing may 5xx
const victim = await fresh();
const junk=[null,0,-1,1e308,"x".repeat(5000),[],{},true,'" OR 1=1 --',"<script>alert(1)</script>","../../etc/passwd"];
let worst=0;
for (const j of junk) {
  for (const [p,b] of [["/api/ref",{mint:j,code:j}],["/api/ref/wallet",{code:j}],["/api/posts",{mint:j,text:j}],["/api/chat",{mint:j,text:j}]]) {
    const r=await call(p,b,victim.H); worst=Math.max(worst,r.status>=500?r.status:0);
  }
  const g=await call("/api/rep?w="+encodeURIComponent(String(j))); worst=Math.max(worst,g.status>=500?g.status:0);
  const m=await call("/api/milestones?mint="+encodeURIComponent(String(j))); worst=Math.max(worst,m.status>=500?m.status:0);
  const t=await call("/api/ref/top?mint="+encodeURIComponent(String(j))); worst=Math.max(worst,t.status>=500?t.status:0);
}
ok(worst===0, worst===0?"no social route 5xx'd on any junk input":"a route returned "+worst);

// an OG card for a nonsense mint must 404, not crash
const r1=await fetch(B+"/og/notamint.png"); ok(r1.status===404||r1.status===200, `bogus OG mint → ${r1.status}`);
const r2=await fetch(B+"/og/"+"1".repeat(44)+".png"); ok(r2.status===404, `well-formed but unknown OG mint → ${r2.status}`);

// a sybil farm over HTTP earns nothing
const farmer=await fresh();
const code=(await call("/api/ref/me",undefined,farmer.H)).body.summary.code;
const t=(await call("/api/tokens",{name:"Sybil Target",symbol:"SYB",image:PNG,quote:"SOL",fairOpenSecs:0,holderBps:200,creatorBps:100,vaultBps:0,burnBps:0,refShareBps:10000},(await fresh()).H)).body.token;
for (let i=0;i<6;i++){ const alt=await fresh(); await call("/api/ref",{mint:t.mint,code},alt.H); await call("/api/trade",{mint:t.mint,side:"buy",amount:0.02},alt.H); await new Promise(x=>setTimeout(x,260)); }
const st=(await call("/api/ref/me?mint="+t.mint,undefined,farmer.H)).body.token;
ok(st.brought===0, `six fresh wallets with dust buys vested nothing (${st.pending} pending)`);
const rep=(await call("/api/rep?w="+farmer.w)).body.reputation;
ok(rep.broughtBuyers===0, "and the farmer's public reputation shows zero");
const top=(await call("/api/ref/top?mint="+t.mint)).body.top;
ok(!top.some(x=>x.wallet===farmer.w), "they are absent from the leaderboard entirely");

// self-referral through the API
const solo=await fresh();
const myCode=(await call("/api/ref/me",undefined,solo.H)).body.summary.code;
const self=await call("/api/ref",{mint:t.mint,code:myCode},solo.H);
ok(self.body.boundTo!==solo.w, "a wallet cannot refer itself through the API");
const selfW=await call("/api/ref/wallet",{code:myCode},solo.H);
ok(selfW.body.boundTo!==solo.w, "nor at the platform level");
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail?1:0);
