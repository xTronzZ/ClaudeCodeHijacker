# ClaudeCodeHijacker

A persistent local relay for Claude Code on macOS and Windows. It launches a normal Claude Code session, rewrites client-attribution metadata, and forwards API traffic through a loopback-only listener.

## Requirements

- Node.js 22 or newer
- The native Claude Code CLI
- An interactive terminal or tmux pane
- An Anthropic API key

There are no third-party Node.js dependencies.

## API key

Create a local `.env` from the committed template:

```bash
cd /path/to/ClaudeCodeHijacker
cp .env.example .env
chmod 600 .env
```

Then edit `.env`:

```dotenv
CLAUDE_RELAY_API_KEY=sk-ant-api03-your-real-key
```

The relay loads credentials in this order:

1. `CLAUDE_RELAY_API_KEY` from the process environment;
2. `ANTHROPIC_API_KEY` from the process environment;
3. the same variables from the repository-root `.env` file;
4. hidden terminal input when none of the above is configured.

The real `.env` is ignored by Git. Only `.env.example` is committed; never put a real credential in that example file.

## Run

From the project you want Claude to work on:

```bash
node /path/to/ClaudeCodeHijacker/claude-code-relay.cjs
```

Or choose the project explicitly:

```bash
node ./claude-code-relay.cjs --project ../my-project
```

Arguments after `--` are passed directly to Claude Code:

```bash
node ./claude-code-relay.cjs --project ../my-project -- --model haiku --permission-mode auto
```

`npm start` is equivalent to running the relay with the current directory as the project.

When no environment key is configured, the fallback API key prompt does not echo input. After the key is loaded, Claude Code behaves as a normal persistent interactive session with its regular tools, settings, plugins, MCP servers, permissions, session history, thinking, context management, prompt caching, and output limits.

## tmux

The relay needs no tmux-specific configuration:

```bash
tmux new -s claude-relay
cd /path/to/project
node /path/to/ClaudeCodeHijacker/claude-code-relay.cjs
```

Runtime relay messages never write over the Claude UI. `CAPTURED`, `UPSTREAM`, listener, and error activity is written to `relay.log` inside the run directory.

## How it works

```text
Claude Code child process
        |
        | ANTHROPIC_BASE_URL=http://127.0.0.1:<random-port>
        v
Local Node.js relay
        |
        | HTTPS with the real API key
        v
Anthropic API
```

The listener binds to a random port on `127.0.0.1`. `ANTHROPIC_BASE_URL`, the placeholder key, and `NO_PROXY` are set only in the spawned Claude process environment. The relay does not:

- change the system proxy;
- install a certificate;
- modify the parent shell or tmux server environment;
- attach to or intercept other Claude Code processes;
- affect other tmux panes.

The child still uses normal Claude configuration and writes normal Claude session history, exactly as a direct Claude Code launch would.

Messages, token-counting, model-discovery, and other API paths are proxied upstream. For Messages payloads, the relay removes:

- `x-app` and `x-claude-code-*` headers;
- `claude-code-*` beta markers;
- the `x-anthropic-billing-header:` system block;
- the request `metadata` object.

Generation settings and tool payloads remain unchanged. Server-side billing or promotional-credit classification is not guaranteed.

## Logs

Every run gets a separate directory:

```text
outputs/sessions/<run-id>/
  relay.log
  requests.json
  forwarded-request-0001.json
  upstream-response-0001.json
  report.json
```

These records contain full prompts, replies, local paths, and other request metadata. API credentials are redacted, but the files are still sensitive and should not be shared without review. `outputs/` is excluded from Git.

## Development

```bash
npm run check
npm test
```

This project is independent and is not affiliated with or endorsed by Anthropic.
