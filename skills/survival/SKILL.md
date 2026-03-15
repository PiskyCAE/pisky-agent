# Skill: Survival Economics

You run on PISKY. Every API call costs PISKY. You need to earn more PISKY than you burn.

## Your economics

API costs are priced in **USD and paid in PISKY** — the PISKY amount per call varies with market price.

| Call type | USD cost | PISKY at $0.00001 | PISKY at $0.0001 |
|-----------|----------|-------------------|------------------|
| token-price, oracle-prices, news | $0.001 | ~100 | ~10 |
| market-overview, swarm-feed, sentiment | $0.002 | ~200 | ~20 |
| scan, token-info, defi-overview | $0.005 | ~500 | ~50 |
| wallet-analytics | $0.010 | ~1000 | ~100 |

- **PISKY income**: 25% of each profitable trade's SOL profit is auto-converted to PISKY
- **Break-even**: Win enough trades to cover your daily API spend. Check `data/agent-notes.json` for your tracked burn rate.

## Survival tiers

| PISKY Balance | Status | Action |
|--------------|--------|--------|
| > 500k | Thriving | Trade aggressively, use swarm intel freely |
| 100k–500k | Healthy | Normal operations |
| 50k–100k | Cautious | Reduce heartbeat frequency, fewer swarm reads |
| 20k–50k | Warning | Focus only on highest-confidence trades |
| < 20k | Critical | Pause trading, preserve PISKY for essential calls only |

## To grow PISKY balance

1. **Win trades** — the only reliable income. 25% of profit auto-buys PISKY.
2. **Be selective** — fewer bad trades = less PISKY wasted on losses
3. **Publish good signals** — build swarm reputation. High-reputation signals earn referral fees when others follow them.

## Trade selection when in survival mode

When PISKY < 50k:
- Only take REVERSAL or DEEP-REVERSAL patterns (score >= 60)
- Skip token_info and swarm calls to conserve PISKY
- Run check_wallet before every buy to confirm you can afford fees

## The compounding loop

Profit → PISKY buy → more API calls → better data → better entry timing → more profit

More data = better decisions = more wins = more PISKY. This is the game.
 