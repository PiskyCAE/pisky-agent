// agent.js — pisky-agent: LLM-powered Solana trading agent
// Powered by PISKY Data API + OpenRouter + Telegram
//
// Architecture:
//   Telegram / Heartbeat → queue/incoming → LLM processor (tool-use) → queue/outgoing → Telegram
//
// Usage:
//   node agent.js init      — generate wallet, run setup wizard, register with swarm
//   node agent.js start     — start full agent (processor + Telegram + heartbeat)
//   node agent.js setup     — re-run setup wizard to update settings
//   node agent.js wallet    — show wallet balances
//   node agent.js status    — show open positions + P&L
//   node agent.js scan      — run one market scan and print candidates
//   node agent.js send "x"  — queue a manual message through the LLM
'use strict';

process.stdout.on('error', e => { if (e.code !== 'EPIPE') throw e; });

const fs   = require('fs');
const path = require('path');

// ── Load .env ─────────────────────────────────────────────────────────────────

const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.+)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
}

// ── Config ────────────────────────────────────────────────────────────────────
// config/agent.json       — repo defaults (updated by git pull)
// config/agent.local.json — your overrides (gitignored, never touched by updates)
// Values in agent.local.json deep-merge over agent.json, so you only need to
// include the keys you want to change — not the entire config.

const { loadConfig } = require('./lib/config');
let cfg = loadConfig();

const RPC_URL      = process.env.HELIUS_RPC_URL     || 'https://api.mainnet-beta.solana.com';
const INTERNAL_KEY = process.env.PISKY_INTERNAL_KEY || '';
const JUP_API_KEY  = process.env.JUPITER_API_KEY    || '';
const TG_TOKEN     = process.env.TELEGRAM_BOT_TOKEN || cfg.telegram?.token || '';
// PISKY_API_URL env var overrides config (useful for self-hosted / localhost deployments)
if (process.env.PISKY_API_URL) cfg.api.baseUrl = process.env.PISKY_API_URL;

// ── Modules ───────────────────────────────────────────────────────────────────

const { PiskyClient }  = require('./lib/pisky');
const { loadWallet }   = require('./lib/wallet');
const { SwapExecutor } = require('./lib/swap');
const positions        = require('./lib/positions');
const profile          = require('./lib/profile');

// ── Version ───────────────────────────────────────────────────────────────────

const PKG_VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version ?? '0.0.0'; }
  catch { return '0.0.0'; }
})();

// ── Logger ────────────────────────────────────────────────────────────────────

const log = (level, msg, data = {}) => {
  const ts   = new Date().toISOString();
  const line = Object.keys(data).length ? `${msg} ${JSON.stringify(data)}` : msg;
  process.stdout.write(`[${ts}] [AGENT] [${level.toUpperCase()}] ${line}\n`);
};

// ── Shared runtime state ──────────────────────────────────────────────────────

let wallet = null;
let api    = null;
let swap   = null;

function initModules() {
  wallet = loadWallet(RPC_URL);
  api    = new PiskyClient({
    baseUrl:     cfg.api.baseUrl,
    internalKey: INTERNAL_KEY,
    wallet:      { keypair: wallet.keypair, connection: wallet.connection },
  });
  swap = new SwapExecutor({
    keypair:     wallet.keypair,
    connection:  wallet.connection,
    jupApiKey:   JUP_API_KEY,
    slippageBps: cfg.strategy?.slippageBps ?? 100,
  });
  log('info', 'Agent initialized', { address: wallet.address.slice(0, 8) + '…', apiBase: cfg.api.baseUrl });
}

function makeCtx() {
  return { api, wallet, swap, positions, cfg };
}

// ── CLI: init — generate wallet + setup + register ────────────────────────────

