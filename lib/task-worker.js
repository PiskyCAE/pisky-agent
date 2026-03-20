// lib/task-worker.js — automated task completion for claimed tasks
//
// Called from the reflect cycle. Checks the task board for tasks this agent
// has claimed but not yet submitted, gathers relevant context, calls the LLM
// once to produce the deliverable, then submits.
//
// Design:
//   - One task per reflect cycle (one LLM call, avoids token burn)
//   - Priority: nearest deadline first, then oldest claim
//   - Max 3 attempts per task, tracked in data/task-worker-state.json
//   - Context pre-fetched based on task type before the LLM call
//   - No tool use — single prompt → structured SUMMARY:/WORK: output
//   - Skips tasks that genuinely can't be completed — calls abandon API so another agent can try
//   - Never throws — all errors are caught and logged
'use strict';

const fs   = require('fs');
const path = require('path');

const { loadIdentity } = require('./profile');

const DATA_DIR        = path.join(__dirname, '../data');
const STATE_FILE      = path.join(DATA_DIR, 'task-worker-state.json');
const TRADE_HIST_FILE = path.join(DATA_DIR, 'trade_history.json');

const MAX_ATTEMPTS  = 3;
const MAX_WORK_BYTES = 45_000; // under the 50KB API limit

const log = (level, msg, data = {}) => {
  const ts   = new Date().toISOString();
  const line = Object.keys(data).length ? `${msg} ${JSON.stringify(data)}` : msg;
  process.stdout.write(`[${ts}] [TASK-WORKER] [${level.toUpperCase()}] ${line}\n`);
};

// ── State management ──────────────────────────────────────────────────────────

function _loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return { attempts: {} };
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch { return { attempts: {} }; }
}

function _saveState(state) {
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

function _recordAttempt(state, taskId, { skipped = false, skipReason = null } = {}) {
  const prev = state.attempts[taskId] ?? { count: 0 };
  state.attempts[taskId] = {
    count:         prev.count + 1,
    lastAttemptAt: new Date().toISOString(),
    skipped,
    skipReason,
  };
  _saveState(state);
}

// Prune state entries for tasks that no longer appear claimed (completed or expired)
function _pruneState(state, claimedTaskIds) {
  const set = new Set(claimedTaskIds);
  let changed = false;
  for (const id of Object.keys(state.attempts)) {
    if (!set.has(id)) { delete state.attempts[id]; changed = true; }
  }
  if (changed) _saveState(state);
}

// ── LLM call — no tool use, structured output ─────────────────────────────────

async function _llmCall(cfg, prompt) {
  const llm      = cfg.llm ?? {};
  const provider = llm.provider ?? 'openrouter';
  const model    = llm.model    ?? 'x-ai/grok-4.1-fast';
  const key      = llm.openrouterKey || process.env.OPENROUTER_API_KEY || '';
  const baseUrl  = llm.baseUrl
    || (provider === 'ollama' ? 'http://localhost:11434/v1' : 'https://openrouter.ai/api/v1');

  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['Authorization'] = `Bearer ${key}`;

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method:  'POST',
    headers,
    body:    JSON.stringify({
      model,
      messages:    [{ role: 'user', content: prompt }],
      max_tokens:  4096,
      temperature: 0.3,
    }),
    signal: AbortSignal.timeout(90_000),
  });

  if (!resp.ok) throw new Error(`LLM HTTP ${resp.status}`);
  const data = await resp.json();
  return data.choices?.[0]?.message?.content?.trim() ?? '';
}

// ── Parse the structured LLM response ────────────────────────────────────────
// Expected format:
//   SUMMARY: <one sentence>
//   WORK:
//   <multi-line deliverable>
//
// Or, if the agent cannot complete it:
//   SKIP: <one sentence reason>

function _parseResponse(text) {
  const skipMatch = text.match(/^SKIP:\s*(.+)/im);
  if (skipMatch) {
    return { skip: true, skipReason: skipMatch[1].trim().slice(0, 300) };
  }

  const summaryMatch = text.match(/^SUMMARY:\s*(.+)/im);
  const workMatch    = text.match(/^WORK:\s*\n([\s\S]+)/im);

  if (!summaryMatch && !workMatch) {
    // No structured output — use the raw text as the work with a generic summary
    return {
      skip:    false,
      summary: 'Task completed — see work for details.',
      work:    text.trim(),
    };
  }

  return {
    skip:    false,
    summary: summaryMatch ? summaryMatch[1].trim().slice(0, 300) : 'Task completed.',
    work:    workMatch    ? workMatch[1].trim() : text.trim(),
  };
}

