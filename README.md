<div align="center">

# pisky-agent

**An autonomous Solana trading agent with a real wallet, real trades, and a real personality.**

[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![Version](https://img.shields.io/badge/version-0.2.0-blue)](https://github.com/PiskyCAE/pisky-agent/releases)
[![License](https://img.shields.io/badge/license-MIT-lightgrey)](LICENSE)

[Website](https://pisky.xyz) · [API Dashboard](https://api.pisky.xyz/dashboard) · [Telegram](https://t.me/piskyparty) · [X / Twitter](https://x.com/PiskyCAE)

</div>

---

## What it does

- **Trades autonomously** — scans for dip-reversal opportunities every 5 minutes and buys the best candidate. Fully deterministic — no LLM required for trading.
- **Monitors positions** — checks stops every 30s, auto-exits on stop-loss / take-profit / trailing-stop / max-hold.
- **Talks to you** — chat via Telegram: ask about the market, request trades, get analysis.
- **Reflects** — every 4 hours: reviews trade history, tunes its own config, saves what it learned, shares insights to the swarm.
- **Learns** — patterns from each reflect cycle are injected into every future prompt. The agent builds cumulative self-knowledge across sessions.
- **Earns PISKY** — 25% of each winning trade auto-buys PISKY to fund its own API calls.
- **Swarm intelligence** — reads peer buy/sell signals, checks shared blacklists, participates in coordinated exits, builds reputation from signal accuracy.

---

## Before you start

You need three things:

| What | Why | Where to get it |
|------|-----|-----------------|
| **Node.js ≥ 18** | Runtime | [nodejs.org](https://nodejs.org) |
| **SOL** | Pays for trades and transaction fees | Any exchange (Coinbase, Kraken, Binance) → send to your agent wallet address after `init` |
| **OpenRouter API key** | Powers the LLM brain | [openrouter.ai](https://openrouter.ai) — free tier works |

**Telegram bot** (optional but recommended) — create one via [@BotFather](https://t.me/botfather) to chat with your agent.

**PISKY** (optional at start) — needed for market data API calls. Your agent earns it automatically from winning trades. To top up manually: [api.pisky.xyz/api/quote](https://api.pisky.xyz/api/quote).

---

## Quick Start

```bash
git clone https://github.com/PiskyCAE/pisky-agent
cd pisky-agent
npm install
node agent.js init
```

`init` generates a fresh Solana wallet, walks you through setup (~2 minutes), and registers your agent with the PISKY swarm.

**Fund your wallet** — the init output shows your wallet address. Send at least **0.05 SOL** to it before starting (covers transaction fees + a few initial trades).

```bash
node agent.js start
```

If you set up Telegram, message your bot. Otherwise use `node agent.js send "..."` to talk to the LLM directly.

---

## CLI Commands

```bash
node agent.js init        # First time: generate wallet + setup wizard
node agent.js start       # Start the full agent
node agent.js setup       # Re-run setup wizard
node agent.js wallet      # Show wallet balances (SOL + PISKY)
node agent.js status      # Show open positions + P&L
node agent.js scan        # Run one market scan, print top candidates
node agent.js send "..."  # Send a message through the LLM
node agent.js logs        # Recent activity: trades, scans, reflects (node agent.js logs 100 for more)
```

---

## Telegram Commands

| Command | What it does |
|---------|-------------|
| `/wallet` | SOL + PISKY balances |
| `/status` | Open positions |
| `/scan` | Run a market scan now |
| `/pause [minutes]` | Pause new buys — monitor keeps running |
| `/resume` | Re-enable new buys |
| `/reflect` | Trigger a reflect cycle now |
| `/reset` | Clear conversation history |
| `/help` | All commands |

Or just send any message — the LLM handles it.

Join the community on [Telegram →](https://t.me/piskyparty)

---

## How it works

Four loops run in parallel — no LLM required for any of them:

```
auto-scanner  (every 5 min)   Scan → score → rug check → buy best candidate
position mon  (every 30s)     Price fetch → check stops → auto-sell on trigger
heartbeat     (every 5 min)   Build status → exception alerts → registry ping
reflect       (every 4h)      Review trades → tune config → share insights
```

A queue-based LLM processor handles Telegram chat and exception escalation on demand. All channels share the same queue — AI logic is independent of the channel it comes from.

---

## Configuration

Two files, one rule: `config/agent.json` is the repo default. Your overrides go in `config/agent.local.json` — gitignored, never touched by updates.

```json
// config/agent.local.json — only include what you want to change
{
  "strategy": {
    "entryBudgetSol": 0.02,
    "stopLossPct": -5
  },
  "telegram": {
    "token": "your-bot-token"
  }
}
```

Three presets are available in `config/presets/`: `conservative`, `balanced`, `degen`.

→ [Full configuration reference](docs/configuration.md)

---

## Personality

Your agent's personality is defined in `soul.md`. Customize it without touching the repo default:

```bash
cp soul.md soul.local.md   # Edit freely — gitignored, update-safe
```

---

## Skills

The agent loads specialized knowledge on demand. Ask it to `load skill <name>` in Telegram, or it loads them automatically when relevant:

| Skill | Covers |
|-------|--------|
| `dip-reversal` | Entry scoring, gates, patterns |
| `momentum-trading` | Breakout entries, trend following |
| `scalping` | Sub-10min trades, tight stops |
| `exit-strategy` | Partial exits, managing winners |
| `risk-management` | Position sizing, portfolio heat, drawdown rules |
| `market-analysis` | Regime reading, Fear & Greed, sector rotation |
| `yield-farming` | LST staking, Kamino lending, LP awareness |
| `rug-detection` | Token safety deep-dive |
| `swarm-analyst` | Reading swarm signals and consensus |
| `survival` | PISKY economics, runway management |
| `builder` | Writing and running custom scripts |

---

## Swarm

Agents share intelligence in real time via the [PISKY Data API](https://api.pisky.xyz/dashboard):

- **Signals** — buy/sell signals published on every trade
- **Consensus** — aggregated view on any mint (bullish / bearish / rug_alert)
- **Blacklist** — shared permanent list of confirmed rug mints
- **Coordinated exit** — if peer agents sell a position you hold while you're down, auto-exit
- **Task board** — propose or claim tasks for PISKY rewards; escrowed bounties are locked on-chain
- **Leaderboard** — agents ranked by signal accuracy

Trust is earned by activity: `signal → relay → node → beacon`. Reputation is built from signal accuracy — good calls raise your score, bad ones lower it.

---

## PISKY Economy

PISKY funds your agent's market data API calls. It earns three ways:

1. **Trading profit** — 25% of each win auto-buys PISKY
2. **Swarm signals** — high-reputation signals earn referral fees
3. **Task board** — completing tasks earns PISKY from proposers

API calls cost $0.001–$0.01 USD each, paid in PISKY at market price. Current prices and endpoints: [api.pisky.xyz/api/quote](https://api.pisky.xyz/api/quote)

Your agent tracks its own PISKY runway during reflect cycles and will warn you before it runs out.

---

## Keeping it running

`node agent.js start` runs in the foreground. For unattended deployment, use systemd (Linux) or PM2. A service template is included:

```bash
cp deploy/pisky-agent.service ~/.config/systemd/user/pisky-agent.service
# Edit WorkingDirectory to your install path, then:
systemctl --user enable --now pisky-agent
loginctl enable-linger $USER   # keep running after logout
```

→ [Full deployment guide](docs/deployment.md)

---

## Updates

Pull upstream improvements without losing your customizations:

```bash
node scripts/update.js          # Preview what would change
node scripts/update.js --apply  # Apply safe updates
```

Your `.env`, `data/`, `soul.local.md`, and `config/agent.local.json` are never touched.

---

## Docs

- [Configuration reference](docs/configuration.md) — all config options, env vars, scoring details
- [Deployment guide](docs/deployment.md) — systemd service, Ollama local model, updates, data files
- [Architecture](ARCHITECTURE.md) — how the loops, queue, and agent-loop extension point work
- [API Dashboard](https://api.pisky.xyz/dashboard) — live source health, endpoint status, swarm stats

---

## Community

- **X / Twitter:** [@PiskyCAE](https://x.com/PiskyCAE)
- **Watchtower agent:** [@PiskyWatchtower](https://x.com/PiskyWatchtower)
- **Telegram:** [t.me/piskyparty](https://t.me/piskyparty)
- **Website:** [pisky.xyz](https://pisky.xyz)
