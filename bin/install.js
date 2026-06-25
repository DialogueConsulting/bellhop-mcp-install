#!/usr/bin/env node
'use strict';

/**
 * Bellhop MCP installer.
 *
 * Connects the hosted Bellhop MCP server (a remote, OAuth-authenticated
 * streamable-HTTP endpoint) to the local AI clients that speak MCP — Claude
 * Code, Cursor, and Claude Desktop — by writing the right entry into each
 * client's config file. No server runs locally; the clients authenticate to
 * Bellhop over OAuth on first use.
 *
 * Zero runtime dependencies — Node built-ins only, so `npx @bellhop-marketing/mcp-install`
 * is fast and auditable.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const DEFAULT_URL = 'https://app.bellhop.marketing/mcp';
const DEFAULT_NAME = 'bellhop';
const HOME = os.homedir();

// ── tiny ANSI helpers (disabled when not a TTY or NO_COLOR is set) ──────────
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => paint('1', s);
const dim = (s) => paint('2', s);
const green = (s) => paint('32', s);
const yellow = (s) => paint('33', s);
const cyan = (s) => paint('36', s);
const red = (s) => paint('31', s);

// ── client registry ────────────────────────────────────────────────────────
// Each client knows where its config lives, how a Bellhop remote-HTTP entry is
// shaped for it, a best-effort "is this installed?" probe, and a next-step hint.
function claudeDesktopConfigPath() {
  if (process.platform === 'darwin') {
    return path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
    return path.join(appData, 'Claude', 'claude_desktop_config.json');
  }
  return path.join(HOME, '.config', 'Claude', 'claude_desktop_config.json');
}

const CLIENTS = {
  'claude-code': {
    label: 'Claude Code',
    configPath: () => path.join(HOME, '.claude.json'),
    // Claude Code speaks remote HTTP MCP natively.
    entry: (url) => ({ type: 'http', url }),
    detect: () =>
      fs.existsSync(path.join(HOME, '.claude.json')) || fs.existsSync(path.join(HOME, '.claude')),
    next: (name) =>
      `Restart Claude Code, then run ${cyan('/mcp')} and approve the browser sign-in for "${name}".`,
  },
  cursor: {
    label: 'Cursor',
    configPath: () => path.join(HOME, '.cursor', 'mcp.json'),
    // Cursor accepts a bare remote URL.
    entry: (url) => ({ url }),
    detect: () => fs.existsSync(path.join(HOME, '.cursor')),
    next: () =>
      `Restart Cursor and open Settings → MCP. Bellhop prompts to sign in via OAuth on first use.`,
  },
  'claude-desktop': {
    label: 'Claude Desktop',
    configPath: claudeDesktopConfigPath,
    // Desktop's config file can't dial a remote MCP directly — bridge it
    // through the `mcp-remote` stdio proxy, which handles the OAuth dance.
    entry: (url) => ({ command: 'npx', args: ['-y', 'mcp-remote', url] }),
    detect: () => fs.existsSync(path.dirname(claudeDesktopConfigPath())),
    next: () =>
      `Fully quit and reopen Claude Desktop. Bellhop opens a browser to sign in on first use.`,
  },
};

const CLIENT_IDS = Object.keys(CLIENTS);

// ── config read / merge / write ─────────────────────────────────────────────
function readJson(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

/**
 * Merge a Bellhop server entry into one client's config. Preserves every other
 * key and every other MCP server. Returns a result descriptor; in dryRun the
 * file is never touched.
 */
function configure(clientId, opts) {
  const client = CLIENTS[clientId];
  const file = client.configPath();
  const entry = client.entry(opts.url);

  let config;
  let parseFailed = false;
  try {
    config = readJson(file);
  } catch {
    parseFailed = true; // malformed JSON — we'll back it up rather than lose it
    config = {};
  }
  if (typeof config !== 'object' || config === null || Array.isArray(config)) config = {};
  if (!config.mcpServers || typeof config.mcpServers !== 'object') config.mcpServers = {};

  const existed = Object.prototype.hasOwnProperty.call(config.mcpServers, opts.name);
  config.mcpServers[opts.name] = entry;
  const serialized = JSON.stringify(config, null, 2) + '\n';

  if (opts.dryRun) {
    return { clientId, file, action: existed ? 'update' : 'add', preview: serialized, parseFailed };
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  let backedUp = false;
  if (fs.existsSync(file)) {
    fs.copyFileSync(file, file + '.bak'); // always keep a one-step undo
    backedUp = true;
  }
  fs.writeFileSync(file, serialized);
  return { clientId, file, action: existed ? 'update' : 'add', backedUp, parseFailed };
}

// ── arg parsing ─────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = {
    clients: [],
    url: DEFAULT_URL,
    name: DEFAULT_NAME,
    all: false,
    yes: false,
    dryRun: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') opts.all = true;
    else if (a === '--yes' || a === '-y') opts.yes = true;
    else if (a === '--print' || a === '--dry-run') opts.dryRun = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--url') opts.url = argv[++i];
    else if (a === '--name') opts.name = argv[++i];
    else if (a === '--client') opts.clients.push(argv[++i]);
    else if (a.startsWith('--url=')) opts.url = a.slice('--url='.length);
    else if (a.startsWith('--name=')) opts.name = a.slice('--name='.length);
    else if (a.startsWith('--client=')) opts.clients.push(a.slice('--client='.length));
    else {
      console.error(red(`Unknown argument: ${a}`));
      console.error(`Run ${cyan('npx @bellhop-marketing/mcp-install --help')} for usage.`);
      process.exit(1);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`${bold('bellhop mcp-install')} — connect the Bellhop MCP server to your AI client

${bold('Usage')}
  npx @bellhop-marketing/mcp-install [options]

${bold('Options')}
  --client <id>   Configure a specific client (repeatable).
                  ids: ${CLIENT_IDS.join(', ')}
  --all           Configure every supported client.
  --yes, -y       Non-interactive: use detected clients (or all) without prompting.
  --print         Dry run — show what would be written, change nothing.
  --url <url>     Override the MCP endpoint (default: ${DEFAULT_URL}).
  --name <name>   Override the server key written to config (default: ${DEFAULT_NAME}).
  --help, -h      Show this help.

${bold('Examples')}
  npx @bellhop-marketing/mcp-install                 # interactive — pick your clients
  npx @bellhop-marketing/mcp-install --all --yes     # configure everything, no prompts
  npx @bellhop-marketing/mcp-install --client cursor
  npx @bellhop-marketing/mcp-install --print --all   # preview the config changes

Each client signs in to Bellhop over OAuth on first use — no API key to paste.`);
}