// ── Context gathering by task type ────────────────────────────────────────────

async function _gatherContext(task, api) {
  const sections = [];

  try {
    switch (task.type) {
      case 'analyze': {
        // Provide the agent's own trade history — the richest local dataset
        if (fs.existsSync(TRADE_HIST_FILE)) {
          const trades = JSON.parse(fs.readFileSync(TRADE_HIST_FILE, 'utf8'));
          // Summarise rather than dump the full file to stay within context
          const wins   = trades.filter(t => t.pnlPct > 0);
          const losses = trades.filter(t => t.pnlPct <= 0);
          const summary = {
            totalTrades: trades.length,
            winRate:     trades.length ? ((wins.length / trades.length) * 100).toFixed(1) + '%' : 'n/a',
            avgPnlPct:   trades.length
              ? (trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length).toFixed(2) + '%'
              : 'n/a',
            avgHoldMins: trades.length
              ? (trades.reduce((s, t) => s + (t.holdMinutes ?? 0), 0) / trades.length).toFixed(1)
              : 'n/a',
            exitReasons: _countBy(trades, 'reason'),
          };
          sections.push('TRADE HISTORY SUMMARY:\n' + JSON.stringify(summary, null, 2));
          // Include full trade list (capped at last 100 trades to keep prompt manageable)
          const recent = trades.slice(-100).map(t => ({
            symbol:      t.symbol,
            entryTime:   t.entryTime,
            holdMinutes: t.holdMinutes,
            pnlPct:      t.pnlPct?.toFixed(2),
            peakPnlPct:  t.peakPnlPct?.toFixed(2),
            reason:      t.reason,
          }));
          sections.push('INDIVIDUAL TRADES (most recent 100):\n' + JSON.stringify(recent, null, 2));
        }
        break;
      }

      case 'research': {
        // Base market context
        const [overview, pools] = await Promise.allSettled([
          api.marketOverview(),
          api.topPools(10),
        ]);
        if (overview.status === 'fulfilled' && overview.value) {
          sections.push('MARKET OVERVIEW:\n' + JSON.stringify(overview.value, null, 2).slice(0, 3000));
        }
        if (pools.status === 'fulfilled' && pools.value) {
          sections.push('TOP POOLS (24h volume):\n' + JSON.stringify(pools.value, null, 2).slice(0, 3000));
        }

        // If the task involves trade outcomes / backtesting, include this agent's own trade history.
        // Tasks that say "my losses" should be interpreted as THIS agent's losses — a valid proxy dataset.
        const tradeKeywords = ['trade', 'loss', 'win', 'backtest', 'history', 'outcome', 'pnl', 'sl', 'stop', 'sample'];
        const isTradeResearch = tradeKeywords.some(kw => new RegExp(kw, 'i').test(task.description + ' ' + task.title));
        let tradeMints = [];
        if (isTradeResearch && fs.existsSync(TRADE_HIST_FILE)) {
          try {
            const trades = JSON.parse(fs.readFileSync(TRADE_HIST_FILE, 'utf8'));
            const week   = Date.now() - 7 * 86_400_000;
            const recent = trades.filter(t => new Date(t.exitTime ?? t.entryTime).getTime() >= week);
            const wins   = recent.filter(t => (t.pnlPct ?? 0) > 0);
            const losses = recent.filter(t => (t.pnlPct ?? 0) <= 0);
            const tradeRows = recent.slice(-100).map(t => ({
              mint:        t.mint,
              symbol:      t.symbol,
              pnlPct:      t.pnlPct?.toFixed(2),
              peakPnlPct:  t.peakPnlPct?.toFixed(2),
              holdMinutes: t.holdMinutes,
              reason:      t.reason,
              pattern:     t.pattern,
              entryTime:   t.entryTime,
            }));
            sections.push(
              `THIS AGENT'S OWN TRADE HISTORY (7d: ${recent.length} trades, ` +
              `${wins.length} wins / ${losses.length} losses):\n` +
              JSON.stringify(tradeRows, null, 2).slice(0, 5000)
            );
            tradeMints = recent.map(t => t.mint).filter(Boolean);
          } catch (e) {
            log('warn', 'Could not read trade history for research context', { error: e.message });
          }
        }

        // If the task involves holder concentration, fetch batch data.
        // Prefer trade history mints (agent's own loss/win mints) over generic pool mints —
        // that's exactly the data needed for holder-concentration backtest tasks.
        const holderKeywords = ['holder', 'concentration', 'whale', 'distribution', 'top.*wallet', 'top5', 'top 5'];
        const isHolderTask = holderKeywords.some(kw => new RegExp(kw, 'i').test(task.description + ' ' + task.title));
        if (isHolderTask) {
          const poolMints = pools.status === 'fulfilled'
            ? (pools.value?.pools ?? []).slice(0, 10).map(p => p.baseToken?.mint ?? p.mint).filter(Boolean)
            : [];
          // Use trade mints when available (more relevant for backtests), fall back to pool mints
          const mintsToCheck = tradeMints.length
            ? [...new Set(tradeMints)].slice(0, 10)
            : poolMints.slice(0, 10);
          if (mintsToCheck.length) {
            try {
              const holderData = await api._fetch(`/api/token-holders-batch?mints=${mintsToCheck.join(',')}`);
              if (holderData.ok) {
                const json = await holderData.json();
                sections.push('HOLDER CONCENTRATION (top 5/10/20% of supply per mint):\n' + JSON.stringify(json.results, null, 2).slice(0, 5000));
              }
            } catch (e) {
              log('warn', 'Holder batch fetch failed (non-critical)', { error: e.message });
            }
          }
        }
        break;
      }
      case 'trade': {
        const [pools, sentiment] = await Promise.allSettled([
          api.topPools(10),
          api.marketSentiment(),
        ]);
        if (pools.status === 'fulfilled' && pools.value) {
          sections.push('TOP POOLS:\n' + JSON.stringify(pools.value, null, 2).slice(0, 2000));
        }
        if (sentiment.status === 'fulfilled' && sentiment.value) {
          sections.push('MARKET SENTIMENT:\n' + JSON.stringify(sentiment.value, null, 2));
        }
        break;
      }

      // build / skill / other — no pre-fetch; task description is sufficient
      default:
        break;
    }
  } catch (err) {
    log('warn', 'Context gather error (continuing anyway)', { error: err.message });
  }

  return sections.join('\n\n');
}

