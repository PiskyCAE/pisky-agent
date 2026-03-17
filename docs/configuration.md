# Configuration Reference

pisky-agent uses a two-file config system. `config/agent.json` is the repo default — updated by `git pull`. Your personal overrides go in `config/agent.local.json`, which is gitignored and never touched by updates.

You only need to include the keys you want to change:

```json
// config/agent.local.json
{
  "llm": {
    "model": "x-ai/grok-4.1-fast",
    "openrouterKey": "sk-or-..."
  },
  "strategy": {
    "entryBudgetSol": 0.02,
    "stopLossPct": -5
  },
  "telegram": {
    "token": "your-bot-token"
  }
}
```

---

## Trading Strategy

```json
{
  "strategy": {
    "scanIntervalMs": 300000,      // Scan frequency (default 5 min)
    "positionCheckMs": 30000,      // Monitor check interval (default 30s)
    "maxOpenPositions": 3,         // Max simultaneous positions
    "entryBudgetSol": 0.005,       // SOL per trade entry
    "minScanScore": 55,            // Min dip-reversal score to buy (0–100)
    "minLiquidity": 50000,         // Min pool liquidity in USD
    "stopLossPct": -6,             // Hard stop-loss %
    "takeProfitPct": 25,           // Take-profit %
    "maxHoldMinutes": 45,          // Max hold before forced exit
    "trailingStopActivatePct": 4,  // Trailing stop activates at +4%
    "trailingStopDistancePct": 3,  // Trails 3% below peak
    "buyCooldownMinutes": 60       // Skip re-entry on same mint for this long after exit
  }
}
```

## Risk

```json
{
  "risk": {
    "maxEntry1hDropPct": -15,  // Skip tokens with 1h drop worse than this
    "blacklist": [],           // Mint addresses to never trade
    "safeOnly": false          // Only trade RugCheck-verified-safe tokens
  }
}
```

## LLM

```json
{
  "llm": {
    "model": "x-ai/grok-4.1-fast",
    "provider": "openrouter",   // "openrouter" or "ollama"
    "baseUrl": "",              // Custom base URL (overrides provider default)
    "openrouterKey": ""         // Or set OPENROUTER_API_KEY env var
  }
}
```

## Swarm

```json
{
  "swarm": {
    "enabled": true,
    "autoPublish": true,             // Publish buy/sell signals on every trade
    "minReputationToFollow": 40,     // Only factor signals above this reputation score
    "consensusBoostFactor": 1.2      // Score boost when swarm agrees (+20%)
  }
}
```

## Survival & Reinvest

```json
{
  "survival": {
    "minSolWarning": 0.05,   // Warn when SOL drops below this
    "minSolPause": 0.02,     // Pause new buys below this
    "piskyReinvestPct": 0.25 // % of profit auto-converted to PISKY (default 25%)
  }
}
```

## Agent Loop (LLM Strategy)

The agent loop runs every 90 minutes. It gives the LLM a market/performance brief and lets it set the session strategy for the next window.

```json
{
  "agentLoop": {
    "intervalMs": 5400000   // Strategy reasoning interval (default 90 min)
  }
}
```

**Session modes** the LLM can set:

| Mode | Behaviour |
|------|-----------|
| `active` | Scanner buys best scoring candidate automatically |
| `selective` | Each candidate passes through a quick LLM approve/reject gate before buying |
| `watchOnly` | Scanner runs and broadcasts signals but does not buy |

The LLM can also set a `patternFilter` (e.g. `["REVERSAL"]`), a `minScoreOverride`, and a `maxBuysThisSession` cap. Strategy is saved to `data/session_strategy.json` and expires after 90 min.

## Reflect & Heartbeat

```json
{
  "reflect": {
    "intervalMs": 14400000,  // Reflect cycle interval (default 4h)
    "autoApply": true        // Auto-apply config suggestions to agent.local.json
  },
  "heartbeat": {
    "intervalMs": 300000,       // Heartbeat message interval (default 5 min)
    "contextRefreshMs": 1800000 // How often to refresh SOL price + Fear & Greed cache (default 30 min)
  }
}
```

---

## Personality

Your agent's personality is defined in `soul.md`. To customize it:

```bash
cp soul.md soul.local.md   # Start from the default, then edit
```

`soul.local.md` is gitignored and replaces `soul.md` when present. Updates never touch it.

Similarly, `config/reflect.md` defines the reflect cycle prompt and can be freely edited.

---

## Config Presets

Three ready-to-use risk profiles live in `config/presets/`:

| Preset | Description |
|--------|-------------|
| `conservative.json` | Tight filters, small positions, safe-only tokens |
| `balanced.json` | Default settings — matches `config/agent.json` |
| `degen.json` | Looser filters, larger positions, wider stops |

To apply a preset, copy the relevant keys into `config/agent.local.json`.

---

## Dip-Reversal Scoring

The auto-scanner uses a 6-component scoring system (0–100):

| Component | Signal |
|-----------|--------|
| Drop depth | 1h must be negative — confirms a dip |
| 5m bounce | ≥ 1% bounce — reversal signal |
| Buy pressure | Buy txns > 50% of total — real demand |
| Liquidity | ≥ minLiquidityUsd — not a ghost pool |
| Transaction count | ≥ 10 txns/5m — enough activity |
| Trend alignment | 6h/24h direction (uptrend bonus, death spiral penalty) |

Patterns: `SHALLOW-DIP`, `DIP-BUY`, `REVERSAL`, `DEEP-REVERSAL` (by 1h drop depth)

Before buying, the scanner also:
- Checks the swarm blacklist
- Runs a rug check on the top candidate
- Checks swarm consensus — if 2+ peer agents are bullish, applies `consensusBoostFactor`

---

## Environment Variables

All set in `.env` by the setup wizard. See `.env.example` for the full template.

| Variable | Description |
|----------|-------------|
| `AGENT_KEYPAIR` | Base58 Solana private key (generated by `init`) |
| `HELIUS_RPC_URL` | Helius RPC endpoint URL |
| `OPENROUTER_API_KEY` | OpenRouter API key (cloud LLM) |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from @BotFather |
| `JUPITER_API_KEY` | Optional — higher swap rate limits |
| `PISKY_INTERNAL_KEY` | Self-hosters only — bypasses x402 payment on localhost |
| `PISKY_API_URL` | Override the PISKY API base URL (env takes priority over config) |
