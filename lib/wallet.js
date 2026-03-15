// lib/wallet.js — Solana wallet management for pisky-agent
// Loads keypair from AGENT_KEYPAIR env var (base58 private key).
// Tracks SOL + PISKY (Token-2022) balances.
'use strict';

const { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const bs58 = require('bs58').default ?? require('bs58');
const fs   = require('fs');

const { PISKY_MINT, TOKEN2022_PID } = require('./pisky');
const TOKEN2022 = new PublicKey(TOKEN2022_PID);

const log = (level, msg, data = {}) => {
  const ts   = new Date().toISOString();
  const line = Object.keys(data).length ? `${msg} ${JSON.stringify(data)}` : msg;
  process.stdout.write(`[${ts}] [WALLET] [${level.toUpperCase()}] ${line}\n`);
};

class WalletManager {
  constructor(rpcUrl, privateKeyBase58) {
    this.connection = new Connection(rpcUrl, { commitment: 'confirmed' });
    this.keypair    = Keypair.fromSecretKey(bs58.decode(privateKeyBase58));
    this.publicKey  = this.keypair.publicKey;
    this.address    = this.publicKey.toBase58();
    log('info', 'Wallet loaded', { address: this.address.slice(0, 8) + '…' });
  }

  // ── SOL balance ─────────────────────────────────────────────────────────────

  async getSolBalance() {
    try {
      const lamports = await this.connection.getBalance(this.publicKey, 'confirmed');
      return lamports / LAMPORTS_PER_SOL;
    } catch (err) {
      log('warn', 'getSolBalance failed', { error: err.message });
      throw err;
    }
  }

  // ── PISKY balance (Token-2022) ──────────────────────────────────────────────

  async getPiskyBalance() {
    try {
      const mint = new PublicKey(PISKY_MINT);
      const accounts = await this.connection.getTokenAccountsByOwner(
        this.publicKey,
        { mint },
        { programId: TOKEN2022 },
      );
      if (!accounts.value.length) return 0;
      const info = await this.connection.getTokenAccountBalance(
        accounts.value[0].pubkey, 'confirmed',
      );
      return parseFloat(info.value.uiAmount ?? 0);
    } catch (err) {
      log('warn', 'PISKY balance check failed', { error: err.message });
      return 0;
    }
  }

  // ── All balances snapshot ───────────────────────────────────────────────────

  async getBalances() {
    const [sol, pisky] = await Promise.all([
      this.getSolBalance(),
      this.getPiskyBalance(),
    ]);
    return { sol, pisky, address: this.address };
  }

  // ── Summary log ────────────────────────────────────────────────────────────

  async logBalances() {
    const b = await this.getBalances();
    log('info', 'Balances', {
      sol:   b.sol.toFixed(4) + ' SOL',
      pisky: b.pisky.toLocaleString() + ' PISKY',
    });
    return b;
  }

  // ── Check minimum balances ─────────────────────────────────────────────────

  async checkMinimums(cfg) {
    const b = await this.getBalances();
    const warnings = [];

    if (b.sol < 0.05) {
      warnings.push(`LOW SOL: ${b.sol.toFixed(4)} SOL — agent needs SOL for tx fees and trades`);
    }
    if (b.pisky < (cfg.pisky?.minPiskyBalance ?? 5000)) {
      warnings.push(`LOW PISKY: ${b.pisky.toLocaleString()} — top up to pay for API calls`);
    }
    return { balances: b, warnings };
  }
}

// ── Load from env / file ─────────────────────────────────────────────────────

function loadWallet(rpcUrl) {
  const key = process.env.AGENT_KEYPAIR;
  if (!key) {
    throw new Error(
      'AGENT_KEYPAIR env var not set.\n' +
      'Set it to your base58-encoded private key:\n' +
      '  export AGENT_KEYPAIR="your-base58-private-key"\n' +
      'Or add it to your .env file.',
    );
  }
  const w = new WalletManager(rpcUrl, key);
  // Key is now decoded into w.keypair — scrub the raw string from process.env
  // so it can't be leaked via tools, scripts, or prompt injection.
  delete process.env.AGENT_KEYPAIR;
  return w;
}

module.exports = { WalletManager, loadWallet };
