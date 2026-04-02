#!/usr/bin/env node
// setup-wizard.js — cross-platform interactive setup (Windows / macOS / Linux)
//
// Usage:
//   node setup-wizard.js                              — interactive setup
//   node setup-wizard.js --keypair KEY --address ADDR — called by: node agent.js init
'use strict';

const fs       = require('fs');
const path     = require('path');
const readline = require('readline');

const SCRIPT_DIR = __dirname;
const ENV_FILE   = path.join(SCRIPT_DIR, '.env');
const CFG_BASE   = path.join(SCRIPT_DIR, 'config', 'agent.json');
const CFG_LOCAL  = path.join(SCRIPT_DIR, 'config', 'agent.local.json');

// ── ANSI colours (disabled on Windows if not supported) ───────────────────────
const hasColour = process.stdout.isTTY && process.platform !== 'win32'
  || process.env.FORCE_COLOR;

const G  = s => hasColour ? `\x1b[0;32m${s}\x1b[0m`  : s;  // green
const BG = s => hasColour ? `\x1b[1;32m${s}\x1b[0m`  : s;  // bright green
const Y  = s => hasColour ? `\x1b[1;33m${s}\x1b[0m`  : s;  // yellow
const R  = s => hasColour ? `\x1b[0;31m${s}\x1b[0m`  : s;  // red
const C  = s => hasColour ? `\x1b[0;36m${s}\x1b[0m`  : s;  // cyan
const D  = s => hasColour ? `\x1b[2m${s}\x1b[0m`     : s;  // dim
const B  = s => hasColour ? `\x1b[1m${s}\x1b[0m`     : s;  // bold

// ── Helpers ───────────────────────────────────────────────────────────────────

