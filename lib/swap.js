// lib/swap.js — Jupiter Ultra swap execution for pisky-agent
// Buy: SOL → token via Jupiter Ultra /order + /execute
// Sell: token → SOL via Jupiter Ultra
'use strict';

const { PublicKey, VersionedTransaction, Connection } = require('@solana/web3.js');
const bs58 = require('bs58').default ?? require('bs58');

const SOL_MINT  = 'So11111111111111111111111111111111111111112';
const ULTRA_BASE = 'https://api.jup.ag/ultra/v1';

const log = (level, msg, data = {}) => {
  const ts   = new Date().toISOString();
  const line = Object.keys(data).length ? `${msg} ${JSON.stringify(data)}` : msg;
  process.stdout.write(`[${ts}] [SWAP] [${level.toUpperCase()}] ${line}\n`);
};

class SwapExecutor {
  /**
   * @param {object} opts
   *   keypair    — Solana keypair
   *   connection — Connection
   *   jupApiKey  — optional Jupiter API key (higher rate limits)
   *   slippageBps — default slippage (100 = 1%)
   */
  constructor(opts) {
    this.keypair     = opts.keypair;
    this.connection  = opts.connection;
    this.jupApiKey   = opts.jupApiKey ?? '';
    this.slippageBps = opts.slippageBps ?? 100;
    this.pubkey      = this.keypair.publicKey.toBase58();
  }

  _headers() {
    const h = { 'Content-Type': 'application/json' };
    if (this.jupApiKey) h['x-api-key'] = this.jupApiKey;
    return h;
  }

  // ── Get order quote ─────────────────────────────────────────────────────────

  async _getOrder(inputMint, outputMint, amount, slippageBps) {
    const url = `${ULTRA_BASE}/order?` + new URLSearchParams({
      inputMint,
      outputMint,
      amount:      amount.toString(),
      slippageBps: slippageBps.toString(),
      taker:       this.pubkey,
    });
    const resp = await fetch(url, { headers: this._headers(), signal: AbortSignal.timeout(15_000) });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Jupiter order ${resp.status}: ${body.slice(0, 200)}`);
    }
    return resp.json();
  }

  // ── Execute order ──────────────────────────────────────────────────────────

  async _executeOrder(order) {
    // Deserialize + sign
    const txBytes  = Buffer.from(order.transaction, 'base64');
    const tx       = VersionedTransaction.deserialize(txBytes);
    tx.sign([this.keypair]);

    const resp = await fetch(`${ULTRA_BASE}/execute`, {
      method:  'POST',
      headers: this._headers(),
      body:    JSON.stringify({
        signedTransaction: Buffer.from(tx.serialize()).toString('base64'),
        requestId:         order.requestId,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Jupiter execute ${resp.status}: ${body.slice(0, 200)}`);
    }
    const result = await resp.json();
    if (result.status !== 'Success') {
      throw new Error(`Swap failed: ${result.error ?? result.status}`);
    }
    return result;
  }

  // ── Buy: SOL → token ────────────────────────────────────────────────────────

  /**
   * Buy a token using SOL.
   * @param {string} mint       — token mint address
   * @param {number} solAmount  — amount of SOL to spend
   * @returns {{ txSig, inAmount, outAmount, pricePerToken, mint }}
   */
  async buy(mint, solAmount) {
    const lamports = Math.floor(solAmount * 1e9);
    log('info', 'Buy order', { mint: mint.slice(0, 8) + '…', sol: solAmount });

    const order  = await this._getOrder(SOL_MINT, mint, lamports, this.slippageBps);
    const result = await this._executeOrder(order);

    const inLamports  = Number(result.inputAmount  ?? order.inAmount  ?? 0);
    const outTokens   = Number(result.outputAmount ?? order.outAmount ?? 0);
    const solSpent    = inLamports / 1e9;

    log('info', 'Buy executed', {
      txSig:     result.signature?.slice(0, 16) + '…',
      solSpent:  solSpent.toFixed(6),
      tokensOut: outTokens,
    });

    return {
      txSig:         result.signature,
      inAmount:      solSpent,
      outAmount:     outTokens,
      pricePerToken: outTokens > 0 ? solSpent / outTokens : null,
      mint,
    };
  }

  // ── Sell: token → SOL ───────────────────────────────────────────────────────

  /**
   * Sell a percentage of a held token position.
   * @param {string} mint        — token mint address
   * @param {number} tokenAmount — raw token amount (atomic units)
   * @param {number} pct         — fraction to sell (0–1, default 1 = 100%)
   * @returns {{ txSig, inAmount, outAmount, solReceived }}
   */
  async sell(mint, tokenAmount, pct = 1) {
    const sellAmount = Math.floor(tokenAmount * pct);
    if (sellAmount === 0) throw new Error('Sell amount is 0');

    log('info', 'Sell order', { mint: mint.slice(0, 8) + '…', pct: (pct * 100).toFixed(0) + '%' });

    const order  = await this._getOrder(mint, SOL_MINT, sellAmount, this.slippageBps);
    const result = await this._executeOrder(order);

    const outLamports = Number(result.outputAmount ?? order.outAmount ?? 0);
    const solReceived = outLamports / 1e9;

    log('info', 'Sell executed', {
      txSig:       result.signature?.slice(0, 16) + '…',
      solReceived: solReceived.toFixed(6),
    });

    return {
      txSig:       result.signature,
      inAmount:    sellAmount,
      outAmount:   outLamports,
      solReceived,
    };
  }

  // ── Get token balance ──────────────────────────────────────────────────────

  async getTokenBalance(mint) {
    try {
      const mintPk = new PublicKey(mint);
      // Try standard Token program first, then Token-2022
      for (const programId of [
        'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
      ]) {
        const accounts = await this.connection.getTokenAccountsByOwner(
          this.keypair.publicKey,
          { mint: mintPk },
          { programId: new PublicKey(programId) },
        );
        if (accounts.value.length) {
          const info = await this.connection.getTokenAccountBalance(accounts.value[0].pubkey);
          return {
            rawAmount: BigInt(info.value.amount),
            uiAmount:  parseFloat(info.value.uiAmount ?? 0),
            decimals:  info.value.decimals,
            ataAddress: accounts.value[0].pubkey.toBase58(),
          };
        }
      }
      return { rawAmount: BigInt(0), uiAmount: 0, decimals: 0, ataAddress: null };
    } catch (err) {
      log('warn', 'Token balance check failed', { mint: mint.slice(0, 8), error: err.message });
      return { rawAmount: BigInt(0), uiAmount: 0, decimals: 0, ataAddress: null };
    }
  }
}

module.exports = { SwapExecutor, SOL_MINT };