// ── interactive picker ──────────────────────────────────────────────────────
function promptSelect(detected) {
  return new Promise((resolve) => {
    console.log(bold('\nWhich clients should I configure?'));
    CLIENT_IDS.forEach((id, i) => {
      const mark = detected.includes(id) ? green('detected') : dim('not detected');
      console.log(`  ${bold(String(i + 1))}. ${CLIENTS[id].label} ${dim('(')}${mark}${dim(')')}`);
    });
    const defLabel = detected.length
      ? `detected (${detected.map((d) => CLIENTS[d].label).join(', ')})`
      : 'all';
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(
      `\nEnter numbers (comma-separated), ${bold('a')} for all, or Enter for ${bold(defLabel)}: `,
      (answer) => {
        rl.close();
        const ans = (answer || '').trim().toLowerCase();
        if (!ans) return resolve(detected.length ? detected : CLIENT_IDS);
        if (ans === 'a' || ans === 'all') return resolve(CLIENT_IDS.slice());
        const picked = [];
        for (const tok of ans.split(',').map((s) => s.trim()).filter(Boolean)) {
          const n = Number.parseInt(tok, 10);
          if (n >= 1 && n <= CLIENT_IDS.length && !picked.includes(CLIENT_IDS[n - 1])) {
            picked.push(CLIENT_IDS[n - 1]);
          }
        }
        resolve(picked);
      },
    );
  });
}

function safeDetect(id) {
  try {
    return CLIENTS[id].detect();
  } catch {
    return false;
  }
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return printHelp();

  for (const id of opts.clients) {
    if (!CLIENTS[id]) {
      console.error(red(`Unknown client: ${id}`));
      console.error(`Known clients: ${CLIENT_IDS.join(', ')}`);
      process.exit(1);
    }
  }
  if (!/^https?:\/\//i.test(opts.url)) {
    console.error(red(`--url must be an http(s) URL (got: ${opts.url})`));
    process.exit(1);
  }

  console.log(bold('\n🛎  Bellhop MCP installer'));
  console.log(dim(`   endpoint: ${opts.url}`));

  // Resolve the target client set.
  let targets = [...new Set(opts.clients)];
  if (!targets.length) {
    const detected = CLIENT_IDS.filter(safeDetect);
    const interactive = process.stdin.isTTY && process.stdout.isTTY;
    if (opts.all) targets = CLIENT_IDS.slice();
    else if (opts.yes || !interactive) targets = detected.length ? detected : CLIENT_IDS.slice();
    else targets = await promptSelect(detected);
  }

  if (!targets.length) {
    console.log(yellow('\nNo clients selected — nothing to do.'));
    return;
  }

  // Apply.
  const results = [];
  for (const id of targets) {
    try {
      results.push(configure(id, opts));
    } catch (err) {
      results.push({ clientId: id, error: err && err.message ? err.message : String(err) });
    }
  }

  // Report.
  if (opts.dryRun) {
    console.log(bold('\nDry run — no files written.\n'));
    for (const r of results) {
      if (r.error) {
        console.log(`${red('✗')} ${CLIENTS[r.clientId].label}: ${r.error}`);
        continue;
      }
      console.log(`${cyan('→')} ${bold(CLIENTS[r.clientId].label)} ${dim('·')} ${r.file} ${dim(`(${r.action})`)}`);
      console.log(r.preview.replace(/^/gm, '    '));
    }
    return;
  }

  console.log('');
  let ok = 0;
  for (const r of results) {
    if (r.error) {
      console.log(`${red('✗')} ${CLIENTS[r.clientId].label}: ${r.error}`);
      continue;
    }
    ok++;
    const note = r.parseFailed
      ? yellow(' (previous config was unreadable — backed up to .bak and rewritten)')
      : r.backedUp
        ? dim(' (backup: .bak)')
        : '';
    console.log(`${green('✓')} ${bold(CLIENTS[r.clientId].label)} ${dim('·')} ${r.file} ${dim(`[${r.action}]`)}${note}`);
  }

  if (ok) {
    console.log(bold('\nNext steps'));
    for (const r of results) {
      if (r.error) continue;
      console.log(`  ${dim('•')} ${CLIENTS[r.clientId].label}: ${CLIENTS[r.clientId].next(opts.name)}`);
    }
    console.log(dim(`\nManage authorized clients or revoke access in Bellhop → Settings → MCP.`));
  }
}

main().catch((err) => {
  console.error(red(`\nInstaller failed: ${err && err.stack ? err.stack : err}`));
  process.exit(1);
});
