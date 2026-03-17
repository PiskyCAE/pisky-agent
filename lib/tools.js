// lib/tools.js — tool definitions + implementations for pisky-agent LLM
// Tools available to the AI:
//   Solana data:  scan_tokens, token_price, market_overview, network_stats, staking_yields, defi_overview, market_sentiment, oracle_prices
//   Research:     token_info, token_holders, token_chart, get_news, top_pools
//   Solana trade: check_wallet, buy_token, sell_token
//   Swarm:        read_swarm_feed, get_swarm_consensus, publish_signal, share_insight, swarm_leaderboard, get_my_reputation
//   Web:          web_search, fetch_url
//   Memory:       save_memory, recall_memories (per-user), save_note, recall_notes (agent self)
//   Self:         get_trade_history, update_config, pause_trading, resume_trading
//   Skills:       list_skills, load_skill
//   Tasks:        list_tasks, propose_task, claim_task, submit_task, verify_task
//   Builder:      read_file, list_files, write_file, run_script, install_package
'use strict';

const memory             = require('./memory');
const { loadIdentity }   = require('./profile');

// ── Tool result cache ─────────────────────────────────────────────────────────
// Prevents duplicate API calls when the LLM calls the same read-only tool
// multiple times within one session (e.g. heartbeat + reflect both call scan).
// Write/action tools (buy, sell, publish, etc.) are never cached.

const _toolCache = new Map();  // key → { result: string, expiresAt: number }

const TOOL_CACHE_TTL = {
  scan_tokens:          5 * 60_000,
  market_overview:      5 * 60_000,
  market_sentiment:    10 * 60_000,
  oracle_prices:        2 * 60_000,
  token_price:             30_000,
  network_stats:           60_000,
  staking_yields:      30 * 60_000,
  defi_overview:       15 * 60_000,
  token_info:          10 * 60_000,
  token_holders:        5 * 60_000,
  token_chart:          5 * 60_000,
  get_news:            15 * 60_000,
  top_pools:            5 * 60_000,
  read_swarm_feed:      2 * 60_000,
  get_swarm_consensus:     60_000,
  get_swarm_strategies: 3 * 60_000,
  swarm_leaderboard:    5 * 60_000,
  get_my_reputation:    5 * 60_000,
  get_swarm_blacklist:  2 * 60_000,
  check_blacklist:      2 * 60_000,
};

function _cacheKey(name, args) {
  return `${name}:${JSON.stringify(args ?? {})}`;
}

function _cacheGet(name, args) {
  const entry = _toolCache.get(_cacheKey(name, args));
  if (!entry || Date.now() > entry.expiresAt) return null;
  return entry.result;
}

function _cacheSet(name, args, result) {
  const ttl = TOOL_CACHE_TTL[name];
  if (!ttl) return;
  _toolCache.set(_cacheKey(name, args), { result, expiresAt: Date.now() + ttl });
  // Evict expired entries periodically (keep map from growing unbounded)
  if (_toolCache.size > 200) {
    const now = Date.now();
    for (const [k, v] of _toolCache) { if (now > v.expiresAt) _toolCache.delete(k); }
  }
}

// ── Tool definitions (OpenAI function-calling format) ─────────────────────────

