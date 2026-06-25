# @bellhop-marketing/mcp-install

One command to connect the **[Bellhop](https://bellhop.marketing) MCP server** to your AI client — Claude Code, Cursor, or Claude Desktop — **and** install the [Bellhop skills](https://github.com/DialogueConsulting/bellhop-skills) into Claude Code. It writes the right config entry for each client and points it at Bellhop's hosted, OAuth-authenticated MCP endpoint. There's no API key to paste: each client signs you in through the browser on first use.

```bash
npx @bellhop-marketing/mcp-install
```

That's it — the installer detects which clients you have, asks which to set up (or use `--all`), writes the config, and offers to install the Bellhop skills. Restart the client and you're connected.

## What it does

The Bellhop MCP server is a **remote, streamable-HTTP endpoint** at `https://app.bellhop.marketing/mcp`, authenticated with OAuth 2.0. This installer simply adds a `bellhop` server entry to each client's MCP config:

| Client | Config file | How it's registered |
| --- | --- | --- |
| **Claude Code** | `~/.claude.json` | `claude mcp add --transport http …` when the `claude` CLI is present (falls back to writing `{ "type": "http", "url": "…/mcp" }` directly) |
| **Cursor** | `~/.cursor/mcp.json` | `{ "url": "…/mcp" }` |
| **Claude Desktop** | `claude_desktop_config.json` (per-OS) | `npx -y mcp-remote …/mcp` bridge |

For Claude Code the installer prefers the supported `claude mcp add` path: it writes through Claude Code's own config writer (no clobbering if Claude Code is open during `npx`) and reliably arms the `/mcp` sign-in prompt. When the CLI isn't on `PATH`, it merges the JSON entry directly instead.

Claude Desktop can't dial a remote MCP from its config file directly, so the installer bridges it through the standard [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) proxy, which handles the OAuth flow.

Your existing MCP servers and any other config keys are preserved — the installer merges in one entry and **backs up the previous file to `.bak`** before writing.

## Usage

```bash
npx @bellhop-marketing/mcp-install [options]
```

| Option | Description |
| --- | --- |
| `--client <id>` | Configure a specific client (repeatable). Ids: `claude-code`, `cursor`, `claude-desktop`. |
| `--all` | Configure every supported client. |
| `--yes`, `-y` | Non-interactive: use detected clients (or all) without prompting. |
| `--print` | Dry run — print what would be written, change nothing. |
| `--skills` | Also install the Bellhop skills into `~/.claude/skills` (no prompt). |
| `--no-skills` | Skip the Bellhop skills install. |
| `--uninstall` | Remove the Bellhop MCP entry and the `bellhop-*` skills. |
| `--verify` | After installing, run `claude mcp get` and report whether Claude Code registered the server. |
| `--url <url>` | Override the MCP endpoint (default `https://app.bellhop.marketing/mcp`). |
| `--name <name>` | Override the server key written to config (default `bellhop`). |
| `--help`, `-h` | Show help. |

### Examples

```bash
npx @bellhop-marketing/mcp-install                 # interactive — pick clients + skills
npx @bellhop-marketing/mcp-install --all --yes     # configure everything, no prompts
npx @bellhop-marketing/mcp-install --client cursor # just Cursor (MCP only)
npx @bellhop-marketing/mcp-install --skills        # MCP + skills, skip the skills prompt
npx @bellhop-marketing/mcp-install --print --all   # preview the config changes first
npx @bellhop-marketing/mcp-install --uninstall     # remove Bellhop config + skills
```

## Bellhop Skills

[Bellhop skills](https://github.com/DialogueConsulting/bellhop-skills) are opinionated, model-triggered workflows that drive the Bellhop MCP tools — build an intent map, find the safe zones to personalize, draft grounded copy, QA it before publish, run experiments, report results. When Claude Code is among your targets, the installer offers to install them:

```
Install the Bellhop skills into ~/.claude/skills? [Y/n]
```

Say yes (or pass `--skills`) and the skills land in `~/.claude/skills/bellhop-*`. An existing `bellhop-*` skill is backed up to `<name>.bak` before being replaced; no other skill is touched.

- **Claude Code / claude.ai only.** Skills are a Claude Code construct — Cursor and Claude Desktop get the MCP server only, so the installer skips skills for them.
- **How it works.** The installer fetches the public [`bellhop-skills`](https://github.com/DialogueConsulting/bellhop-skills) repo tarball and unpacks it with the `tar` that ships on macOS, Linux, and Windows 10+. Still zero npm dependencies.
- **Prefer to manage it yourself?** Add the repo as a Claude Code plugin marketplace instead:

  ```
  /plugin marketplace add DialogueConsulting/bellhop-skills
  /plugin install bellhop-skills
  ```

## After installing

1. **Restart** the client (fully quit and reopen Claude Desktop).
2. **Sign in — this is the step that actually loads the tools.** Bellhop's MCP is OAuth-protected, so its tools appear **only after** you complete the browser sign-in. In Claude Code: run `/mcp`, select **bellhop**, choose **Authenticate**, and finish the browser flow. A status of *"Connected"* alone means the server is reachable, **not** that you're signed in — the tools won't show until OAuth completes.
3. You'll choose a workspace and the scopes to grant (`read`, `write`, `admin`, `billing`) — you can grant less than your role allows.

Manage or revoke authorized clients any time in **Bellhop → Settings → MCP**.

## Troubleshooting

**"Connected" but no Bellhop tools show up.** That means the server is reachable but you haven't signed in yet — they're two different things. Run `/mcp`, select **bellhop**, choose **Authenticate**, and complete the browser flow; the tools load right after.

**`/mcp` doesn't offer an "Authenticate" action.** Reset the entry so Claude Code re-arms the prompt, then fully restart Claude Code:

```bash
claude mcp remove bellhop -s user
claude mcp add --transport http --scope user bellhop https://app.bellhop.marketing/mcp
```

Then run `/mcp` → **bellhop** → **Authenticate**. You can also re-run the installer with `--verify` to confirm registration.

## Connect manually

Prefer to do it yourself? For Claude Code:

```bash
claude mcp add --transport http bellhop https://app.bellhop.marketing/mcp
```

For Cursor, add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "bellhop": { "url": "https://app.bellhop.marketing/mcp" }
  }
}
```

## Uninstall

```bash
npx @bellhop-marketing/mcp-install --uninstall
```

This removes the `bellhop` MCP entry from each detected client's config (backing it up to `.bak` first) and deletes the `bellhop-*` skills from `~/.claude/skills`. You can scope it with `--client <id>` and preview it with `--print`. Then restart the client and revoke its token in **Bellhop → Settings → MCP**. To undo by hand instead, restore the `.bak` the installer left next to each config file.

## Notes

- **Zero runtime dependencies.** Node ≥ 18, built-ins only (skills install uses the system `tar`).
- **No telemetry.** The installer only reads and writes local config files and fetches the public skills tarball when you opt in.

## License

MIT © Dialogue Consulting Pty Ltd
