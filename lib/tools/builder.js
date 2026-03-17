// lib/tools/builder.js — file system and script execution tool definitions and handlers
// Tools: read_file, list_files, write_file, run_script, install_package
'use strict';

const fs   = require('fs');
const path = require('path');

const AGENT_ROOT = path.resolve(__dirname, '../..');

// Files the LLM can never overwrite (core runtime + secrets)
const BLOCKED_WRITE = ['.env', 'lib/swap.js', 'lib/wallet.js', 'lib/pisky.js', 'lib/processor.js', 'lib/memory.js'];

// Files the LLM can never run directly
const BLOCKED_RUN = ['lib/swap.js', 'lib/wallet.js', 'agent.js'];

// Files the LLM can never read
const BLOCKED_READ = ['.env', '.env.local', '.env.production'];

const DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file from the agent directory. Use this to inspect your own source code (lib/, config/), logs, or any file in the project before modifying it. Always read before writing.',
      parameters: {
        type: 'object',
        properties: {
          path:   { type: 'string', description: 'Relative path within the agent directory (e.g. lib/tools/trading.js, config/agent.json, logs/processor.log)' },
          lines:  { type: 'number', description: 'Max lines to return (default 300)' },
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

const HANDLERS = {
  async read_file(args, _ctx, _log) {
    const target = path.resolve(AGENT_ROOT, args.path ?? '');
    if (!target.startsWith(AGENT_ROOT + path.sep) && target !== AGENT_ROOT) {
      return JSON.stringify({ error: 'Path must be within the agent directory' });
    }
    const rel = path.relative(AGENT_ROOT, target);
    if (BLOCKED_READ.includes(rel) || rel.startsWith('.env')) {
      return JSON.stringify({ error: 'Cannot read secrets file — it contains private keys and API tokens.' });
    }
    if (!fs.existsSync(target)) return JSON.stringify({ error: `File not found: ${args.path}` });
    const stat = fs.statSync(target);
    if (stat.isDirectory()) return JSON.stringify({ error: `${args.path} is a directory — use list_files instead` });

    const allLines = fs.readFileSync(target, 'utf8').split('\n');
    const offset   = Math.max(0, (args.offset ?? 1) - 1);
    const limit    = args.lines ?? 300;
    const slice    = allLines.slice(offset, offset + limit);
    return JSON.stringify({
      path:       rel,
      totalLines: allLines.length,
      shown:      `${offset + 1}–${offset + slice.length}`,
      content:    slice.join('\n'),
    });
  },

  async list_files(args, _ctx, _log) {
    const target = path.resolve(AGENT_ROOT, args.path ?? '.');
    if (!target.startsWith(AGENT_ROOT + path.sep) && target !== AGENT_ROOT) {
      return JSON.stringify({ error: 'Path must be within the agent directory' });
    }
    if (!fs.existsSync(target)) return JSON.stringify({ error: `Path not found: ${args.path}` });

    const entries = fs.readdirSync(target).map(name => {
      const full = path.join(target, name);
      const s    = fs.statSync(full);
      return { name, type: s.isDirectory() ? 'dir' : 'file', size: s.isFile() ? s.size : null };
    });
    return JSON.stringify({ path: path.relative(AGENT_ROOT, target) || '.', entries });
  },

  async write_file(args, _ctx, log) {
    const target = path.resolve(AGENT_ROOT, args.path ?? '');
    if (!target.startsWith(AGENT_ROOT + path.sep)) {
      return JSON.stringify({ error: 'Path must be within the agent directory' });
    }
    const rel = path.relative(AGENT_ROOT, target);
    if (BLOCKED_WRITE.includes(rel)) {
      return JSON.stringify({ error: `Cannot overwrite safety-critical file: ${rel}` });
    }

    const content = args.content ?? '';
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
    log('info', `Tool: write_file ${rel}`, { bytes: content.length });
    return JSON.stringify({ written: true, path: rel, bytes: content.length, lines: content.split('\n').length });
  },

  async run_script(args, _ctx, log) {
    const { spawnSync } = require('child_process');
    const target = path.resolve(AGENT_ROOT, args.path ?? '');
    const rel    = path.relative(AGENT_ROOT, target);

    if (!target.startsWith(AGENT_ROOT + path.sep)) {
      return JSON.stringify({ error: 'Path must be within the agent directory' });
    }
    if (!fs.existsSync(target)) {
      return JSON.stringify({ error: `Script not found: ${rel}` });
    }
    if (BLOCKED_RUN.includes(rel)) {
      return JSON.stringify({ error: `Cannot run core runtime file: ${rel}` });
    }

    const scriptArgs = Array.isArray(args.args) ? args.args.map(String) : [];
    const timeout    = Math.min(args.timeout ?? 30_000, 120_000);
    log('info', `Tool: run_script ${rel}`, { args: scriptArgs, timeout });

    // Strip wallet key + sensitive API tokens from child process env.
    // Scripts can read market data (HELIUS_RPC_URL is kept) but cannot sign transactions.
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
  },

  async install_package(args, _ctx, log) {
    const { spawnSync } = require('child_process');
    const pkg = (args.package ?? '').trim();
    if (!pkg) return JSON.stringify({ error: 'package name required' });

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
  },
};

module.exports = { DEFINITIONS, HANDLERS };