async function cmdInit() {
  const { Keypair } = require('@solana/web3.js');
  const bs58 = require('bs58').default ?? require('bs58');

  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
    if (content.includes('AGENT_KEYPAIR=') && !/AGENT_KEYPAIR=\s*$/.test(content)) {
      console.error('\nERROR: .env already contains AGENT_KEYPAIR.');
      console.error('Delete or back up .env before running init again.\n');
      process.exit(1);
    }
  }

  const kp      = Keypair.generate();
  const address = kp.publicKey.toBase58();
  const privB58 = bs58.encode(kp.secretKey);

  console.log('\n=== pisky-agent init ===\n');
  console.log(`New wallet: ${address}`);

  // Run setup wizard (it writes .env with keypair + other settings)
  const wizardPath = path.join(__dirname, 'setup-wizard.sh');
  if (fs.existsSync(wizardPath)) {
    const { spawnSync } = require('child_process');
    const r = spawnSync('bash', [wizardPath, '--keypair', privB58, '--address', address], { stdio: 'inherit' });
    if (r.status !== 0) { console.error('Setup wizard failed'); process.exit(1); }
  } else {
    const envContent = [
      '# pisky-agent — generated by: node agent.js init',
      `AGENT_KEYPAIR=${privB58}`,
      `HELIUS_RPC_URL=`,
      `JUPITER_API_KEY=`,
      `PISKY_INTERNAL_KEY=`,
      `TELEGRAM_BOT_TOKEN=`,
      `OPENROUTER_API_KEY=`,
    ].join('\n') + '\n';
    fs.writeFileSync(envPath, envContent);
    console.log('✓ .env written (edit it to add your API keys)\n');
  }

  // Save identity
  const identityFile = path.join(__dirname, 'data/agent-identity.json');
  fs.mkdirSync(path.dirname(identityFile), { recursive: true });

  // Register with swarm
  let agentId = null;
  try {
    const resp = await fetch(`${cfg.api.baseUrl}/api/agents/register`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ address, version: PKG_VERSION, createdAt: new Date().toISOString() }),
      signal:  AbortSignal.timeout(8000),
    });
    if (resp.ok) {
      const d = await resp.json();
      agentId  = d.agentId;
      console.log(`\n✓ Registered with PISKY swarm — agent ID: ${agentId}`);
    }
  } catch { console.log('  (registry unavailable — will register on first start)'); }

  const createdAt = new Date().toISOString();
  fs.writeFileSync(identityFile, JSON.stringify({ address, agentId, createdAt }, null, 2));

  // Bootstrap agent profile (data/agent-profile.json)
  const profileFile = path.join(__dirname, 'data/agent-profile.json');
  if (!fs.existsSync(profileFile)) {
    const initProfile = {
      version: 1,
      schema:  'pisky-agent-profile/v1',
      identity: {
        name:        'pisky-agent',
        handle:      '',
        role:        'autonomous-trader',
        description: 'LLM-powered Solana trading agent on the PISKY network.',
        createdAt,
        deviceId:    agentId ?? address,
      },
      specialization: {
        domains:    ['solana-trading', 'market-analysis'],
        tools:      ['jupiter-ultra', 'dexscreener', 'rugcheck', 'helius-das'],
        skills:     ['dip-reversal', 'swarm-analyst'],
        strategies: ['dip-reversal', 'trailing-stop'],
      },
      maturity: {
        trustLevel:        'signal',
        autonomyLevel:     'moderate',
        sessionsCompleted: 0,
        daysOperational:   0,
        generationNotes:   '',
      },
      authority: {
        canTrade:              true,
        maxTradeSolPerEntry:   cfg.strategy?.entryBudgetSol ?? 0.005,
        maxConcurrentPositions: cfg.strategy?.maxOpenPositions ?? 3,
        canSendMessages:       true,
        canModifyOwnConfig:    true,
        canDelegate:           false,
        canCoordinate:         false,
      },
      swarm: {
        role:                 'primary',
        coordinatedBy:        null,
        peersKnown:           [],
        minReputationToFollow: cfg.swarm?.minReputationToFollow ?? 40,
        publishesSignals:     cfg.swarm?.autoPublish ?? true,
        readsSignals:         cfg.swarm?.enabled ?? true,
      },
      model: {
        primary:       cfg.llm?.model    ?? 'x-ai/grok-4.1-fast',
        fallback:      null,
        contextWindow: null,
        thinkingMode:  'off',
      },
      performance: {
        trading: {
          closedPositions: 0, wins: 0, losses: 0,
          winRate: 0, avgPnlPct: 0, avgWinPct: 0, avgLossPct: 0, totalPnlPct: 0,
          firstTradeAt: null, lastTradeAt: null,
        },
        lastUpdated: null,
      },
      status: {
        current:      'active',
        healthFlags:  [],
        lastActiveAt: null,
        wallet:       address,
      },
    };
    fs.writeFileSync(profileFile, JSON.stringify(initProfile, null, 2));
    console.log('✓ Agent profile created (data/agent-profile.json)');
  }

  console.log('\n--- Fund your agent ---');
  console.log(`Address: ${address}`);
  console.log('Recommended: 0.05 SOL to start (covers fees + initial trades)');
  console.log('\nThen run: node agent.js start\n');
}

// ── CLI: setup — re-run wizard ────────────────────────────────────────────────

async function cmdSetup() {
  const wizardPath = path.join(__dirname, 'setup-wizard.sh');
  if (!fs.existsSync(wizardPath)) { console.error('setup-wizard.sh not found'); process.exit(1); }
  const { spawnSync } = require('child_process');
  spawnSync('bash', [wizardPath], { stdio: 'inherit' });
}

// ── CLI: wallet ───────────────────────────────────────────────────────────────