function envGet(key) {
  try {
    const line = fs.readFileSync(ENV_FILE, 'utf8').split('\n')
      .find(l => l.startsWith(key + '='));
    return line ? line.slice(key.length + 1).trim().replace(/^['"]|['"]$/g, '') : '';
  } catch { return ''; }
}

function cfgGet(dotKey) {
  function dig(obj, keys) {
    try { return keys.reduce((o, k) => o[k], obj) ?? ''; } catch { return ''; }
  }
  const keys = dotKey.split('.');
  let val = '';
  try { val = dig(JSON.parse(fs.readFileSync(CFG_LOCAL, 'utf8')), keys); } catch {}
  if (!val) {
    try { val = dig(JSON.parse(fs.readFileSync(CFG_BASE,  'utf8')), keys); } catch {}
  }
  return val || '';
}

function ask(rl, prompt) {
  return new Promise(resolve => rl.question(prompt, resolve));
}

function stepHeader(step, total, title) {
  console.log('');
  console.log(`  ${C(title)}  ${D('─'.repeat(40) + ` ${step} of ${total}`)}`);
  console.log('');
}

// ── Parse CLI args ─────────────────────────────────────────────────────────────

let keypairArg = '', addressArg = '';
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--keypair') keypairArg = process.argv[++i] ?? '';
  if (process.argv[i] === '--address') addressArg = process.argv[++i] ?? '';
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log(`  ${D('·'.repeat(49))}`);
  console.log(`  ${BG('██████╗ ██╗███████╗██╗  ██╗██╗   ██╗')}`);
  console.log(`  ${BG('██╔══██╗██║██╔════╝██║ ██╔╝╚██╗ ██╔╝')}`);
  console.log(`  ${BG('██████╔╝██║███████╗█████╔╝  ╚████╔╝ ')}`);
  console.log(`  ${BG('██╔═══╝ ██║╚════██║██╔═██╗   ╚██╔╝  ')}`);
  console.log(`  ${BG('██║     ██║███████║██║  ██╗   ██║    ')}`);
  console.log(`  ${BG('╚═╝     ╚═╝╚══════╝╚═╝  ╚═╝   ╚═╝   ')}`);
  console.log('');
  console.log(`  ${D('autonomous solana trading agent')}  ${G('·')}  ${D('setup wizard')}`);
  console.log(`  ${D('·'.repeat(49))}`);
  console.log('');

  if (addressArg) {
    console.log(`  ${Y('▸  new wallet address (save this!)')}`);
    console.log(`  ${BG(addressArg)}`);
    console.log('');
  }

  const isInteractive = process.stdin.isTTY;
  if (!isInteractive) {
    console.log(`  ${Y('⚠  Non-interactive mode — using defaults for all prompts.')}`);
    console.log(`  ${D('  Re-run: node agent.js setup   to change settings.')}`);
    console.log('');
  }

  const rl = readline.createInterface({
    input:  process.stdin,
    output: process.stdout,
    terminal: isInteractive,
  });

  // ── Step 1: Helius RPC URL ─────────────────────────────────────────────────
  stepHeader(1, 5, 'HELIUS RPC URL');
  console.log(`  ${D('Used for all Solana queries: wallet balance, token accounts, swap execution.')}`);
  console.log(`  ${D('A free Helius key gives you 50k credits/day — plenty for normal operation.')}`);
  console.log(`  ${D('Get one (30 seconds):')}  ${Y('https://helius.dev')}  ${D('→ sign up → copy RPC URL')}`);
  console.log('');

  const existingRpc = envGet('HELIUS_RPC_URL');
  let heliusRpcUrl;
  if (existingRpc) {
    console.log(`  ${D('current:')}  ${Y(existingRpc.slice(0, 55) + '…')}`);
    const ans = await ask(rl, '  New URL (Enter to keep): ');
    heliusRpcUrl = ans.trim() || existingRpc;
  } else {
    const ans = await ask(rl, '  Helius RPC URL (Enter to use public): ');
    heliusRpcUrl = ans.trim();
  }

  if (!heliusRpcUrl) {
    heliusRpcUrl = 'https://api.mainnet-beta.solana.com';
    console.log('');
    console.log(`  ${Y('⚠  Using Solana public RPC')}`);
    console.log(`  ${D('  This works but is heavily rate-limited — you may see:')}`);
    console.log(`  ${D('  · Slow balance checks and price lookups')}`);
    console.log(`  ${D('  · Failed swap transactions during high traffic')}`);
    console.log(`  ${D('  · Missed position exits if RPC times out')}`);
    console.log(`  ${D('  Add HELIUS_RPC_URL to .env later to upgrade.')}`);
  }
  console.log(`  ${G('✓  RPC configured')}`);

  // ── Step 2: LLM provider ──────────────────────────────────────────────────
  stepHeader(2, 5, 'LLM PROVIDER');
  console.log(`  ${D('The AI brain — used for Telegram chat, reflection, and exception handling.')}`);
  console.log('');
  console.log(`  ${G('1')}  ${B('OpenRouter')}  ${D('·  cloud, 100+ models, API key required')}`);
  console.log(`  ${G('2')}  ${B('Ollama')}      ${D('·  local model, no API cost, GPU recommended')}`);
  console.log('');

  const existingProvider = cfgGet('llm.provider') || 'openrouter';
  const provChoice = await ask(rl, `  Choose [1-2]  (Enter = ${existingProvider}): `);
  const llmProvider = provChoice.trim() === '2' ? 'ollama'
    : provChoice.trim() === '1' ? 'openrouter'
    : existingProvider;

  let openrouterKey = '';
  let ollamaBaseUrl = '';

  if (llmProvider === 'openrouter') {
    console.log('');
    console.log(`  ${D('Get a free key at')}  ${Y('https://openrouter.ai/keys')}`);
    const existingOr = envGet('OPENROUTER_API_KEY');
    if (existingOr) {
      console.log(`  ${D('current:')}  ${Y(existingOr.slice(0, 14) + '…')}`);
      const ans = await ask(rl, '  New key (Enter to keep): ');
      openrouterKey = ans.trim() || existingOr;
    } else {
      const ans = await ask(rl, '  OpenRouter API key (sk-or-…): ');
      openrouterKey = ans.trim();
    }
    if (!openrouterKey) {
      console.log(`  ${Y('⚠  No key set — LLM features disabled until added')}`);
    }
  } else {
    console.log('');
    console.log(`  ${D('Install a model first:')}  ollama pull qwen2.5:7b`);
    const existingUrl = cfgGet('llm.baseUrl') || 'http://localhost:11434/v1';
    const ans = await ask(rl, `  Ollama URL (Enter = ${existingUrl}): `);
    ollamaBaseUrl = ans.trim() || existingUrl;
  }
  console.log(`  ${G('✓  Provider:')} ${BG(llmProvider)}`);

  // ── Step 3: AI model ──────────────────────────────────────────────────────
  stepHeader(3, 5, 'AI MODEL');
  let agentModel;

  if (llmProvider === 'ollama') {
    console.log(`  ${D('Model must be pulled first:')}  ollama pull <name>`);
    console.log('');
    console.log(`  ${G('1')}  qwen2.5:7b    ${D('·  best tool use    ·  4.7 GB')}`);
    console.log(`  ${G('2')}  llama3.2:3b   ${D('·  fastest          ·  2 GB')}`);
    console.log(`  ${G('3')}  qwen2.5:14b   ${D('·  best quality     ·  9 GB')}`);
    console.log(`  ${G('4')}  llama3.1:8b   ${D('·  reliable         ·  4.7 GB')}`);
    console.log(`  ${G('5')}  Custom        ${D('·  enter any Ollama model name')}`);
    console.log('');
    const mc = await ask(rl, '  Choose [1-5]  (Enter = 1): ');
    if (mc.trim() === '2') agentModel = 'llama3.2:3b';
    else if (mc.trim() === '3') agentModel = 'qwen2.5:14b';
    else if (mc.trim() === '4') agentModel = 'llama3.1:8b';
    else if (mc.trim() === '5') { const m = await ask(rl, '  Model name: '); agentModel = m.trim(); }
    else agentModel = 'qwen2.5:7b';
  } else {
    console.log(`  ${D('Recommended models:')}`);
    console.log('');
    console.log(`  ${G('1')}  anthropic/claude-sonnet-4-6   ${D('·  best reasoning + tool use')}`);
    console.log(`  ${G('2')}  x-ai/grok-4.1-fast            ${D('·  very fast, strong analysis')}`);
    console.log(`  ${G('3')}  google/gemini-2.0-flash       ${D('·  free tier, capable')}`);
    console.log(`  ${G('4')}  Custom                        ${D('·  enter any OpenRouter model ID')}`);
    console.log('');
    const mc = await ask(rl, '  Choose [1-4]  (Enter = 1): ');
    if (mc.trim() === '2') agentModel = 'x-ai/grok-4.1-fast';
    else if (mc.trim() === '3') agentModel = 'google/gemini-2.0-flash';
    else if (mc.trim() === '4') { const m = await ask(rl, '  Model ID: '); agentModel = m.trim(); }
    else agentModel = 'anthropic/claude-sonnet-4-6';
  }
  console.log(`  ${G('✓  Model:')} ${BG(agentModel)}`);

  // ── Step 4: Telegram ──────────────────────────────────────────────────────
  stepHeader(4, 5, 'TELEGRAM  (optional)');
  console.log(`  ${D('Chat interface, trade alerts, and heartbeat messages.')}`);
  console.log(`  ${D('Create a bot:')}  Telegram → ${Y('@BotFather')} → /newbot`);
  console.log('');

  const existingTg = envGet('TELEGRAM_BOT_TOKEN');
  let tgToken = '';
  if (existingTg) {
    console.log(`  ${D('current:')}  ${Y(existingTg.slice(0, 12) + '…')}`);
    const ans = await ask(rl, '  New token (Enter to keep): ');
    tgToken = ans.trim() || existingTg;
  } else {
    const ans = await ask(rl, '  Bot token (Enter to skip): ');
    tgToken = ans.trim();
  }

  let tgChatId = '';
  if (tgToken) {
    console.log('');
    console.log(`  ${D('Your Telegram user ID — used to receive heartbeat messages.')}`);
    console.log(`  ${D('Get it:')}  Telegram → ${Y('@userinfobot')} → /start`);
    const ans = await ask(rl, '  Your Telegram user ID (Enter to skip): ');
    tgChatId = ans.trim();
    console.log(`  ${G('✓  Telegram enabled')}`);
  } else {
    console.log(`  ${D('Skipped — add TELEGRAM_BOT_TOKEN to .env later to enable.')}`);
  }

  // ── Step 5: PISKY Data API ────────────────────────────────────────────────
  stepHeader(5, 5, 'PISKY DATA API');
  console.log(`  ${D('Market data, rug checks, swarm intelligence, and token analysis.')}`);
  console.log('');
  console.log(`  ${G('public')}       ${B('https://api.pisky.xyz')}  ${D('·  requires PISKY balance')}`);
  console.log(`  ${G('self-hosted')}  http://localhost:18700  ${D('·  free if running pisky-data-api locally')}`);
  console.log('');

  const existingBase = cfgGet('api.baseUrl') || 'https://api.pisky.xyz';
  console.log(`  ${D('current:')}  ${Y(existingBase)}`);
  const apiAns = await ask(rl, '  API base URL (Enter to keep): ');
  const apiBase = apiAns.trim() || existingBase;

  const existingIk = envGet('PISKY_INTERNAL_KEY');
  let piskyInternalKey = existingIk;
  {
    const ikAns = await ask(rl, '  Internal key for self-hosted bypass (Enter to skip): ');
    const ikTrimmed = ikAns.trim();
    if (ikTrimmed) {
      if (ikTrimmed.startsWith('pnk_') || ikTrimmed.startsWith('MCow')) {
        console.log(`  ${R('✗  That looks like a node keypair (pnk_/MCow…), not an internal key.')}`);
        console.log(`  ${D('  Find your key: pisky-data-api/.env → PISKY_DATA_API_INTERNAL_KEY')}`);
        console.log(`  ${D('  Keeping previous value.')}`);
      } else {
        piskyInternalKey = ikTrimmed;
      }
    }
  }
  console.log(`  ${G('✓  API:')} ${BG(apiBase)}`);

  rl.close();

  // ── Write .env ─────────────────────────────────────────────────────────────
  console.log('');
  console.log(`  ${D('writing .env …')}`);

  const keypair     = keypairArg || envGet('AGENT_KEYPAIR');
  const existingJup = envGet('JUPITER_API_KEY');

  const envContent = [
    `# pisky-agent environment — updated ${new Date().toISOString()}`,
    `AGENT_KEYPAIR=${keypair}`,
    `HELIUS_RPC_URL=${heliusRpcUrl}`,
    `OPENROUTER_API_KEY=${openrouterKey}`,
    `TELEGRAM_BOT_TOKEN=${tgToken}`,
    `PISKY_INTERNAL_KEY=${piskyInternalKey}`,
    `JUPITER_API_KEY=${existingJup}`,
  ].join('\n') + '\n';

  fs.writeFileSync(ENV_FILE, envContent);
  console.log(`  ${G('✓  .env written')}`);

  // ── Write config/agent.local.json ─────────────────────────────────────────
  let local = {};
  try { if (fs.existsSync(CFG_LOCAL)) local = JSON.parse(fs.readFileSync(CFG_LOCAL, 'utf8')); } catch {}

  local.llm           = local.llm ?? {};
  local.llm.model     = agentModel;
  local.llm.provider  = llmProvider;
  if (ollamaBaseUrl)  local.llm.baseUrl = ollamaBaseUrl;

  local.telegram      = local.telegram ?? {};
  if (tgChatId)       local.telegram.heartbeatChatId = tgChatId;

  local.api           = local.api ?? {};
  local.api.baseUrl   = apiBase;

  fs.writeFileSync(CFG_LOCAL, JSON.stringify(local, null, 2) + '\n');
  console.log(`  ${G('✓  config/agent.local.json updated')}`);

  // ── Done ──────────────────────────────────────────────────────────────────
  console.log('');
  console.log('');
  console.log(`  ${D('─'.repeat(49))}`);
  console.log(`  ${BG('✓  AGENT READY')}`);
  console.log(`  ${D('─'.repeat(49))}`);
  console.log('');

  if (addressArg) {
    console.log(`  ${Y('┌─  FUND YOUR AGENT WALLET  ─────────────────────────────────┐')}`);
    console.log(`  ${Y('│')}  ${BG(addressArg)}`);
    console.log(`  ${Y('│')}`);
    console.log(`  ${Y('│')}  Send at least ${B('0.05 SOL')} to this address before starting`);
    console.log(`  ${Y('│')}  (covers transaction fees + a few initial trades)`);
    console.log(`  ${Y('└────────────────────────────────────────────────────────────┘')}`);
    console.log('');
    console.log(`  ${D('⚠  Back up your private key:')}  open .env and copy AGENT_KEYPAIR`);
    console.log('');
  }

  console.log(`  ${D('next steps')}`);
  console.log(`  ${C('  1.')} Fund the wallet above with SOL`);
  console.log(`  ${C('  2.')} ${BG('node agent.js start')}  — launch the agent`);
  console.log(`  ${C('  3.')} ${BG('node agent.js setup')}  — change any settings later`);
  console.log('');
  console.log(`  ${D('optional')}`);
  console.log(`  ${D('  personality')}   cp soul.md soul.local.md`);
  if (process.platform !== 'win32') {
    console.log(`  ${D('  as service')}    systemctl --user enable --now pisky-agent`);
  } else {
    console.log(`  ${D('  as service')}    see docs/windows-service.md`);
  }
  console.log('');
}

main().catch(e => { console.error('Wizard error:', e.message); process.exit(1); });
