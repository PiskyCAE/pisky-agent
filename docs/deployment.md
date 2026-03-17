# Deployment

## Run as a systemd Service

Keep your agent running after you close the terminal or reboot.

```bash
# Enable and start
systemctl --user enable --now pisky-agent

# View live logs
journalctl --user -u pisky-agent -f

# Stop
systemctl --user stop pisky-agent
```

Service file: `~/.config/systemd/user/pisky-agent.service`

---

## Local Model (Ollama)

Run without an OpenRouter API key using a local model.

```bash
ollama pull qwen2.5:7b
```

Add to `config/agent.local.json`:

```json
{
  "llm": {
    "provider": "ollama",
    "model": "qwen2.5:7b",
    "baseUrl": "http://localhost:11434/v1"
  }
}
```

**CPU-only servers:** Models ≤ 4B at 32k context are the practical limit. The auto-scanner and monitor are fully deterministic — no LLM needed for trading. The LLM is only used for Telegram chat, reflection, and exception handling.

---

## Keeping Your Agent Updated

Pull upstream improvements without losing your customizations:

```bash
node scripts/update.js          # Show what would change (dry run)
node scripts/update.js --apply  # Apply safe updates, skip your files
```

The update script applies changes to `lib/`, `skills/`, `agent.js`, and `package.json` — and skips `data/`, `.env`, `soul.local.md`, and `config/agent.local.json`.

Your agent can also do this itself: tell it *"check for updates and apply them"* and it will invoke the updater via `run_script`.

**Always safe to update:**
- New skills, bug fixes in `lib/`, new trading tools
- Updated `soul.md` (your `soul.local.md` always takes priority)
- Updated `config/agent.json` defaults (your `config/agent.local.json` overrides them)

**Always yours — never touched:**
- `data/` — positions, trade history, memory, profile, queue
- `.env` — secrets and API keys
- `soul.local.md` — your agent personality
- `config/agent.local.json` — your config overrides

---

## Data Files Reference

All runtime data lives in `data/` — this directory is gitignored.

| File | Contents |
|------|----------|
| `data/positions.json` | Open trading positions (atomic writes) |
| `data/trade_history.json` | All closed trades with P&L |
| `data/agent-identity.json` | Wallet address + swarm agent ID |
| `data/agent-profile.json` | Swarm profile (trust level, stats, specialization) |
| `data/agent-notes.json` | Self-learned patterns injected into every prompt (max 30, rolling) |
| `data/session_strategy.json` | Current session strategy set by the agent loop (mode, patternFilter, buy cap) |
| `data/trading_paused.json` | Pause gate — present when new buys are blocked (manual or low-SOL) |
| `data/suggested_config.json` | Config proposals from the last reflect cycle |
| `data/session-context.json` | Cached market context (SOL price, F&G, swarm summary) |
| `data/reflect_state.json` | Last reflect timestamp |
| `data/conversation.json` | Recent conversation history (compacted at 30 msgs) |
| `data/conversation_summary.md` | Rolling summary written by each reflect cycle |
| `data/users/` | Per-user memory and Telegram profiles (max 50 entries per user) |
| `data/queue/` | Message queues (incoming / processing / outgoing) |
| `logs/processor.log` | LLM processor log |
| `logs/heartbeat.log` | Heartbeat log |

---

## Dependencies

- `@solana/web3.js` — Solana wallet and on-chain queries
- `grammy` — Telegram bot framework
- `openai` — OpenAI-compatible client (works with OpenRouter and Ollama)
- `bs58` — Base58 key encoding
- Node.js >= 18 required