async function cmdWallet() {
  initModules();
  await wallet.logBalances();
  const { warnings } = await wallet.checkMinimums(cfg);
  if (warnings.length) { console.log('\nWarnings:'); warnings.forEach(w => console.log(' ⚠', w)); }
}

// ── CLI: status ───────────────────────────────────────────────────────────────

async function cmdStatus() {
  initModules();
  const held = positions.getAll();
  const keys = Object.keys(held);
  if (!keys.length) { console.log('No open positions.'); return; }
  console.log(`\nOpen positions (${keys.length}):\n`);
  for (const [mint, pos] of Object.entries(held)) {
    const mins = positions.holdMinutes(pos).toFixed(0);
    console.log(`  ${pos.symbol.padEnd(10)} ${mint.slice(0,8)}…  held ${mins}min  entry ${pos.solSpent.toFixed(4)} SOL  peak +${pos.peakPnlPct.toFixed(1)}%`);
  }
}

// ── CLI: scan ─────────────────────────────────────────────────────────────────

async function cmdScan() {
  initModules();
  log('info', 'Scanning…');
  const result = await api.scan({ limit: 20, minLiquidity: cfg.strategy?.minLiquidity ?? 10000 });
  const cands  = (result.candidates ?? []).slice(0, 5);
  if (!cands.length) { console.log('No candidates.'); return; }
  console.log(`\nTop ${cands.length} candidates:\n`);
  for (const c of cands) {
    console.log(`  ${(c.symbol ?? '?').padEnd(10)} ${c.mint.slice(0,8)}… | 1h: ${(c.priceChange1h ?? 0).toFixed(1)}% | liq: $${((c.liquidity ?? 0)/1000).toFixed(0)}k | ${c.verdict ?? c.rugRisk}`);
  }
}

// ── CLI: send — queue a manual message ───────────────────────────────────────

function cmdSend(message) {
  if (!message) { console.error('Usage: node agent.js send "your message"'); process.exit(1); }
  const { enqueue } = require('./lib/processor');
  enqueue('cli', 'User', 'cli', message);
  console.log(`Queued: "${message}"\nCheck logs/processor.log for response.`);
}

// ── Main: start — full agent launch ──────────────────────────────────────────

async function cmdStart() {
  initModules();

  log('info', `=== pisky-agent v${PKG_VERSION} starting ===`);
  try {
    await wallet.logBalances();
    const { warnings } = await wallet.checkMinimums(cfg);
    warnings.forEach(w => log('warn', w));
  } catch (e) {
    log('warn', `Startup balance check failed (will retry later): ${e.message}`);
  }

  // 1. Fetch startup context (market snapshot, trade summary, swarm stats)
  const agentCtxModule = require('./lib/context');
  try {
    await agentCtxModule.refresh(api);
  } catch (e) {
    log('warn', `Startup context failed: ${e.message}`);
  }
  // Refresh market context every 30 min in background (keeps heartbeat status current)
  const CTX_REFRESH_MS = (cfg.heartbeat?.contextRefreshMs ?? 30 * 60_000);
  setInterval(() => {
    agentCtxModule.refresh(api).catch(e => log('warn', `Context refresh failed: ${e.message}`));
  }, CTX_REFRESH_MS);

  // 2. Publish profile to swarm (non-blocking)
  profile.refreshAndPublish(api).catch(e => log('warn', `Profile publish: ${e.message}`));

  // 3. Queue processor (AI brain — must start first)
  const processor = require('./lib/processor');
  processor.start(makeCtx());

  // 4. Telegram channel
  let telegramBot = null;
  if (TG_TOKEN) {
    const telegram = require('./lib/telegram');
    telegramBot    = telegram.start(TG_TOKEN, makeCtx());
    log('info', 'Telegram channel enabled');
  } else {
    log('info', 'Telegram disabled — add TELEGRAM_BOT_TOKEN to .env or run: node agent.js setup');
  }

  // 5. Heartbeat
  const heartbeat = require('./lib/heartbeat');
  heartbeat.start(cfg, makeCtx(), telegramBot);

  // 6. Reflect loop (self-improvement + survival monitoring)
  const reflect = require('./lib/reflect');
  reflect.start(cfg, makeCtx(), telegramBot);

  // 7. Autonomous position monitor (deterministic — no LLM)
  const monitor = require('./lib/monitor');
  monitor.start(cfg, makeCtx(), telegramBot);

  // 8. Autonomous market scanner + auto-buyer (respects session strategy from agent-loop)
  const autoScanner = require('./lib/auto-scanner');
  autoScanner.start(cfg, makeCtx(), telegramBot);

  // 9. Agent loop — periodic LLM strategy reasoning (sets session_strategy.json)
  const agentLoop = require('./lib/agent-loop');
  agentLoop.start(cfg, makeCtx());

  log('info', 'Agent running', {
    address:    wallet.address.slice(0, 8) + '…',
    telegram:   TG_TOKEN ? 'on' : 'off',
    heartbeat:  `${(cfg.heartbeat?.intervalMs ?? 300_000) / 60_000}min`,
    monitor:    `${(cfg.strategy?.positionCheckMs ?? 30_000) / 1000}s`,
    scanner:    `${(cfg.strategy?.scanIntervalMs ?? 300_000) / 60_000}min`,
    agentLoop:  `${(cfg.agentLoop?.intervalMs ?? 90 * 60_000) / 60_000}min`,
    model:      cfg.llm?.model ?? '(not set)',
  });

  process.on('SIGINT',  () => { log('info', 'Shutdown'); process.exit(0); });
  process.on('SIGTERM', () => { log('info', 'Shutdown'); process.exit(0); });
}

