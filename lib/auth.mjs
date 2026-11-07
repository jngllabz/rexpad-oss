import crypto from 'node:crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { db } from './db.mjs';
import { cfg } from './config.mjs';
export const signInMessage = (wallet, nonce) => `Sign in to ${cfg.brand}\n\nWallet: ${wallet}\nNonce: ${nonce}\n\nThis signature costs nothing and sends no transaction.`;
export const isWallet = (w) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(w || ''));
export function makeNonce(wallet) {
  const nonce = crypto.randomBytes(12).toString('hex');
  db.prepare('INSERT INTO nonces(nonce,wallet,ts) VALUES(?,?,?)').run(nonce, wallet, Date.now());
  db.prepare('DELETE FROM nonces WHERE ts < ?').run(Date.now() - 10 * 60 * 1000);
  return nonce;
}
export function verifySignature(wallet, nonce, signatureB58) {
  const row = db.prepare('SELECT wallet FROM nonces WHERE nonce=?').get(nonce);
  if (!row || row.wallet !== wallet) return false;
  let ok = false;
  try { ok = nacl.sign.detached.verify(new TextEncoder().encode(signInMessage(wallet, nonce)), bs58.decode(signatureB58), bs58.decode(wallet)); } catch { ok = false; }
  db.prepare('DELETE FROM nonces WHERE nonce=?').run(nonce);
  return ok;
}
export function createSession(wallet) {
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions(token,wallet,ts) VALUES(?,?,?)').run(token, wallet, Date.now());
  return token;
}
export function walletFromToken(token) {
  if (!token) return null;
  const row = db.prepare('SELECT wallet, ts FROM sessions WHERE token=?').get(token);
  if (!row || Date.now() - row.ts > 30 * 24 * 3600 * 1000) return null;
  return row.wallet;
}
export function dropSession(token) { db.prepare('DELETE FROM sessions WHERE token=?').run(token); }