function _countBy(arr, key) {
  return arr.reduce((acc, item) => {
    const val = item[key] ?? 'unknown';
    acc[val] = (acc[val] ?? 0) + 1;
    return acc;
  }, {});
}

// ── Build the task prompt ─────────────────────────────────────────────────────

function _buildPrompt(task, context) {
  const typeGuide = {
    research: 'Gather and synthesize the requested data. Present findings clearly with numbers.',
    analyze:  'Analyse the provided trade history data. Show your working — include counts, percentages, and a concrete recommendation.',
    build:    'Write the requested code or script. Include comments. You cannot execute it here, so make sure the code is self-explanatory and correct.',
    skill:    'Write the skill document or strategy as requested. Be specific and actionable.',
    trade:    'Provide a concrete trading recommendation based on the data. Include specific token/pair names and reasoning.',
    other:    'Complete the task as described. Be thorough and specific.',
  };

  const guide = typeGuide[task.type] ?? typeGuide.other;

  const contextBlock = context
    ? `\nCONTEXT DATA:\n${context}\n`
    : '';

  const deadline = task.deadline
    ? `\nDEADLINE: ${task.deadline}`
    : '';

  return `You are a Solana trading agent completing an assigned swarm task. Do the work — do not ask clarifying questions.

TASK TYPE: ${task.type}
TASK TITLE: ${task.title}${deadline}
TASK DESCRIPTION:
${task.description}
${contextBlock}
GUIDANCE: ${guide}

IMPORTANT — PARTIAL DATA IS FINE:
Work with whatever context data is provided above, even if some fields are missing or incomplete.
Only use SKIP if the task is fundamentally impossible (e.g. no data whatsoever, or requires a live
external API key you have no access to). Incomplete data or missing a few fields is NOT a reason to skip.

Your response MUST use this exact format — no preamble, no extra text:

SUMMARY: <one sentence describing what you did and the key finding>
WORK:
<the full deliverable — analysis, code, findings, or document>

Only if the task is truly impossible (not just hard or with partial data):
SKIP: <one concise sentence explaining what is blocking completion>`;
}

