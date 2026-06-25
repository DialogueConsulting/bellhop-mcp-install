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
const https = require('https');
const readline = require('readline');
const { execFileSync } = require('child_process');

const DEFAULT_URL = 'https://app.bellhop.marketing/mcp';
const DEFAULT_NAME = 'bellhop';
const HOME = os.homedir();

// ── Bellhop Skills (Claude Code / claude.ai only) ───────────────────────────
// Skills are model-triggered, file-based workflows that drive the Bellhop MCP
// tools. They live in ~/.claude/skills/ and are a Claude Code construct — Cursor
// and Claude Desktop get the MCP server only. We fetch the public repo tarball
// at runtime (Node `https` + the shell `tar` that ships on macOS/Linux/Win10+),
// keeping the zero-runtime-dependency promise.
const SKILLS_TARBALL =
  'https://github.com/DialogueConsulting/bellhop-skills/archive/refs/heads/main.tar.gz';
const SKILLS_DIR = path.join(HOME, '.claude', 'skills');
const SKILL_PREFIX = 'bellhop-';
// Indicative list for dry-run previews only — a real install copies whatever the
// published tarball actually contains, so this never goes stale in a harmful way.
const EXPECTED_SKILLS = [
  'intent-map-builder',
  'zone-discovery-auditor',
  'grounded-variant-generator',
  'preview-citation-qa',
  'knowledge-freshness-watcher',
  'experiment-planner',
  'performance-analyst',
  'crm-alert-composer',
  'executive-roi-narrator',
  'privacy-consent-guardrail',
  'agency-orchestrator',
].map((s) => SKILL_PREFIX + s);

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
      `Restart Claude Code → run ${cyan('/mcp')} → select "${name}" → ${bold('Authenticate')} (a browser opens). ` +
      `Tools appear only ${bold('after')} sign-in — "Connected" alone is not enough.`,
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