// ── CLI: logs — recent agent activity in human-readable form ──────────────────

function cmdLogs() {
  const LOG_FILE = path.join(__dirname, 'logs/processor.log');
  const N        = parseInt(process.argv[3]) || 40;

  if (!fs.existsSync(LOG_FILE)) {
    console.log('No log file yet. Start the agent first: node agent.js start');
    return;
  }

  // Read tail of log file (last ~200KB is plenty)
  const stat = fs.statSync(LOG_FILE);
  const readSize = Math.min(stat.size, 200 * 1024);
  const buf  = Buffer.alloc(readSize);
  const fd   = fs.openSync(LOG_FILE, 'r');
  fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
  fs.closeSync(fd);
  const lines = buf.toString('utf8').split('\n').filter(Boolean);

  // Rules: match log line → human-readable label
  // Handler-generated lines are more specific (e.g. "buy_token ABC 0.005 SOL")
  // Processor generic lines have raw JSON — we skip those to avoid duplicates
  const RULES = [
    // Trade executions (handler-level lines, not the generic processor tool log)
    { re: /Tool: buy_token\s+(\S+)\s+([\d.]+) SOL/,   fmt: (m) => `BUY    ${m[1]}  ${m[2]} SOL` },
    { re: /Tool: sell_token\s+(\S+)\s+(\d+)%/,         fmt: (m) => `SELL   ${m[1]}  ${m[2]}% of position` },
    { re: /Tool: send_token\s+([\d.,]+)\s+→\s+(\S+)/,  fmt: (m) => `SEND   ${m[1]} tokens → ${m[2]}` },
    // Scanner
    { re: /Scan returned (\d+) candidate/,              fmt: (m) => `SCAN   ${m[1]} candidates found` },
    { re: /(\d+) candidates after filters/,             fmt: (m) => `SCAN   ${m[1]} passed filters` },
    { re: /No candidates passed/,                       fmt: ()  => `SCAN   no candidates passed gates` },
    // Reflect
    { re: /Done \[reflect\]/,                           fmt: ()  => `REFLECT  cycle complete` },
    // Heartbeat exceptions
    { re: /Status built — (\d+) exception/,             fmt: (m) => `HEARTBEAT  ${m[1]} exception(s)` },
    // Startup / shutdown
    { re: /=== pisky-agent v([\d.]+) starting ===/,     fmt: (m) => `STARTED  v${m[1]}` },
    { re: /\[AGENT\].*Shutdown/,                        fmt: ()  => `STOPPED` },
    // Telegram messages received
    { re: /\[TG\].*Message from (.+?):/,                fmt: (m) => `MSG    from ${m[1]}` },
    // Trading paused/resumed
    { re: /Trading paused/,                             fmt: ()  => `PAUSED   new buys paused` },
    { re: /Trading resumed/,                            fmt: ()  => `RESUMED  auto-scanner re-enabled` },
  ];

  const events = [];
  for (const line of lines) {
    const tsMatch = line.match(/^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
    if (!tsMatch) continue;
    const ts      = new Date(tsMatch[1]);
    const timeStr = ts.toLocaleString('en-US', {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
    for (const rule of RULES) {
      const m = line.match(rule.re);
      if (m) { events.push(`${timeStr}  ${rule.fmt(m)}`); break; }
    }
  }

  const recent = events.slice(-N);
  if (!recent.length) { console.log('No activity recorded yet.'); return; }

  console.log(`\nAgent activity — last ${recent.length} events:\n`);
  recent.forEach(e => console.log(' ', e));
  console.log();
}

// ── Entry ─────────────────────────────────────────────────────────────────────

const cmd     = process.argv[2];
const sendMsg = process.argv.slice(3).join(' ');

const handlers = {
  init:   cmdInit,
  setup:  cmdSetup,
  start:  cmdStart,
  wallet: cmdWallet,
  status: cmdStatus,
  scan:   cmdScan,
  send:   async () => cmdSend(sendMsg),
  logs:   async () => cmdLogs(),
};

(handlers[cmd] ?? cmdStart)().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