const TOOL_DEFINITIONS = [
  // ── Solana data tools ──────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'scan_tokens',
      description: 'Scan for trending Solana tokens with dip-reversal signals. Returns candidates sorted by score with price changes, liquidity, volume, and safety ratings. Use this to find trading opportunities.',
      parameters: {
        type: 'object',
        properties: {
          limit:       { type: 'number',  description: 'Max results (default 20, max 50)' },
          minLiquidity:{ type: 'number',  description: 'Min liquidity in USD (default 10000)' },
          safeOnly:    { type: 'boolean', description: 'Only include RugCheck-safe tokens (default false)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'token_price',
      description: 'Get current price and 24h stats for a specific Solana token by mint address. Returns USD price from multiple sources (Jupiter, DexScreener, CoinGecko).',
      parameters: {
        type: 'object',
        properties: {
          mint: { type: 'string', description: 'The Solana token mint address' },
        },
        required: ['mint'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'market_overview',
      description: 'Get a broad Solana market overview: trending tokens on DexScreener, PumpFun, and GeckoTerminal. Good for understanding what is hot right now.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'network_stats',
      description: 'Get live Solana network statistics: TPS, slot height, validator count, epoch info, and network health.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'staking_yields',
      description: 'Get current staking APYs for Solana LSTs (mSOL, jitoSOL, bSOL, jupSOL) and native staking info. Useful for yield comparisons.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'defi_overview',
      description: 'Get Solana DeFi overview: top protocols by TVL (Raydium, Orca, Kamino, Drift, Marinade, etc.) and overall ecosystem stats.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'market_sentiment',
      description: 'Get crypto market sentiment: Fear & Greed index, LunarCrush social scores, and sentiment signals.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'oracle_prices',
      description: 'Get real-time Pyth oracle prices for SOL, BTC, ETH and other majors. Reliable on-chain price source.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  // ── Solana trade tools ─────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'check_wallet',
      description: 'Check your agent wallet: SOL balance, PISKY balance, and all open trading positions with current P&L.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'buy_token',
      description: 'Buy a Solana token using SOL via Jupiter Ultra. Execute autonomously based on your analysis — no user confirmation needed. Returns transaction signature on success.',
      parameters: {
        type: 'object',
        properties: {
          mint:      { type: 'string', description: 'Token mint address to buy' },
          solAmount: { type: 'number', description: 'Amount of SOL to spend (e.g. 0.01)' },
        },
        required: ['mint', 'solAmount'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'sell_token',
      description: 'Sell a held token position back to SOL via Jupiter Ultra. Execute autonomously based on your analysis — no user confirmation needed. Returns transaction signature on success.',
      parameters: {
        type: 'object',
        properties: {
          mint: { type: 'string', description: 'Token mint address to sell' },
          pct:  { type: 'number', description: 'Fraction to sell: 1.0 = 100%, 0.5 = 50% (default 1.0)' },
        },
        required: ['mint'],
      },
    },
  },
  // ── Web tools ──────────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web using DuckDuckGo. Use for current events, token news, protocol updates, or anything beyond training data. Do not say "I cannot access the internet" — use this tool.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'Fetch the text content of a specific URL. Use to read articles, docs, or any web page the user shares.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to fetch' },
        },
        required: ['url'],
      },
    },
  },
  // ── Skill tools ────────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'list_skills',
      description: 'List all available skills you can load. Use this to discover what knowledge is available before calling load_skill.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'load_skill',
      description: 'Load a specialized skill/strategy context to guide your current task. Call list_skills first to see available skill names. Skills cover: dip-reversal, momentum-trading, scalping, exit-strategy, yield-farming, market-analysis, position-management, rug-detection, swarm-analyst, survival, builder, playwright, infisical.',
      parameters: {
        type: 'object',
        properties: {
          skill: { type: 'string', description: 'Skill name (e.g. dip-reversal, rug-detection, swarm-analyst, builder, momentum-trading, playwright, infisical)' },
        },
        required: ['skill'],
      },
    },
  },
  // ── Self-improvement tools ─────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'get_trade_history',
      description: 'Get recent closed trade history with P&L outcomes. Use during reflection to analyze what worked and what did not.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max trades to return (default 30)' },
          days:  { type: 'number', description: 'How many days back to look (default 7)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_config',
      description: 'Propose a trading config parameter change based on performance analysis. Writes to data/suggested_config.json. If autoApply is enabled, safe changes are applied immediately.',
      parameters: {
        type: 'object',
        properties: {
          param:          { type: 'string', description: 'Config key to adjust (e.g. "minScanScore", "entryBudgetSol", "stopLossPct", "takeProfitPct")' },
          suggestedValue: { type: 'number', description: 'The suggested new value' },
          reasoning:      { type: 'string', description: 'Why this change is suggested based on trade history' },
        },
        required: ['param', 'suggestedValue', 'reasoning'],
      },
    },
  },
  // ── Agent loop strategy tool ───────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'set_session_strategy',
      description: 'Set your trading strategy for the current session window (~90 min). The auto-scanner will follow this mode until the next agent-loop cycle. Use this from Telegram or reflect to adjust behavior immediately.',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['active', 'selective', 'watchOnly'],
            description: 'active = buy best scorer automatically | selective = agent approves each candidate | watchOnly = scan and signal only, no buys',
          },
          patternFilter: {
            type: 'array',
            items: { type: 'string' },
            description: 'Limit to specific entry patterns e.g. ["REVERSAL","DIP-BUY"]. Omit for any pattern.',
          },
          minScoreOverride: {
            type: 'integer',
            description: 'Override minScanScore for this session only. Omit to use config default.',
          },
          maxBuysThisSession: {
            type: 'integer',
            description: 'Cap total new buys for this session. Omit for no cap.',
          },
          sessionGoal: {
            type: 'string',
            description: 'One sentence describing your goal for this session.',
          },
          reasoning: {
            type: 'string',
            description: 'Why you chose this mode given current conditions.',
          },
        },
        required: ['mode', 'sessionGoal', 'reasoning'],
      },
    },
  },
  // ── Swarm blacklist + watching tools ──────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'get_swarm_blacklist',
      description: 'Get the permanent swarm blacklist of confirmed rugged/scam mints. These are mints that multiple agents have independently flagged. Check this before buying any token. Filter by symbol name with search param.',
      parameters: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'Optional: filter by symbol or mint prefix' },
          limit:  { type: 'number', description: 'Max entries to return (default 200)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_blacklist',
      description: 'Fast single-mint blacklist check. Returns whether a specific mint is in the swarm blacklist and vote count. Use before every buy.',
      parameters: {
        type: 'object',
        properties: {
          mint: { type: 'string', description: 'Token mint address to check' },
        },
        required: ['mint'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'blacklist_token',
      description: 'Add a token mint to the permanent swarm blacklist. Use when you have confirmed a rug — LP pulled, mint authority used to print tokens, known scammer wallet, etc. Other agents will see this and avoid the mint forever.',
      parameters: {
        type: 'object',
        properties: {
          mint:   { type: 'string', description: 'Token mint address to blacklist' },
          symbol: { type: 'string', description: 'Token symbol (optional but helpful)' },
          reason: { type: 'string', description: 'Why this mint is blacklisted (min 10 chars — be specific: "LP pulled at 2pm UTC", "mint authority printed 10x supply")' },
        },
        required: ['mint', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'watch_token',
      description: 'Publish a watching signal to the swarm — signal pre-buy interest in a token without committing. Other agents seeing multiple watches on the same token will treat it as early social consensus. Signal expires in 30min.',
      parameters: {
        type: 'object',
        properties: {
          mint:   { type: 'string', description: 'Token mint address you are watching' },
          symbol: { type: 'string', description: 'Token symbol' },
          score:  { type: 'number', description: 'Your current score for this token (0-100)' },
          note:   { type: 'string', description: 'Why you are watching it' },
        },
        required: ['mint'],
      },
    },
  },
  // ── Swarm task tools ───────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'list_tasks',
      description: 'Browse the swarm task board — see what work other agents have proposed. Filter by status (open/claimed/submitted/verified) or type (build/research/analyze/skill/trade). Use to find tasks worth claiming.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['open', 'claimed', 'submitted', 'verified', 'all'], description: 'Task status filter (default: open)' },
          type:   { type: 'string', enum: ['build', 'research', 'analyze', 'skill', 'trade', 'other'], description: 'Task type filter (optional)' },
          limit:  { type: 'number', description: 'Max results (default 20, max 100)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_task',
      description: 'Propose a new task on the swarm task board. If reward > 0, automatically deposits the PISKY to escrow — the winner receives it automatically on verification. Use when you identify something valuable worth building.',
      parameters: {
        type: 'object',
        properties: {
          type:        { type: 'string', enum: ['build', 'research', 'analyze', 'skill', 'trade', 'other'], description: 'Task type' },
          title:       { type: 'string', description: 'Short task title (5–120 chars)' },
          description: { type: 'string', description: 'Full task description with success criteria (20–2000 chars)' },
          reward:      { type: 'number', description: 'PISKY reward amount (integer, e.g. 50000)' },
          deadline:    { type: 'string', description: 'Optional deadline as ISO timestamp' },
        },
        required: ['type', 'title', 'description'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'claim_task',
      description: 'Claim an open task from the task board. Default deadline is 7 days (or whatever the proposer set). Claims expire if you do not submit — task reverts to open. Only one agent can hold a claim at a time.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'The taskId from list_tasks' },
        },
        required: ['taskId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'submit_task',
      description: 'Submit your completed work for a task you claimed. Include the actual deliverable (code, analysis, findings) in work — max 50KB inline, link externally for larger artifacts. The proposer calling verify_task(approved=true) automatically releases escrowed PISKY to your wallet.',
      parameters: {
        type: 'object',
        properties: {
          taskId:  { type: 'string', description: 'The taskId you claimed' },
          work:    { type: 'string', description: 'The actual deliverable: code, analysis, data, or findings' },
          summary: { type: 'string', description: 'Brief summary of what you did and what was found (min 10 chars)' },
        },
        required: ['taskId', 'work', 'summary'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'verify_task',
      description: 'Verify (approve or reject) a submitted task. Proposer approval alone releases escrow. Two independent approvals also release. Called after reviewing submitted work quality.',
      parameters: {
        type: 'object',
        properties: {
          taskId:       { type: 'string',  description: 'The taskId to verify' },
          approved:     { type: 'boolean', description: 'true = approve and release reward, false = reject' },
          submissionId: { type: 'string',  description: 'Specific submission ID (defaults to latest)' },
          comment:      { type: 'string',  description: 'Reason for approval or rejection (optional)' },
        },
        required: ['taskId', 'approved'],
      },
    },
  },
  // ── Swarm tools ────────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'read_swarm_feed',
      description: 'Read recent buy/sell/rug signals from the pisky-agent swarm. See what other agents are trading right now. Filter by type or token.',
      parameters: {
        type: 'object',
        properties: {
          limit:         { type: 'number',  description: 'Max signals to return (default 20)' },
          type:          { type: 'string',  description: 'Filter by signal type: buy_signal, sell_signal, rug_alert, momentum, insight' },
          mint:          { type: 'string',  description: 'Filter by specific token mint address' },
          minReputation: { type: 'number',  description: 'Only show signals from agents with reputation >= this (0–100, default 0)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_swarm_consensus',
      description: 'Get the swarm\'s aggregated view on a specific token. Returns bullish/bearish/rug_alert consensus with confidence and signal breakdown. Use before buying to check if other agents agree.',
      parameters: {
        type: 'object',
        properties: {
          mint: { type: 'string', description: 'Token mint address to check consensus for' },
        },
        required: ['mint'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'publish_signal',
      description: 'Publish a signal to the swarm network — share your market observation with all other agents. Use after spotting something significant: strong momentum, rug risk, or a trading insight.',
      parameters: {
        type: 'object',
        properties: {
          type:       { type: 'string', enum: ['buy_signal', 'sell_signal', 'rug_alert', 'momentum', 'insight', 'strategy_stats', 'market_regime'], description: 'Signal type. strategy_stats: broadcast your pattern win rates (use data.patterns + data.configHints). market_regime: your read on current market (use data.regime + data.solChange24h).' },
          mint:       { type: 'string',  description: 'Token mint address (for token signals; omit for insights/strategy_stats/market_regime)' },
          symbol:     { type: 'string',  description: 'Token symbol (optional)' },
          confidence: { type: 'number',  description: 'Your confidence 0.0–1.0 (default 0.7)' },
          note:       { type: 'string',  description: 'Brief description of what you observed' },
          data:       { type: 'object',  description: 'Structured data. For strategy_stats: {patterns:[{pattern,trades,wins,avgPnlPct,avgHoldMin}], configHints:[{param,value,reason}]}. For market_regime: {regime:"bull"|"bear"|"choppy", solChange24h:number, note:string}.' },
        },
        required: ['type'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'share_insight',
      description: 'Share a trading insight or learned pattern with the swarm. Other agents will be able to read it in their reflect cycles. Use this to contribute collective intelligence.',
      parameters: {
        type: 'object',
        properties: {
          insight:    { type: 'string',  description: 'The insight or pattern you want to share (e.g. "tokens with 1h drop > 15% and buy ratio < 30% tend to keep falling for 30+ min")' },
          confidence: { type: 'number',  description: 'How confident you are in this pattern 0.0–1.0' },
        },
        required: ['insight'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_swarm_strategies',
      description: 'Get aggregate strategy performance stats from across the entire agent swarm — which entry patterns (REVERSAL, DIP-BUY, etc.) are winning, at what rates, and what config settings high-rep agents recommend. Use during reflect cycle to calibrate your own strategy.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  // ── Research tools ─────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'token_info',
      description: 'Deep token analysis: rug risk, mint/freeze authority, LP lock %, top holder concentration, social score, verified status, and market pair data. Use this BEFORE recommending any buy. Returns a verdict: safe/warning/danger.',
      parameters: {
        type: 'object',
        properties: {
          mint: { type: 'string', description: 'Token mint address to analyze' },
        },
        required: ['mint'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'token_holders',
      description: 'Get holder concentration for a token: top holders and their % of supply. High concentration (top 5 > 50%) is a rug risk. Use when scan shows a promising token.',
      parameters: {
        type: 'object',
        properties: {
          mint: { type: 'string', description: 'Token mint address' },
        },
        required: ['mint'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'token_chart',
      description: 'Get OHLCV price history for a token. Use to confirm trend direction — is this dip a reversal or a death spiral? Default: 1H candles, last 24.',
      parameters: {
        type: 'object',
        properties: {
          mint:      { type: 'string', description: 'Token mint address' },
          timeframe: { type: 'string', description: 'Candle timeframe: 1m, 5m, 15m, 1H, 4H, 1D (default 1H)' },
          limit:     { type: 'number', description: 'Number of candles to return (default 24, max 100)' },
        },
        required: ['mint'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_news',
      description: 'Get recent crypto/Solana news. Useful for spotting market-moving events, token launches, or protocol updates. Filter: rising (gaining traction), hot (trending now), bullish, bearish.',
      parameters: {
        type: 'object',
        properties: {
          limit:  { type: 'number', description: 'Number of news items (default 10, max 50)' },
          filter: { type: 'string', description: 'Filter: rising | hot | bullish | bearish (default: rising)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'top_pools',
      description: 'Get top Solana DEX liquidity pools by 24h volume from GeckoTerminal. Shows where real trading volume is concentrated.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Number of pools (default 20)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'swarm_leaderboard',
      description: 'Get the top-performing agents in the PISKY swarm ranked by reputation score. See who is getting signals right.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Number of agents to show (default 10)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_my_reputation',
      description: 'Check your own reputation score in the PISKY swarm: signal count, win rate, average P&L, and rank. Use during reflect cycles to assess your standing.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  // ── Memory tools ───────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'save_memory',
      description: 'Save a fact or preference about the user to persistent memory. Use proactively when you learn something important about them.',
      parameters: {
        type: 'object',
        properties: {
          key:      { type: 'string', description: 'Short label (e.g. "risk_tolerance", "home_city", "favorite_chain")' },
          value:    { type: 'string', description: 'The value to remember' },
          category: {
            type: 'string',
            enum: ['preference', 'fact', 'interest', 'personality', 'goal', 'general'],
            description: 'Category of this memory',
          },
        },
        required: ['key', 'value', 'category'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recall_memories',
      description: 'Search persistent memory about the current user. Pass empty query to get all memories.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keyword to filter memories (empty = get all)' },
        },
        required: [],
      },
    },
  },
  // ── Agent self-memory tools ─────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'save_note',
      description: 'Save a trading insight or learned pattern to your own persistent memory. Use during reflect cycles to record what worked, what failed, and what you observed in the swarm. These notes inject into your system prompt every session.',
      parameters: {
        type: 'object',
        properties: {
          key:      { type: 'string', description: 'Short label (e.g. "regime_2024-01", "pattern_deep_reversal", "swarm_lesson")' },
          value:    { type: 'string', description: 'The insight to remember — be specific and actionable' },
          category: {
            type: 'string',
            enum: ['pattern', 'lesson', 'regime', 'swarm', 'config', 'general'],
            description: 'Category of this note',
          },
        },
        required: ['key', 'value', 'category'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recall_notes',
      description: 'Search your own learned notes from past reflect cycles. Pass empty query to get all notes.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keyword to filter notes (empty = get all)' },
        },
        required: [],
      },
    },
  },
  // ── Trading control tools ───────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'pause_trading',
      description: 'Pause the auto-scanner from making new buys. The position monitor keeps running — existing positions are still watched and exits still fire. Use when the user wants to stop new entries temporarily or when market conditions are too risky.',
      parameters: {
        type: 'object',
        properties: {
          reason:  { type: 'string', description: 'Why you are pausing (e.g. "bear market", "user request", "high volatility")' },
          minutes: { type: 'number', description: 'Auto-resume after this many minutes. Omit to pause until manually resumed.' },
        },
        required: ['reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'resume_trading',
      description: 'Resume the auto-scanner after a pause. Call this when the user wants to re-enable new buy entries.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  // ── Builder tools ──────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file from the agent directory. Use this to inspect your own source code (lib/, config/), logs, or any file in the project before modifying it. Always read before writing.',
      parameters: {
        type: 'object',
        properties: {
          path:  { type: 'string', description: 'Relative path within the agent directory (e.g. lib/tools.js, config/agent.json, logs/processor.log)' },
          lines: { type: 'number', description: 'Max lines to return (default 300)' },
          offset: { type: 'number', description: 'Line number to start from (default 1)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files and directories within the agent directory. Use to explore the project structure before building or modifying things.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path to list (default: . = agent root)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write a file to the agent directory. Use to create new strategies, scripts, configs, or extend agent capabilities. ALWAYS: (1) read existing files before overwriting, (2) explain to the user what you are writing and why, (3) never overwrite .env or core lib files (swap.js, wallet.js, pisky.js, processor.js). Prefer writing to lib/strategies/, scripts/, or config/.',
      parameters: {
        type: 'object',
        properties: {
          path:    { type: 'string', description: 'Relative path to write (e.g. lib/strategies/yield.js, scripts/morning_report.js)' },
          content: { type: 'string', description: 'Full file content to write' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_script',
      description: 'Run a Node.js script in the agent directory. Use to test new code you have written, run utilities, or execute scripts. Always test with a --dry-run arg first if the script supports it. Returns stdout and stderr. Timeout: 30s default.',
      parameters: {
        type: 'object',
        properties: {
          path:    { type: 'string', description: 'Relative path to the script (e.g. scripts/morning_report.js, lib/strategies/yield.js)' },
          args:    { type: 'array',  items: { type: 'string' }, description: 'Command-line arguments (e.g. ["--dry-run", "--limit", "5"])' },
          timeout: { type: 'number', description: 'Timeout in milliseconds (default 30000, max 120000)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'install_package',
      description: 'Install an npm package into the agent directory. Use when building strategies that need external SDKs — e.g. @marinade.finance/marinade-ts-sdk for yield farming, @orca-so/whirlpools-sdk for LP strategies, axios for HTTP calls. Always tell the user what you are installing and why before running this.',
      parameters: {
        type: 'object',
        properties: {
          package: { type: 'string', description: 'Package name with optional version (e.g. "@marinade.finance/marinade-ts-sdk", "axios@1.6.0")' },
        },
        required: ['package'],
      },
    },
  },
];

// ── HTML stripper (for web_search / fetch_url) ────────────────────────────────

function stripHtml(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi,   '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g,  '&').replace(/&lt;/g,  '<').replace(/&gt;/g,  '>')
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Swarm signal helper ───────────────────────────────────────────────────────
// Fire-and-forget: loads agent identity and publishes a signal.
// Errors are silently swallowed — swarm publishing never blocks trades.

async function _publishSwarmSignal(api, type, opts = {}) {
  const id = loadIdentity();
  const { agentId, address } = id;
  if (!agentId && !address) return;

  await api.swarmPublish({
    agentId,
    address,
    type,
    mint:       opts.mint       ?? undefined,
    symbol:     opts.symbol     ?? undefined,
    confidence: opts.confidence ?? 0.7,
    data:       opts.data       ?? {},
  });
}

// ── Tool executor ─────────────────────────────────────────────────────────────

async function executeTool(name, args, ctx, log) {
  const { senderId, api, wallet, swap, positions } = ctx;

  // Check cache for read-only tools before making any API call
  const cached = _cacheGet(name, args);
  if (cached) {
    log('info', `Cache hit: ${name} (TTL ${(TOOL_CACHE_TTL[name] / 60_000).toFixed(0)}min)`);
    return cached;
  }

  // Wrapper: execute tool, cache result if applicable, return
  async function _exec() {
    switch (name) {

      // ── Solana data ────────────────────────────────────────────────────────

      case 'scan_tokens': {
        const result = await api.scan({
          limit:        args.limit       ?? 20,
          minLiquidity: args.minLiquidity ?? 10000,
          safeOnly:     args.safeOnly    ?? false,
        });
        const top = (result.candidates ?? []).slice(0, 10).map(c => ({
          symbol:       c.symbol,
          mint:         c.mint,
          price:        c.price,
          change1h:     c.priceChange1h,
          change24h:    c.priceChange24h,
          liquidity:    c.liquidity,
          volume24h:    c.volume24h,
          buys1h:       c.txns1h?.buys,
          sells1h:      c.txns1h?.sells,
          rugRisk:      c.rugRisk,
          verdict:      c.verdict,
        }));
        return JSON.stringify({ candidates: top, total: result.candidates?.length ?? 0 });
      }

      case 'token_price': {
        const data = await api.tokenPrice(args.mint);
        return JSON.stringify(data ?? { error: 'Price unavailable' });
      }

      case 'market_overview': {
        const data = await api.marketOverview();
        return JSON.stringify(data ?? { error: 'Market data unavailable' });
      }

      case 'network_stats': {
        const data = await api.networkStats();
        return JSON.stringify(data ?? { error: 'Network stats unavailable' });
      }

      case 'staking_yields': {
        const data = await api.stakingYields();
        return JSON.stringify(data ?? { error: 'Staking data unavailable' });
      }

      case 'defi_overview': {
        const data = await api.defiOverview();
        return JSON.stringify(data ?? { error: 'DeFi data unavailable' });
      }

      case 'market_sentiment': {
        const data = await api.marketSentiment();
        return JSON.stringify(data ?? { error: 'Sentiment data unavailable' });
      }

      case 'oracle_prices': {
        const data = await api.oraclePrices();
        return JSON.stringify(data ?? { error: 'Oracle data unavailable' });
      }

      // ── Research tools ─────────────────────────────────────────────────────

      case 'token_info': {
        if (!args.mint) return JSON.stringify({ error: 'mint required' });
        const data = await api.tokenInfo(args.mint);
        return JSON.stringify(data ?? { error: 'Token info unavailable' });
      }

      case 'token_holders': {
        if (!args.mint) return JSON.stringify({ error: 'mint required' });
        const data = await api.tokenHolders(args.mint);
        return JSON.stringify(data ?? { error: 'Holder data unavailable' });
      }

      case 'token_chart': {
        if (!args.mint) return JSON.stringify({ error: 'mint required' });
        const data = await api.tokenOhlcv(args.mint, args.timeframe ?? '1H', args.limit ?? 24);
        return JSON.stringify(data ?? { error: 'OHLCV data unavailable' });
      }

      case 'get_news': {
        const data = await api.news({ limit: args.limit ?? 10, filter: args.filter ?? 'rising' });
        return JSON.stringify(data ?? { error: 'News unavailable' });
      }

      case 'top_pools': {
        const data = await api.topPools(args.limit ?? 20);
        return JSON.stringify(data ?? { error: 'Pool data unavailable' });
      }

      // ── Trade tools ────────────────────────────────────────────────────────

      case 'check_wallet': {
        const [balances, held] = await Promise.all([
          wallet.getBalances(),
          Promise.resolve(positions.getAll()),
        ]);
        const positionList = Object.values(held).map(p => ({
          symbol:     p.symbol,
          mint:       p.mint,
          solSpent:   p.solSpent,
          peakPnlPct: p.peakPnlPct,
          heldMins:   Math.round(positions.holdMinutes(p)),
          entryTime:  p.entryTime,
        }));
        return JSON.stringify({
          sol:            balances.sol,
          pisky:          balances.pisky,
          address:        balances.address,
          openPositions:  positionList.length,
          positions:      positionList,
        });
      }

      case 'buy_token': {
        const { mint, solAmount } = args;
        if (!mint || !solAmount) return JSON.stringify({ error: 'mint and solAmount required' });

        // One buy per processor round — prevents the LLM from buying multiple tokens
        // in a single 5-round tool-use loop (e.g. chaining buy_token calls back-to-back).
        if (ctx._buyExecutedThisRound) {
          log('warn', 'buy_token blocked — already executed a buy this round');
          return JSON.stringify({ error: 'One buy per conversation round. A buy was already executed this session turn. Review the position and decide in the next message.' });
        }

        log('info', `Tool: buy_token ${mint.slice(0,8)} ${solAmount} SOL`);

        // Hard blacklist gate — enforced regardless of LLM instruction.
        // Prevents buying a confirmed rug even if the LLM skipped the check.
        try {
          const bl = await api.blacklistCheck(mint);
          if (bl?.blacklisted) {
            log('warn', `buy_token blocked — mint on swarm blacklist`, { mint: mint.slice(0, 8), votes: bl.votes });
            return JSON.stringify({ error: `Buy blocked: ${mint.slice(0, 8)} is on the swarm blacklist (${bl.votes ?? '?'} votes). Do not buy this token.` });
          }
        } catch { /* blacklist unavailable — proceed; scanner pre-filters */ }

        const result = await swap.buy(mint, solAmount);

        // Get decimals from RPC — but use Jupiter's outAmount for tokenAmount.
        // RPC balance often returns 0 right after buy (account not yet indexed),
        // which would make the monitor calculate pnlPct = -100% and immediately sell.
        let tokenDecimals = 6;
        try {
          const bal = await swap.getTokenBalance(mint);
          if (bal.decimals > 0) tokenDecimals = bal.decimals;
        } catch (_) {}

        positions.openPosition(mint, {
          symbol:        args.symbol ?? mint.slice(0, 6),
          entryPrice:    result.pricePerToken ?? 0,
          solSpent:      result.inAmount,
          tokenAmount:   result.outAmount,   // Jupiter's amount — always reliable
          tokenDecimals,
          txSig:         result.txSig,
        });

        // Auto-publish buy signal to swarm
        _publishSwarmSignal(api, 'buy_signal', {
          mint, symbol: args.symbol,
          confidence: 0.75,
          data: { entryBudgetSol: result.inAmount, txSig: result.txSig },
        }).catch(() => {});

        ctx._buyExecutedThisRound = true;
        return JSON.stringify({
          success:    true,
          txSig:      result.txSig,
          solSpent:   result.inAmount,
          tokensOut:  result.outAmount,
          mint,
        });
      }

      case 'sell_token': {
        const { mint, pct = 1.0, reason = 'manual' } = args;
        if (!mint) return JSON.stringify({ error: 'mint required' });
        log('info', `Tool: sell_token ${mint.slice(0,8)} ${(pct*100).toFixed(0)}%`);

        const pos = positions.get(mint);
        if (!pos) return JSON.stringify({ error: 'No open position for this mint' });

        const bal    = await swap.getTokenBalance(mint);
        const result = await swap.sell(mint, Number(bal.rawAmount), pct);

        let pnlPct = null;
        if (pct >= 1.0) {
          const pnlSol = (result.solReceived ?? 0) - pos.solSpent;
          pnlPct       = (pnlSol / pos.solSpent) * 100;
          positions.closePosition(mint, {
            solReceived: result.solReceived,
            pnlSol,
            pnlPct,
            reason,
            txSig: result.txSig,
          });

          // Auto-publish sell signal + outcome to swarm
          _publishSwarmSignal(api, 'sell_signal', {
            mint, symbol: pos.symbol,
            confidence: 0.9,
            data: { pnlPct: +pnlPct.toFixed(2), pnlSol: +(((result.solReceived ?? 0) - pos.solSpent)).toFixed(5), reason, txSig: result.txSig },
          }).catch(() => {});
        }

        return JSON.stringify({
          success:     true,
          txSig:       result.txSig,
          solReceived: result.solReceived,
          mint,
          soldPct:     pct,
          pnlPct,
        });
      }

      // ── Web tools ──────────────────────────────────────────────────────────

      case 'web_search': {
        const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(args.query ?? '')}`;
        const resp = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' },
          signal: AbortSignal.timeout(10_000),
        });
        if (!resp.ok) return JSON.stringify({ error: `Search ${resp.status}` });

        const html    = await resp.text();
        const results = [];
        const linkRx  = /class="result__a"[^>]*href="([^"]*)"[^>]*>([^<]*)</g;
        const snippRx = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
        const links   = [];
        let m;

        while ((m = linkRx.exec(html)) !== null) {
          let href = m[1];
          if (href.includes('uddg=')) {
            try { href = decodeURIComponent(new URLSearchParams(href.split('?')[1]).get('uddg') ?? href); } catch { /* keep */ }
          }
          links.push({ url: href, title: stripHtml(m[2]).trim() });
        }
        const snippets = [];
        while ((m = snippRx.exec(html)) !== null) snippets.push(stripHtml(m[1]).trim());

        for (let i = 0; i < Math.min(links.length, 5); i++) {
          results.push({ title: links[i].title, url: links[i].url, snippet: snippets[i] ?? '' });
        }
        return JSON.stringify(results.length ? { results, query: args.query } : { message: 'No results', query: args.query });
      }

      case 'fetch_url': {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 10_000);
        const resp  = await fetch(args.url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' },
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (!resp.ok) return JSON.stringify({ error: `Fetch ${resp.status}` });
        const ct = resp.headers.get('content-type') ?? '';
        if (!ct.includes('text/') && !ct.includes('application/json')) {
          return JSON.stringify({ error: `Unsupported content type: ${ct}` });
        }
        let text = stripHtml(await resp.text());
        if (text.length > 3000) text = text.slice(0, 3000) + '\n[truncated]';
        return JSON.stringify({ url: args.url, content: text });
      }

      // ── Self-improvement tools ─────────────────────────────────────────────

      case 'list_skills': {
        const fs = require('fs');
        const skillsDir = path.join(__dirname, '../skills');
        const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
        const skills = entries
          .filter(e => e.isDirectory())
          .map(e => {
            const skillMd = path.join(skillsDir, e.name, 'SKILL.md');
            if (!fs.existsSync(skillMd)) return null;
            // Extract description from first non-heading line
            const lines = fs.readFileSync(skillMd, 'utf8').split('\n');
            const descLine = lines.find(l => l.trim() && !l.startsWith('#')) || '';
            return { name: e.name, description: descLine.trim().slice(0, 100) };
          })
          .filter(Boolean);
        return JSON.stringify({ skills, count: skills.length });
      }

      case 'load_skill': {
        const { skill } = args;
        const fs = require('fs');
        const skillsDir = path.join(__dirname, '../skills');
        // Check subdirectory first (new format: skills/<name>/SKILL.md)
        const subdirFile = path.join(skillsDir, skill, 'SKILL.md');
        // Fallback: flat file (skills/<name>.md)
        const flatFile = path.join(skillsDir, `${skill}.md`);
        let skillFile = null;
        if (fs.existsSync(subdirFile)) skillFile = subdirFile;
        else if (fs.existsSync(flatFile)) skillFile = flatFile;
        if (!skillFile) {
          const available = fs.readdirSync(skillsDir, { withFileTypes: true })
            .filter(e => e.isDirectory())
            .map(e => e.name);
          return JSON.stringify({ error: `Skill '${skill}' not found. Available: ${available.join(', ')}` });
        }
        const content = fs.readFileSync(skillFile, 'utf8');
        log('info', `Skill loaded: ${skill}`);

        // Track skill usage in profile — add to specialization.skills if new
        try {
          const { loadProfile } = require('./profile');
          const profilePath = path.join(__dirname, '../data/agent-profile.json');
          const profile = loadProfile();
          if (profile && !profile.specialization?.skills?.includes(skill)) {
            profile.specialization = profile.specialization ?? {};
            profile.specialization.skills = profile.specialization.skills ?? [];
            profile.specialization.skills.push(skill);
            const tmp = profilePath + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(profile, null, 2));
            fs.renameSync(tmp, profilePath);
            log('info', `Profile updated: added skill '${skill}'`);
          }
        } catch { /* non-fatal — skill content still returned */ }

        return JSON.stringify({ skill, content });
      }

      case 'get_trade_history': {
        const trades = positions.getTradeHistory(args.limit ?? 30, args.days ?? 7);
        const wins   = trades.filter(t => t.pnlPct > 0);
        const losses = trades.filter(t => t.pnlPct <= 0);
        const totalPnlSol = trades.reduce((s, t) => s + (t.pnlSol ?? 0), 0);

        // Include PISKY reinvest stats so the agent can see its survival trajectory
        const { getStats } = require('./pisky-reinvest');
        const reinvest = getStats();

        return JSON.stringify({
          trades,
          summary: {
            total:       trades.length,
            wins:        wins.length,
            losses:      losses.length,
            winRate:     trades.length ? Math.round((wins.length / trades.length) * 100) : 0,
            totalPnlSol: +totalPnlSol.toFixed(5),
            avgPnlPct:   trades.length ? +(trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length).toFixed(2) : 0,
          },
          piskyReinvest: {
            totalSolReinvested: +reinvest.totalSolReinvested.toFixed(5),
            totalPiskyBought:   reinvest.totalPiskyBought,
            reinvestCount:      reinvest.reinvestCount,
            recentHistory:      reinvest.history.slice(-5),
          },
          message: trades.length ? undefined : 'No closed trades in this period',
        });
      }

      case 'set_session_strategy': {
        const { saveStrategy } = require('./agent-loop');
        const { mode, patternFilter, minScoreOverride, maxBuysThisSession, sessionGoal, reasoning } = args;
        if (!mode || !sessionGoal || !reasoning) {
          return JSON.stringify({ error: 'mode, sessionGoal, and reasoning are required' });
        }
        const validModes = ['active', 'selective', 'watchOnly'];
        if (!validModes.includes(mode)) {
          return JSON.stringify({ error: `mode must be one of: ${validModes.join(', ')}` });
        }
        const saved = saveStrategy({
          mode,
          patternFilter:      Array.isArray(patternFilter) && patternFilter.length ? patternFilter : null,
          minScoreOverride:   typeof minScoreOverride === 'number' ? minScoreOverride : null,
          maxBuysThisSession: typeof maxBuysThisSession === 'number' ? maxBuysThisSession : null,
          buysThisSession:    0,
          sessionGoal,
          reasoning,
        });
        return JSON.stringify({
          ok: true,
          strategy: {
            mode: saved.mode,
            patternFilter:    saved.patternFilter,
            minScoreOverride: saved.minScoreOverride,
            maxBuys:          saved.maxBuysThisSession,
            sessionGoal:      saved.sessionGoal,
            expiresAt:        saved.expiresAt,
          },
        });
      }

      case 'update_config': {
        const { param, suggestedValue, reasoning } = args;
        if (!param || suggestedValue === undefined) return JSON.stringify({ error: 'param and suggestedValue required' });

        // Safe bounds — prevent the LLM from setting dangerous values
        const BOUNDS = {
          minScanScore:       [10, 85],
          entryBudgetSol:     [0.001, 0.5],
          stopLossPct:        [-25, -1],
          takeProfitPct:      [2, 100],
          maxHoldMinutes:     [5, 240],
          minLiquidity:       [5000, 500000],
          maxOpenPositions:   [1, 10],
          trailingStopActivatePct:  [1, 20],
          trailingStopDistancePct:  [1, 15],
        };

        const bounds = BOUNDS[param];
        if (!bounds) return JSON.stringify({ error: `Unknown or non-tunable param: ${param}. Allowed: ${Object.keys(BOUNDS).join(', ')}` });

        const [min, max] = bounds;
        if (suggestedValue < min || suggestedValue > max) {
          return JSON.stringify({ error: `${param} must be between ${min} and ${max}. Got ${suggestedValue}.` });
        }

        // Load and save suggestions
        const fs   = require('fs');
        const path = require('path');
        const sugFile = path.join(__dirname, '../data/suggested_config.json');
        let suggestions = [];
        try { if (fs.existsSync(sugFile)) suggestions = JSON.parse(fs.readFileSync(sugFile, 'utf8')); } catch { /* start fresh */ }

        const existing = suggestions.findIndex(s => s.param === param);
        const entry    = { param, suggestedValue, reasoning, proposedAt: new Date().toISOString(), applied: false };
        if (existing >= 0) suggestions[existing] = entry; else suggestions.push(entry);
        fs.mkdirSync(path.dirname(sugFile), { recursive: true });
        fs.writeFileSync(sugFile, JSON.stringify(suggestions, null, 2));

        // Auto-apply if configured.
        // Write to config/agent.local.json (user overrides) so that git pull
        // never conflicts with LLM-applied config changes.
        let applied = false;
        try {
          const basePath  = path.join(__dirname, '../config/agent.json');
          const localPath = path.join(__dirname, '../config/agent.local.json');
          const baseCfg   = JSON.parse(fs.readFileSync(basePath, 'utf8'));
          if (baseCfg.reflect?.autoApply) {
            // Load or create local override file
            let localCfg = {};
            try { if (fs.existsSync(localPath)) localCfg = JSON.parse(fs.readFileSync(localPath, 'utf8')); } catch { /* start fresh */ }
            localCfg.strategy         = localCfg.strategy ?? {};
            localCfg.strategy[param]  = suggestedValue;
            fs.writeFileSync(localPath, JSON.stringify(localCfg, null, 2) + '\n');
            suggestions[suggestions.length - 1].applied = true;
            fs.writeFileSync(sugFile, JSON.stringify(suggestions, null, 2));
            applied = true;
          }
        } catch { /* ignore auto-apply failures */ }

        log('info', `Config proposal: ${param} → ${suggestedValue}`, { applied });
        return JSON.stringify({ saved: true, param, suggestedValue, reasoning, applied });
      }

      // ── Swarm blacklist + watching tools ──────────────────────────────────

      case 'get_swarm_blacklist': {
        const res = await api.blacklistGet({ search: args.search, limit: args.limit ?? 200 });
        return JSON.stringify(res ?? { error: 'Blacklist unavailable' });
      }

      case 'check_blacklist': {
        if (!args.mint) return JSON.stringify({ error: 'mint required' });
        const res = await api.blacklistCheck(args.mint);
        return JSON.stringify(res ?? { error: 'Check unavailable' });
      }

      case 'blacklist_token': {
        const { agentId: blAgentId, address: blAddr } = loadIdentity();
        if (!blAgentId && !blAddr) return JSON.stringify({ error: 'No agent identity — register first' });
        const res = await api.blacklistAdd(blAgentId, blAddr, args.mint, args.symbol, args.reason);
        log('info', `Blacklisted ${args.symbol ?? args.mint?.slice(0, 8)}: ${args.reason?.slice(0, 60)}`);
        return JSON.stringify(res ?? { error: 'Failed to add to blacklist' });
      }

      case 'watch_token': {
        const { agentId: wtAgentId, address: wtAddr } = loadIdentity();
        if (!wtAgentId && !wtAddr) return JSON.stringify({ error: 'No agent identity' });
        const res = await api.swarmPublish({
          agentId:    wtAgentId,
          address:    wtAddr,
          type:       'watching',
          mint:       args.mint,
          symbol:     args.symbol,
          confidence: 0.6,
          ttlSeconds: 1800,
          data:       { note: args.note ?? '', score: args.score ?? 0 },
        });
        log('info', `Watching signal: ${args.symbol ?? args.mint?.slice(0, 8)}`);
        return JSON.stringify(res ?? { error: 'Failed to publish watching signal' });
      }

      // ── Swarm task tools ───────────────────────────────────────────────────

      case 'list_tasks': {
        const res = await api.taskList({
          status: args.status,
          type:   args.type,
          limit:  args.limit,
        });
        return JSON.stringify(res ?? { error: 'Task board unavailable' });
      }

      case 'propose_task':
      case 'claim_task':
      case 'submit_task':
      case 'verify_task': {
        const { agentId, address: agentAddr } = loadIdentity();
        if (!agentId && !agentAddr) {
          return JSON.stringify({ error: 'No agent identity found. Register with /api/agents/register first.' });
        }

        let res;
        if (name === 'propose_task') {
          res = await api.taskPropose(agentId, agentAddr, {
            type: args.type, title: args.title, description: args.description,
            reward: args.reward, deadline: args.deadline,
          });
        } else if (name === 'claim_task') {
          res = await api.taskClaim(agentId, agentAddr, args.taskId);
        } else if (name === 'submit_task') {
          res = await api.taskSubmit(agentId, agentAddr, args.taskId, args.work, args.summary);
        } else {
          res = await api.taskVerify(
            agentId, agentAddr,
            args.taskId,
            args.approved,
            args.submissionId ?? null,
            args.comment ?? '',
          );
        }
        return JSON.stringify(res ?? { error: `Failed: ${name}` });
      }

      // ── Swarm tools ────────────────────────────────────────────────────────

      case 'read_swarm_feed': {
        const feed = await api.swarmFeed({
          limit:         args.limit         ?? 20,
          type:          args.type          ?? undefined,
          mint:          args.mint          ?? undefined,
          minReputation: args.minReputation ?? 0,
        });
        return JSON.stringify(feed ?? { error: 'Swarm feed unavailable' });
      }

      case 'get_swarm_consensus': {
        if (!args.mint) return JSON.stringify({ error: 'mint required' });
        const consensus = await api.swarmConsensus(args.mint);
        return JSON.stringify(consensus ?? { error: 'Consensus unavailable' });
      }

      case 'publish_signal': {
        const { type: sigType, mint: sigMint, symbol: sigSymbol, confidence: sigConf = 0.7, note, data: sigData } = args;
        const { agentId, address } = loadIdentity();
        if (!agentId && !address) return JSON.stringify({ error: 'Agent not initialized — run: node agent.js init' });

        const result = await api.swarmPublish({
          agentId,
          address,
          type:       sigType,
          mint:       sigMint    ?? undefined,
          symbol:     sigSymbol  ?? undefined,
          confidence: sigConf,
          data:       { note: note ?? '', ...(sigData ?? {}) },
        });
        log('info', `Swarm signal published: ${sigType}`, { mint: sigMint?.slice(0, 8) });
        return JSON.stringify(result);
      }

      case 'swarm_leaderboard': {
        const board = await api.swarmLeaderboard(args.limit ?? 10);
        return JSON.stringify(board ?? { error: 'Leaderboard unavailable' });
      }

      case 'get_my_reputation': {
        const identity = loadIdentity();
        if (!identity.agentId && !identity.address) return JSON.stringify({ error: 'Agent not initialized — run: node agent.js init' });

        // Fetch agent record from registry (free endpoint)
        try {
          const resp = await api._fetch(`/api/agents/${identity.address}`);
          if (resp.ok) {
            const agent = await resp.json();
            return JSON.stringify({
              agentId:    identity.agentId,
              address:    identity.address,
              reputation: agent.reputation ?? { score: 50, signals: 0, wins: 0 },
              signalCount: agent.signalCount ?? 0,
              registeredAt: agent.registeredAt,
              lastSeenAt:   agent.lastSeenAt,
            });
          }
        } catch { /* fall through */ }

        return JSON.stringify({ agentId: identity.agentId, address: identity.address, reputation: { score: 50, signals: 0 }, note: 'Registry unreachable' });
      }

      case 'share_insight': {
        const { insight, confidence: insConf = 0.6 } = args;
        if (!insight) return JSON.stringify({ error: 'insight text required' });
        const { agentId, address } = loadIdentity();
        if (!agentId && !address) return JSON.stringify({ error: 'Agent not initialized — run: node agent.js init' });

        const result = await api.swarmPublish({
          agentId,
          address,
          type:       'insight',
          confidence: insConf,
          data:       { insight },
        });
        log('info', 'Swarm insight shared');
        return JSON.stringify(result);
      }

      case 'get_swarm_strategies': {
        const resp = await api._fetch('/api/swarm/strategies');
        if (!resp.ok) return JSON.stringify({ error: `strategies ${resp.status}` });
        return JSON.stringify(await resp.json());
      }

      // ── Memory tools ───────────────────────────────────────────────────────

      case 'save_memory': {
        const { key, value, category } = args;
        if (!key || !value) return JSON.stringify({ error: 'key and value required' });
        memory.addMemory(senderId, key, value, category ?? 'general');
        return JSON.stringify({ saved: true, key, value, category });
      }

      case 'recall_memories': {
        const memories = memory.recallMemories(senderId, args.query ?? '');
        return JSON.stringify({ memories, count: memories.length });
      }

      // ── Agent self-memory tools ─────────────────────────────────────────────

      case 'save_note': {
        const { key, value, category } = args;
        if (!key || !value) return JSON.stringify({ error: 'key and value required' });
        memory.saveNote(key, value, category ?? 'general');
        return JSON.stringify({ saved: true, key, value, category });
      }

      case 'recall_notes': {
        const notes = memory.recallNotes(args.query ?? '');
        return JSON.stringify({ notes, count: notes.length });
      }

      // ── Trading control tools ───────────────────────────────────────────────

      case 'pause_trading': {
        const { pauseTrading } = require('./pause');
        const state = pauseTrading(args.reason ?? 'agent request', args.minutes ?? null);
        const msg = args.minutes
          ? `Trading paused for ${args.minutes} minutes (auto-resumes at ${new Date(state.until).toUTCString()}). Monitor still running — existing positions are watched.`
          : `Trading paused (${args.reason}). Call resume_trading to re-enable new buys. Monitor still running.`;
        return JSON.stringify({ paused: true, ...state, message: msg });
      }

      case 'resume_trading': {
        const { resumeTrading, pauseStatus } = require('./pause');
        const was = pauseStatus();
        resumeTrading();
        return JSON.stringify({ paused: false, message: was.paused ? 'Trading resumed — auto-scanner will buy on next scan cycle.' : 'Trading was not paused.' });
      }

      // ── Builder tools ──────────────────────────────────────────────────────

      case 'read_file': {
        const fsB   = require('fs');
        const pathB = require('path');
        const AGENT_ROOT = pathB.resolve(__dirname, '..');
        const target = pathB.resolve(AGENT_ROOT, args.path ?? '');
        if (!target.startsWith(AGENT_ROOT + pathB.sep) && target !== AGENT_ROOT) {
          return JSON.stringify({ error: 'Path must be within the agent directory' });
        }

        // Never expose secrets files — these contain private keys and API tokens
        const rel = pathB.relative(AGENT_ROOT, target);
        const SECRETS_BLOCKED = ['.env', '.env.local', '.env.production'];
        if (SECRETS_BLOCKED.includes(rel) || rel.startsWith('.env')) {
          return JSON.stringify({ error: 'Cannot read secrets file — it contains private keys and API tokens.' });
        }

        if (!fsB.existsSync(target)) return JSON.stringify({ error: `File not found: ${args.path}` });
        const stat = fsB.statSync(target);
        if (stat.isDirectory()) return JSON.stringify({ error: `${args.path} is a directory — use list_files instead` });

        const allLines = fsB.readFileSync(target, 'utf8').split('\n');
        const offset   = Math.max(0, (args.offset ?? 1) - 1);
        const limit    = args.lines ?? 300;
        const slice    = allLines.slice(offset, offset + limit);
        return JSON.stringify({
          path:       pathB.relative(AGENT_ROOT, target),
          totalLines: allLines.length,
          shown:      `${offset + 1}–${offset + slice.length}`,
          content:    slice.join('\n'),
        });
      }

      case 'list_files': {
        const fsB   = require('fs');
        const pathB = require('path');
        const AGENT_ROOT = pathB.resolve(__dirname, '..');
        const target = pathB.resolve(AGENT_ROOT, args.path ?? '.');
        if (!target.startsWith(AGENT_ROOT + pathB.sep) && target !== AGENT_ROOT) {
          return JSON.stringify({ error: 'Path must be within the agent directory' });
        }
        if (!fsB.existsSync(target)) return JSON.stringify({ error: `Path not found: ${args.path}` });

        const entries = fsB.readdirSync(target).map(name => {
          const full = pathB.join(target, name);
          const s    = fsB.statSync(full);
          return { name, type: s.isDirectory() ? 'dir' : 'file', size: s.isFile() ? s.size : null };
        });
        return JSON.stringify({ path: pathB.relative(AGENT_ROOT, target) || '.', entries });
      }

      case 'write_file': {
        const fsB   = require('fs');
        const pathB = require('path');
        const AGENT_ROOT = pathB.resolve(__dirname, '..');
        const target = pathB.resolve(AGENT_ROOT, args.path ?? '');

        if (!target.startsWith(AGENT_ROOT + pathB.sep)) {
          return JSON.stringify({ error: 'Path must be within the agent directory' });
        }

        // Safety: never overwrite these core files
        const BLOCKED = ['.env', 'lib/swap.js', 'lib/wallet.js', 'lib/pisky.js', 'lib/processor.js', 'lib/memory.js'];
        const rel = pathB.relative(AGENT_ROOT, target);
        if (BLOCKED.includes(rel)) {
          return JSON.stringify({ error: `Cannot overwrite safety-critical file: ${rel}` });
        }

        const content = args.content ?? '';
        fsB.mkdirSync(pathB.dirname(target), { recursive: true });
        fsB.writeFileSync(target, content, 'utf8');
        log('info', `Tool: write_file ${rel}`, { bytes: content.length });
        return JSON.stringify({ written: true, path: rel, bytes: content.length, lines: content.split('\n').length });
      }

      case 'run_script': {
        const { spawnSync } = require('child_process');
        const pathB = require('path');
        const fsB   = require('fs');
        const AGENT_ROOT = pathB.resolve(__dirname, '..');
        const target = pathB.resolve(AGENT_ROOT, args.path ?? '');
        const rel    = pathB.relative(AGENT_ROOT, target);

        if (!target.startsWith(AGENT_ROOT + pathB.sep)) {
          return JSON.stringify({ error: 'Path must be within the agent directory' });
        }
        if (!fsB.existsSync(target)) {
          return JSON.stringify({ error: `Script not found: ${rel}` });
        }

        // Safety: don't directly exec core runtime files
        const BLOCKED_RUN = ['lib/swap.js', 'lib/wallet.js', 'agent.js'];
        if (BLOCKED_RUN.includes(rel)) {
          return JSON.stringify({ error: `Cannot run core runtime file: ${rel}` });
        }

        const scriptArgs = Array.isArray(args.args) ? args.args.map(String) : [];
        const timeout    = Math.min(args.timeout ?? 30_000, 120_000);
        log('info', `Tool: run_script ${rel}`, { args: scriptArgs, timeout });

        // Strip wallet key + sensitive API tokens from child process env.
        // Scripts can read market data (HELIUS_RPC_URL is kept) but cannot sign transactions.
        // AGENT_KEYPAIR is deliberately excluded — signing only happens through the agent's own swap.js.
        const {
          AGENT_KEYPAIR, TELEGRAM_BOT_TOKEN, OPENROUTER_API_KEY,
          PISKY_INTERNAL_KEY, JUPITER_API_KEY,
          ...safeEnv
        } = process.env;

        const result = spawnSync('node', [target, ...scriptArgs], {
          cwd:       AGENT_ROOT,
          timeout,
          maxBuffer: 1024 * 1024,
          encoding:  'utf8',
          env:       safeEnv,
        });

        return JSON.stringify({
          exitCode: result.status,
          stdout:   (result.stdout ?? '').slice(0, 8000),
          stderr:   (result.stderr ?? '').slice(0, 3000),
          timedOut: result.signal === 'SIGTERM',
          signal:   result.signal ?? null,
        });
      }

      case 'install_package': {
        const { spawnSync } = require('child_process');
        const pathB = require('path');
        const AGENT_ROOT = pathB.resolve(__dirname, '..');
        const pkg = (args.package ?? '').trim();
        if (!pkg) return JSON.stringify({ error: 'package name required' });

        // Reject obviously malformed input / shell injection attempts
        if (!/^[@a-zA-Z0-9._\-/]+(@[\w.\-^~>=<*|]+)?$/.test(pkg)) {
          return JSON.stringify({ error: 'Invalid package name' });
        }

        log('info', `Tool: install_package ${pkg}`);

        const result = spawnSync('npm', ['install', pkg], {
          cwd:       AGENT_ROOT,
          timeout:   120_000,
          maxBuffer: 2 * 1024 * 1024,
          encoding:  'utf8',
        });

        return JSON.stringify({
          package:  pkg,
          success:  result.status === 0,
          exitCode: result.status,
          stdout:   (result.stdout ?? '').slice(0, 3000),
          stderr:   (result.stderr ?? '').slice(0, 2000),
        });
      }

      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  }

  try {
    const result = await _exec();
    _cacheSet(name, args, result);
    return result;
  } catch (err) {
    log('warn', `Tool ${name} failed`, { error: err.message });
    return JSON.stringify({ error: err.message });
  }
}

module.exports = { TOOL_DEFINITIONS, executeTool };