// ── Bellhop Skills install / uninstall ──────────────────────────────────────
function httpGetBuffer(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    https
      .get(url, { headers: { 'User-Agent': 'bellhop-mcp-install' } }, (res) => {
        const { statusCode, headers } = res;
        if (statusCode >= 300 && statusCode < 400 && headers.location) {
          res.resume();
          return resolve(httpGetBuffer(new URL(headers.location, url).toString(), redirects + 1));
        }
        if (statusCode !== 200) {
          res.resume();
          return reject(new Error(`GET ${url} → HTTP ${statusCode}`));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

/**
 * Download the published skills, then copy every skills/bellhop-* directory into
 * ~/.claude/skills/. Idempotent: an existing bellhop-* dir is moved aside to
 * <dir>.bak before being replaced; no non-bellhop skill is ever touched.
 */
async function installSkills() {
  const buf = await httpGetBuffer(SKILLS_TARBALL);
  // GitHub serves a 200 HTML soft-404 when a repo has no commits on the branch.
  // A real gzip archive starts with the magic bytes 1f 8b — bail clearly if not.
  if (buf.length < 2 || buf[0] !== 0x1f || buf[1] !== 0x8b) {
    throw new Error(
      'the download was not a gzip archive — the bellhop-skills repo may be empty or not yet published',
    );
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bellhop-skills-'));
  try {
    const tarball = path.join(tmp, 'skills.tar.gz');
    const extractDir = path.join(tmp, 'extract');
    fs.writeFileSync(tarball, buf);
    fs.mkdirSync(extractDir);
    try {
      execFileSync('tar', ['-xzf', tarball, '-C', extractDir], { stdio: 'ignore' });
    } catch (e) {
      throw new Error(`could not extract the skills archive (is \`tar\` available?): ${e.message}`);
    }
    const top = fs.readdirSync(extractDir)[0]; // bellhop-skills-main
    const skillsParent = path.join(extractDir, top, 'skills');
    if (!fs.existsSync(skillsParent)) throw new Error('archive had no skills/ directory');

    const dirs = fs
      .readdirSync(skillsParent)
      .filter(
        (d) =>
          d.startsWith(SKILL_PREFIX) && fs.statSync(path.join(skillsParent, d)).isDirectory(),
      );

    fs.mkdirSync(SKILLS_DIR, { recursive: true });
    const installed = [];
    for (const name of dirs) {
      const dest = path.join(SKILLS_DIR, name);
      let backedUp = false;
      if (fs.existsSync(dest)) {
        fs.rmSync(dest + '.bak', { recursive: true, force: true });
        fs.renameSync(dest, dest + '.bak');
        backedUp = true;
      }
      fs.cpSync(path.join(skillsParent, name), dest, { recursive: true });
      installed.push({ name, backedUp });
    }
    return { installed };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Remove every bellhop-* skill directory (leaving any *.bak undo copies). */
function uninstallSkills() {
  if (!fs.existsSync(SKILLS_DIR)) return { removed: [] };
  const removed = [];
  for (const d of fs.readdirSync(SKILLS_DIR)) {
    if (!d.startsWith(SKILL_PREFIX) || d.endsWith('.bak')) continue;
    if (!fs.statSync(path.join(SKILLS_DIR, d)).isDirectory()) continue;
    fs.rmSync(path.join(SKILLS_DIR, d), { recursive: true, force: true });
    removed.push(d);
  }
  return { removed };
}

/** Remove the Bellhop MCP server entry from one client's config. */
function removeMcpEntry(clientId, opts) {
  const client = CLIENTS[clientId];
  const file = client.configPath();
  if (!fs.existsSync(file)) return { clientId, file, action: 'absent' };
  let config;
  try {
    config = readJson(file);
  } catch {
    return { clientId, file, action: 'unreadable' };
  }
  const had =
    config && config.mcpServers && Object.prototype.hasOwnProperty.call(config.mcpServers, opts.name);
  if (!had) return { clientId, file, action: 'absent' };
  if (opts.dryRun) return { clientId, file, action: 'remove' };
  delete config.mcpServers[opts.name];
  fs.copyFileSync(file, file + '.bak');
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  return { clientId, file, action: 'remove', backedUp: true };
}

// ── Claude Code via its own CLI (the supported path) ────────────────────────
// Hand-merging ~/.claude.json works, but Claude Code rewrites that large,
// stateful file itself — editing it while Claude Code is running can clobber our
// entry. `claude mcp add` writes through Claude Code's own safe writer, normalizes
// the entry, and reliably arms the /mcp OAuth prompt. We prefer it and keep the
// JSON merge as a fallback for machines without the CLI.
function claudeCliAvailable() {
  try {
    execFileSync('claude', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function configureClaudeCodeViaCli(opts) {
  const file = CLIENTS['claude-code'].configPath();
  const addArgs = ['mcp', 'add', '--transport', 'http', '--scope', 'user', opts.name, opts.url];
  if (opts.dryRun) {
    return { clientId: 'claude-code', file, method: 'cli', action: 'add', preview: `claude ${addArgs.join(' ')}` };
  }
  // Idempotent: drop any prior entry first so `add` can't fail with "already exists".
  try {
    execFileSync('claude', ['mcp', 'remove', '--scope', 'user', opts.name], { stdio: 'ignore' });
  } catch {
    /* not present — fine */
  }
  execFileSync('claude', addArgs, { stdio: 'ignore' });
  return { clientId: 'claude-code', file, method: 'cli', action: 'add' };
}

// Resolve the Claude Code apply strategy: CLI when available, JSON merge otherwise
// (or when the CLI errors). Always tags the result with `method` for reporting.
function applyClaudeCode(opts) {
  if (claudeCliAvailable()) {
    try {
      return configureClaudeCodeViaCli(opts);
    } catch (err) {
      const fallback = configure('claude-code', opts);
      fallback.method = 'json';
      fallback.cliError = err && err.message ? err.message : String(err);
      return fallback;
    }
  }
  const json = configure('claude-code', opts);
  json.method = 'json';
  return json;
}

function removeClaudeCodeViaCli(opts) {
  const file = CLIENTS['claude-code'].configPath();
  if (opts.dryRun) return { clientId: 'claude-code', file, method: 'cli', action: 'remove' };
  try {
    execFileSync('claude', ['mcp', 'remove', '--scope', 'user', opts.name], { stdio: 'ignore' });
    return { clientId: 'claude-code', file, method: 'cli', action: 'remove' };
  } catch {
    // Nothing registered under that scope — treat as absent rather than an error.
    return { clientId: 'claude-code', file, method: 'cli', action: 'absent' };
  }
}

// `claude mcp get <name>` after install. "Connected" here means reachable, NOT
// signed in — bellhop's tools only appear once OAuth completes via /mcp.
function verifyClaudeCode(opts) {
  try {
    const out = execFileSync('claude', ['mcp', 'get', opts.name], { encoding: 'utf8' });
    return { ok: true, out: out.trim() };
  } catch (err) {
    const msg = (err && (err.stdout || err.message)) || String(err);
    return { ok: false, out: String(msg).trim() };
  }
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
    skills: undefined, // tri-state: undefined = ask, true = force, false = skip
    uninstall: false,
    verify: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') opts.all = true;
    else if (a === '--yes' || a === '-y') opts.yes = true;
    else if (a === '--print' || a === '--dry-run') opts.dryRun = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--skills') opts.skills = true;
    else if (a === '--no-skills') opts.skills = false;
    else if (a === '--uninstall') opts.uninstall = true;
    else if (a === '--verify') opts.verify = true;
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
  --skills        Also install the Bellhop skills into ~/.claude/skills (no prompt).
  --no-skills     Skip the Bellhop skills install.
  --uninstall     Remove the Bellhop MCP entry and the bellhop-* skills.
  --verify        After install, run \`claude mcp get\` and report the status.
  --url <url>     Override the MCP endpoint (default: ${DEFAULT_URL}).
  --name <name>   Override the server key written to config (default: ${DEFAULT_NAME}).
  --help, -h      Show this help.

${bold('Examples')}
  npx @bellhop-marketing/mcp-install                 # interactive — pick clients + skills
  npx @bellhop-marketing/mcp-install --all --yes     # configure everything, no prompts
  npx @bellhop-marketing/mcp-install --client cursor
  npx @bellhop-marketing/mcp-install --skills        # MCP + skills, no skills prompt
  npx @bellhop-marketing/mcp-install --print --all   # preview the config changes
  npx @bellhop-marketing/mcp-install --verify        # install, then check it registered
  npx @bellhop-marketing/mcp-install --uninstall     # remove Bellhop config + skills

Each client signs in to Bellhop over OAuth on first use — no API key to paste.
For Claude Code the installer uses ${cyan('claude mcp add')} when the CLI is present
(falling back to editing ${cyan('~/.claude.json')} directly).
${bold('Bellhop Skills')} are a Claude Code / claude.ai feature (Cursor and Claude
Desktop get the MCP server only). They install into ${cyan('~/.claude/skills/bellhop-*')}.

${bold('Troubleshooting')}
  ${yellow('"Connected" but no Bellhop tools show up?')} That means the server is
  reachable but you haven't ${bold('signed in')} yet — they are two different things.
  Bellhop is OAuth-protected, so its tools only appear ${bold('after')} you complete
  the browser sign-in. In Claude Code: run ${cyan('/mcp')}, select "${DEFAULT_NAME}",
  choose ${bold('Authenticate')}, finish the browser flow, then the tools load.
  If ${cyan('/mcp')} shows no Authenticate action, reset the entry and retry:
    ${cyan(`claude mcp remove ${DEFAULT_NAME} -s user`)}
    ${cyan(`claude mcp add --transport http --scope user ${DEFAULT_NAME} ${DEFAULT_URL}`)}
  then fully restart Claude Code and run ${cyan('/mcp')} → Authenticate.`);
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

function promptYesNo(question, defaultYes = true) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`\n${question} ${defaultYes ? '[Y/n]' : '[y/N]'} `, (answer) => {
      rl.close();
      const a = (answer || '').trim().toLowerCase();
      if (!a) return resolve(defaultYes);
      resolve(a === 'y' || a === 'yes');
    });
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

  const detected = CLIENT_IDS.filter(safeDetect);
  const interactive = process.stdin.isTTY && process.stdout.isTTY;

  // ── uninstall path ──────────────────────────────────────────────────────
  if (opts.uninstall) {
    let targets = [...new Set(opts.clients)];
    if (!targets.length) targets = detected.length ? detected : CLIENT_IDS.slice();
    const cliReady = claudeCliAvailable();
    const mcpResults = targets.map((id) =>
      id === 'claude-code' && cliReady ? removeClaudeCodeViaCli(opts) : removeMcpEntry(id, opts),
    );

    if (opts.dryRun) {
      console.log(bold('\nDry run — nothing removed.\n'));
      for (const r of mcpResults) {
        console.log(`${cyan('→')} ${bold(CLIENTS[r.clientId].label)} ${dim('·')} ${r.file} ${dim(`(${r.action})`)}`);
      }
      const present = fs.existsSync(SKILLS_DIR)
        ? fs.readdirSync(SKILLS_DIR).filter((d) => d.startsWith(SKILL_PREFIX) && !d.endsWith('.bak'))
        : [];
      console.log(`${cyan('→')} skills ${dim('·')} ${SKILLS_DIR} ${dim(`(would remove ${present.length})`)}`);
      return;
    }

    console.log('');
    for (const r of mcpResults) {
      const verb = r.action === 'remove' ? green('removed') : dim(r.action);
      console.log(`  ${dim('•')} ${CLIENTS[r.clientId].label}: MCP entry ${verb}`);
    }
    const { removed } = uninstallSkills();
    console.log(`  ${dim('•')} Skills: removed ${green(String(removed.length))} bellhop-* skill(s) from ${SKILLS_DIR}`);
    console.log(bold('\nUninstalled.'));
    return;
  }

  // Resolve the target client set.
  let targets = [...new Set(opts.clients)];
  if (!targets.length) {
    if (opts.all) targets = CLIENT_IDS.slice();
    else if (opts.yes || !interactive) targets = detected.length ? detected : CLIENT_IDS.slice();
    else targets = await promptSelect(detected);
  }

  if (!targets.length) {
    console.log(yellow('\nNo clients selected — nothing to do.'));
    return;
  }

  // Apply. Claude Code goes through its own CLI when available; the other clients
  // (Cursor file, Claude Desktop mcp-remote bridge) have no CLI equivalent.
  const results = [];
  for (const id of targets) {
    try {
      results.push(id === 'claude-code' ? applyClaudeCode(opts) : { ...configure(id, opts), method: 'json' });
    } catch (err) {
      results.push({ clientId: id, error: err && err.message ? err.message : String(err) });
    }
  }

  // Decide whether to install skills (Claude Code / claude.ai only).
  const skillsRelevant = targets.includes('claude-code') || detected.includes('claude-code');

  // Report.
  if (opts.dryRun) {
    console.log(bold('\nDry run — no files written.\n'));
    for (const r of results) {
      if (r.error) {
        console.log(`${red('✗')} ${CLIENTS[r.clientId].label}: ${r.error}`);
        continue;
      }
      const via = r.method === 'cli' ? dim(' via claude CLI') : '';
      console.log(`${cyan('→')} ${bold(CLIENTS[r.clientId].label)} ${dim('·')} ${r.file} ${dim(`(${r.action})`)}${via}`);
      console.log((r.method === 'cli' ? cyan(`$ ${r.preview}`) : r.preview).replace(/^/gm, '    '));
    }
    const wouldSkills = opts.skills === false ? false : opts.skills === true || skillsRelevant;
    if (wouldSkills) {
      console.log(`${cyan('→')} ${bold('Bellhop Skills')} ${dim('·')} ${SKILLS_DIR}${path.sep}${SKILL_PREFIX}*`);
      console.log(dim(`    source: ${SKILLS_TARBALL}`));
      console.log(EXPECTED_SKILLS.map((s) => `    ${s}`).join('\n'));
      console.log(dim(`    (${EXPECTED_SKILLS.length} skills in the published set; actual install copies the tarball contents)`));
    } else {
      console.log(`${cyan('→')} ${dim('Bellhop Skills: skipped (Claude Code not targeted, or --no-skills)')}`);
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
    const note = r.cliError
      ? yellow(` (claude CLI failed: ${r.cliError} — wrote config directly instead; backup: .bak)`)
      : r.method === 'cli'
        ? dim(' (via claude CLI)')
        : r.parseFailed
          ? yellow(' (previous config was unreadable — backed up to .bak and rewritten)')
          : r.backedUp
            ? dim(' (backup: .bak)')
            : '';
    console.log(`${green('✓')} ${bold(CLIENTS[r.clientId].label)} ${dim('·')} ${r.file} ${dim(`[${r.action}]`)}${note}`);
  }

  // ── Bellhop Skills ────────────────────────────────────────────────────────
  let doSkills;
  if (opts.skills === false) doSkills = false;
  else if (opts.skills === true) doSkills = true;
  else if (!skillsRelevant) doSkills = false; // Cursor/Desktop only — skills don't apply
  else if (opts.yes || !interactive) doSkills = true;
  else doSkills = await promptYesNo(`Install the Bellhop skills into ${cyan('~/.claude/skills')}?`);

  if (doSkills) {
    process.stdout.write(dim('\nFetching Bellhop skills… '));
    try {
      const { installed } = await installSkills();
      console.log(green('done'));
      const backed = installed.filter((s) => s.backedUp).length;
      console.log(
        `${green('✓')} ${bold('Bellhop Skills')} ${dim('·')} installed ${green(String(installed.length))} into ${SKILLS_DIR}${
          backed ? dim(` (${backed} replaced; .bak kept)`) : ''
        }`,
      );
      console.log(dim('   Skills trigger automatically in Claude Code — e.g. "build an intent map for my site".'));
    } catch (err) {
      console.log(red('failed'));
      console.log(
        yellow(`   Couldn't install skills automatically: ${err && err.message ? err.message : err}`),
      );
      console.log(dim('   Install them manually as a Claude Code plugin:'));
      console.log(cyan('     /plugin marketplace add DialogueConsulting/bellhop-skills'));
      console.log(cyan('     /plugin install bellhop-skills'));
    }
  } else if (skillsRelevant && opts.skills === false) {
    console.log(dim('\nSkipped Bellhop skills (--no-skills).'));
  }

  // ── optional verification ──────────────────────────────────────────────────
  const ccConfigured = results.some((r) => !r.error && r.clientId === 'claude-code');
  if (opts.verify && ccConfigured && claudeCliAvailable()) {
    console.log(bold('\nVerifying Claude Code registration…'));
    const v = verifyClaudeCode(opts);
    if (v.ok) {
      console.log(v.out.replace(/^/gm, '  '));
      console.log(
        yellow(
          `\n  Note: "Connected" means reachable, ${bold('not signed in')}. Bellhop's tools appear`,
        ),
      );
      console.log(yellow(`  only after you complete the OAuth sign-in — run ${cyan('/mcp')} → Authenticate.`));
    } else {
      console.log(yellow(`  Could not read status via \`claude mcp get ${opts.name}\`: ${v.out}`));
    }
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