// ── Main entry point ──────────────────────────────────────────────────────────

async function runTaskWorker(cfg, api) {
  const identity = loadIdentity();
  const myId     = identity.agentId;
  const myAddr   = identity.address;
  if (!myId) { log('warn', 'No agentId — skipping task worker'); return; }

  // 1. Fetch claimed tasks
  let claimedTasks = [];
  try {
    const res = await api.taskList({ status: 'claimed', limit: 50 });
    claimedTasks = (res?.tasks ?? []).filter(t => t.claimedBy === myId);
  } catch (err) {
    log('warn', 'Could not fetch claimed tasks', { error: err.message });
    return;
  }

  if (!claimedTasks.length) {
    log('info', 'No claimed tasks pending work');
    return;
  }

  // 2. Load attempt state; prune stale entries
  const state = _loadState();
  _pruneState(state, claimedTasks.map(t => t.taskId));

  // 3. Filter out tasks already submitted (belt-and-suspenders — API enforces too)
  //    and tasks that have been skipped or exceeded max attempts
  const workable = claimedTasks.filter(t => {
    const a = state.attempts[t.taskId];
    if (!a) return true;
    if (a.skipped)        return false;   // agent already decided it can't do this
    if (a.count >= MAX_ATTEMPTS) return false;  // gave up
    return true;
  });

  if (!workable.length) {
    log('info', `${claimedTasks.length} claimed task(s) — all at max attempts or skipped`);
    return;
  }

  // 4. Pick one task: nearest deadline first, then oldest claim
  const pick = workable.sort((a, b) => {
    const dA = a.deadline ? new Date(a.deadline).getTime() : Infinity;
    const dB = b.deadline ? new Date(b.deadline).getTime() : Infinity;
    if (dA !== dB) return dA - dB;
    return new Date(a.claimedAt) - new Date(b.claimedAt);
  })[0];

  const { taskId, title, type } = pick;
  const attemptNum = (state.attempts[taskId]?.count ?? 0) + 1;

  log('info', `Working on task (attempt ${attemptNum}/${MAX_ATTEMPTS})`, { taskId, type, title });

  // 5. Gather context, build prompt, call LLM
  let parsed;
  try {
    const context = await _gatherContext(pick, api);
    const prompt  = _buildPrompt(pick, context);
    const raw     = await _llmCall(cfg, prompt);
    parsed        = _parseResponse(raw);
  } catch (err) {
    log('warn', 'LLM call failed', { taskId, error: err.message });
    _recordAttempt(state, taskId);
    return;
  }

  // 6. Handle skip — abandon the claim so another agent can try
  if (parsed.skip) {
    log('info', 'Agent skipped task — releasing claim', { taskId, reason: parsed.skipReason });
    try {
      await api.taskAbandon(myId, myAddr, taskId, parsed.skipReason);
      // Remove from local state — another agent gets a clean slate on this task
      delete state.attempts[taskId];
      _saveState(state);
    } catch (err) {
      // Abandon is best-effort; record locally so we don't keep retrying a task we can't do
      log('warn', 'Abandon API call failed — recording locally', { taskId, error: err.message });
      _recordAttempt(state, taskId, { skipped: true, skipReason: parsed.skipReason });
    }
    return;
  }

  // 7. Guard work size
  if (Buffer.byteLength(parsed.work, 'utf8') > MAX_WORK_BYTES) {
    parsed.work    = parsed.work.slice(0, MAX_WORK_BYTES);
    parsed.summary = parsed.summary + ' [truncated to fit 50KB limit]';
    log('warn', 'Work truncated to fit API limit', { taskId });
  }

  // 8. Submit
  try {
    const res = await api.taskSubmit(myId, myAddr, taskId, parsed.work, parsed.summary);
    if (res?.error) {
      log('warn', 'Submit rejected by API', { taskId, error: res.error });
      _recordAttempt(state, taskId);
    } else {
      log('info', 'Task submitted', { taskId, submissionId: res?.submissionId });
      // Remove from state — it's submitted, future retries make no sense
      delete state.attempts[taskId];
      _saveState(state);
    }
  } catch (err) {
    log('warn', 'Submit HTTP error', { taskId, error: err.message });
    _recordAttempt(state, taskId);
  }
}

module.exports = { runTaskWorker };
