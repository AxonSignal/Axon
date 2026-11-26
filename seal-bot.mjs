// Seal bot: closes finished hours, writes each root on Robinhood Chain with `cast`, reports the tx to the site.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL_BASE = (process.env.AXON_URL || fs.readFileSync('.site-url', 'utf8')).trim().replace(/\/+$/, '');
const TOKEN = fs.readFileSync('.bot-token', 'utf8').trim();
const CONTRACT = (fs.readFileSync('wrangler.toml', 'utf8').match(/SEAL_CONTRACT = "(0x[0-9a-fA-F]{40})"/) || [])[1];
const RPC = 'https://rpc.mainnet.chain.robinhood.com';
const KEYSTORE = path.join(os.homedir(), '.foundry', 'keystores', 'axon');
const PW = process.env.AXON_PW_FILE;
const JOURNAL = '.sealed.json';
const EVERY = 5 * 60 * 1000;

if (!CONTRACT) { console.error('Deploie d\'abord le contrat : ./deploy-contract.sh'); process.exit(1); }
const log = (...a) => console.log(new Date().toLocaleTimeString('en-GB'), ...a);
const H = { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' };
const journal = fs.existsSync(JOURNAL) ? JSON.parse(fs.readFileSync(JOURNAL, 'utf8')) : {};
const save = () => fs.writeFileSync(JOURNAL, JSON.stringify(journal, null, 2));

async function confirm(hour, tx) {
  const r = await fetch(URL_BASE + '/api/bot/confirm', { method: 'POST', headers: H, body: JSON.stringify({ hour, tx }) });
  if (!r.ok) throw new Error('confirm ' + r.status);
}

async function tick() {
  await fetch(URL_BASE + '/api/bot/seal', { method: 'POST', headers: H });
  const r = await fetch(URL_BASE + '/api/bot/pending', { headers: H });
  if (!r.ok) { log('Site unreachable', r.status); return; }
  const { seals } = await r.json();
  for (const s of seals) {
    if (journal[s.hour]) { await confirm(s.hour, journal[s.hour]); log('Seal', s.hour, 'confirmed again'); continue; }
    try {
      const out = execFileSync('cast', ['send', CONTRACT, 'seal(uint64,bytes32,uint32)', String(s.hour), '0x' + s.root, String(s.reads),
        '--rpc-url', RPC, '--keystore', KEYSTORE, '--password-file', PW, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      const tx = JSON.parse(out).transactionHash;
      journal[s.hour] = tx; save();
      await confirm(s.hour, tx);
      log(`Seal ${s.hour} written (${s.reads} reads): ${tx}`);
    } catch (e) {
      log('Seal failed', s.hour, String(e.stderr || e.message).split('\n').slice(-3).join(' '));
    }
  }
}

log('AXON seal bot running on', URL_BASE, 'contract', CONTRACT);
await tick().catch((e) => log('Error', e.message));
setInterval(() => tick().catch((e) => log('Error', e.message)), EVERY);
