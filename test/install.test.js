'use strict';

// Lightweight behavioural tests — no network, no real config touched. Each run
// spawns the installer in dry-run with a controlled PATH/HOME so we can assert
// the Claude Code registration strategy (CLI vs JSON merge) without side effects.

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BIN = path.join(__dirname, '..', 'bin', 'install.js');

/** Make a temp dir holding an executable `claude` stub that answers --version. */
function stubClaudeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bellhop-stub-'));
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "0.0.0 (stub)"; exit 0; fi\nexit 0\n');
  fs.chmodSync(bin, 0o755);
  return dir;
}

/** Run the installer with an isolated HOME and a chosen PATH; return stdout. */
function run(args, pathDir) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bellhop-home-'));
  const env = { ...process.env, HOME: home, PATH: pathDir, NO_COLOR: '1' };
  return execFileSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8' });
}

test('claude-code uses `claude mcp add` when the CLI is on PATH', () => {
  const dir = stubClaudeDir();
  const out = run(['--print', '--client', 'claude-code', '--no-skills'], dir);
  assert.match(out, /claude mcp add --transport http --scope user bellhop https:\/\/app\.bellhop\.marketing\/mcp/);
  assert.match(out, /via claude CLI/);
});

test('claude-code falls back to JSON merge when no CLI is present', () => {
  // PATH with no `claude` binary → JSON merge preview, not the CLI command.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'bellhop-nopath-'));
  const out = run(['--print', '--client', 'claude-code', '--no-skills'], empty);
  assert.match(out, /"type": "http"/);
  assert.match(out, /"url": "https:\/\/app\.bellhop\.marketing\/mcp"/);
  assert.doesNotMatch(out, /claude mcp add/);
});

test('--verify is accepted and does not error in dry-run', () => {
  const dir = stubClaudeDir();
  const out = run(['--print', '--verify', '--client', 'claude-code', '--no-skills'], dir);
  assert.match(out, /Dry run/);
});

test('--help documents --verify and the troubleshooting section', () => {
  const out = run(['--help'], process.env.PATH);
  assert.match(out, /--verify/);
  assert.match(out, /Troubleshooting/);
  assert.match(out, /signed in/i);
});
