# @bellhop-marketing/mcp-install

One command to connect the **[Bellhop](https://bellhop.marketing) MCP server** to your AI client — Claude Code, Cursor, or Claude Desktop. It writes the right config entry for each client and points it at Bellhop's hosted, OAuth-authenticated MCP endpoint. There's no API key to paste: each client signs you in through the browser on first use.

```bash
npx @bellhop-marketing/mcp-install
```

That's it — the installer detects which clients you have, asks which to set up (or use `--all`), and writes the config. Restart the client and you're connected.

## What it does

The Bellhop MCP server is a **remote, streamable-HTTP endpoint** at `https://app.bellhop.marketing/mcp`, authenticated with OAuth 2.0. This installer simply adds a `bellhop` server entry to each client's MCP config:

| Client | Config file | Entry written |
| --- | --- | --- |
| **Claude Code** | `~/.claude.json` | `{ "type": "http", "url": "…/mcp" }` |
| **Cursor** | `~/.cursor/mcp.json` | `{ "url": "…/mcp" }` |
| **Claude Desktop** | `claude_desktop_config.json` (per-OS) | `npx -y mcp-remote …/mcp` bridge |

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
| `--url <url>` | Override the MCP endpoint (default `https://app.bellhop.marketing/mcp`). |
| `--name <name>` | Override the server key written to config (default `bellhop`). |
| `--help`, `-h` | Show help. |

### Examples

```bash
npx @bellhop-marketing/mcp-install                 # interactive — pick your clients
npx @bellhop-marketing/mcp-install --all --yes     # configure everything, no prompts
npx @bellhop-marketing/mcp-install --client cursor # just Cursor
npx @bellhop-marketing/mcp-install --print --all   # preview the config changes first
```

## After installing

1. **Restart** the client (fully quit and reopen Claude Desktop).
2. On first use, the client opens a browser to sign in to Bellhop and grant access. In Claude Code, run `/mcp` to trigger it.
3. You'll choose a workspace and the scopes to grant (`read`, `write`, `admin`, `billing`) — you can grant less than your role allows.

Manage or revoke authorized clients any time in **Bellhop → Settings → MCP**.

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

Remove the `bellhop` entry from the relevant config file (or restore the `.bak` the installer left next to it), then restart the client. Revoke the client's token in **Bellhop → Settings → MCP**.

## Notes

- **Zero runtime dependencies.** Node ≥ 18, built-ins only.
- **No telemetry.** The installer only reads and writes local config files.

## License

MIT © Dialogue Consulting Pty Ltd
