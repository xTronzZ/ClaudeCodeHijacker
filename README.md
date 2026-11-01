# ClaudeCodeHijacker

A local relay for **Windows and macOS** that intercepts Claude Code requests, rewrites client attribution metadata, and streams Anthropic API responses back to the CLI.

The relay launches its own isolated Claude Code session. It keeps your regular Claude Code configuration separate, accepts the upstream API key through hidden terminal input, and saves credential-redacted request and response records locally.

## Requirements

- Node.js **22 or newer**: [download Node.js](https://nodejs.org/en/download).
- The native Claude Code CLI: [official installation instructions](https://code.claude.com/docs/en/setup).
- Git, an interactive terminal, and an Anthropic API key with access to `claude-haiku-4-5`.
- Permission to connect to a local loopback listener and Anthropic's API.

There are no third-party Node.js dependencies, so `npm install` is not required.

## Quick start

### Windows — PowerShell

```powershell
git clone https://github.com/xTronzZ/ClaudeCodeHijacker.git
Set-Location ClaudeCodeHijacker
node --version
claude --version
node .\claude-code-relay.cjs --interactive --hi
```

### macOS — Terminal

Install the native CLI using Anthropic's installer or Homebrew. Anthropic documents this Homebrew command:

```bash
brew install --cask claude-code
```

Then clone and run:

```bash
git clone https://github.com/xTronzZ/ClaudeCodeHijacker.git
cd ClaudeCodeHijacker
node --version
claude --version
node ./claude-code-relay.cjs --interactive --hi
```

When prompted, paste your API key and press Enter. The key is not echoed or deliberately written to a file. The launched Claude Code process receives a local placeholder credential; the relay uses the real key only for the upstream request.

On first launch, Claude Code may ask you to select a theme, approve the placeholder environment key, and trust the newly created empty working directory. These choices apply to the isolated configuration under this repository's `work/` directory. If onboarding reaches the 60-second limit, run the command again.

The `--hi` option sends `Hi`. A successful run prints `UPSTREAM HTTP 200` and displays the real model reply in Claude Code. The greeting itself can vary.

## Finding the Claude executable

The relay checks common native installation paths and `PATH`:

| Platform | Locations |
| --- | --- |
| Windows | `%USERPROFILE%\.local\bin\claude.exe` and `PATH` |
| macOS | `~/.local/bin/claude`, Apple Silicon Homebrew under `/opt/homebrew/bin`, Intel Homebrew under `/usr/local/bin`, and `PATH` |

You can override discovery with an absolute executable path. Paths containing spaces are supported.

Windows:

```powershell
$env:CLAUDE_BINARY = (Get-Command claude.exe -ErrorAction Stop).Source
node .\claude-code-relay.cjs --interactive --hi
```

macOS:

```bash
export CLAUDE_BINARY="$(command -v claude)"
node ./claude-code-relay.cjs --interactive --hi
```

On Windows, use the native `.exe` rather than a `.cmd` launcher. The relay spawns the executable directly without a shell.

## Usage

```text
node claude-code-relay.cjs [--interactive] [--hi]
```

| Option | Behavior |
| --- | --- |
| `--interactive` | Launch the Claude Code terminal interface. |
| `--hi` | Send `Hi` with an output limit of 128 tokens. |
| `--help`, `-h` | Show usage without launching Claude Code or opening a listener. |

Without `--hi`, the prompt is `Reply exactly: RELAY_READY`, with a 16-token output limit. Without `--interactive`, Claude Code runs in print mode (`-p`) and returns JSON output. Hidden key entry still requires a real terminal.

You can also use:

```bash
npm start
```

This runs the interactive greeting command.

## How the relay works

```text
Claude Code (isolated configuration, placeholder key)
      |
      | HTTP to an automatically assigned 127.0.0.1 port
      v
Local Node.js relay
      |
      | Rewritten Messages request over HTTPS, real API key
      v
Anthropic API
      |
      | Streaming response
      v
Relay -> Claude Code terminal
```

The child process receives a temporary `ANTHROPIC_BASE_URL` pointing to the local listener. This uses Claude Code's [documented gateway configuration](https://code.claude.com/docs/en/llm-gateway-connect). It does not attach to an already running terminal or VS Code session, change the system proxy, or install a TLS certificate.

The relay applies these changes before forwarding the Messages request:

| Area | Transformation |
| --- | --- |
| User-Agent | Use a relay-specific User-Agent. |
| Client headers | Omit `x-app` and `x-claude-code-*` headers. |
| Beta capabilities | Remove `claude-code-*` entries while preserving other capability entries. |
| System attribution | Remove blocks starting with `x-anthropic-billing-header:`. |
| Identity metadata | Remove the request's `metadata` object. |
| Generation | Disable thinking, remove context management and cache controls, and apply the selected output limit. |
| Authentication | Replace the placeholder credential with the upstream API key. |

The observed `x-anthropic-billing-header:` marker is text in a system-prompt block, rather than a normal HTTP header. See Anthropic's [system attribution documentation](https://code.claude.com/docs/en/llm-gateway-protocol#system-prompt-attribution-block).

Other system instructions remain, including wording that identifies Claude Code. The relay does not claim complete anonymity or that attribution metadata is the only information used by the server.

## Current behavior

- One real upstream Messages request is allowed per run. Further requests receive a local `400` response.
- The upstream timeout is 30 seconds; the child process has a 60-second overall limit.
- Interactive mode stops shortly after the upstream attempt finishes, leaving local records available for inspection.
- Tools, installed plugins, MCP integrations, and other customizations are disabled in the isolated child process.
- Startup probes, model discovery, and token counting are answered locally. Only the Messages request is forwarded upstream.

This version is designed for one short exchange. It does not provide a persistent multi-turn session. If a reply hits the output limit, Claude Code may request a continuation, which the one-request limit rejects.

The relay makes a real API call and may consume credits. Successful forwarding has been observed on Windows. **Server-side product classification and promotional-credit eligibility have not been independently verified.** A `200` response alone does not establish which balance paid for the request.

Credentials requiring an explicit `anthropic-workspace-id` header need additional configuration; this version does not expose a workspace-selection option.

## Local records

Generated paths are relative to the repository:

```text
work/                    Isolated CLI configuration, working directory, debug logs
outputs/relay/           Default prompt records
outputs/hi/              Greeting records
```

| File | Contents |
| --- | --- |
| `interactive-requests.json` or `print-requests.json` | Captured incoming requests. |
| `forwarded-request.json` | The rewritten upstream request with authentication redacted. |
| `upstream-response.json` | Status, headers, response stream, parsed events, and generated text. |
| `interactive-report.json` or `print-report.json` | Process summary and upstream result. |

Run one instance at a time. Configuration paths are reused, and repeating a prompt type overwrites its shared forwarded-request and upstream-response files. Mode-specific capture and report files are also replaced when that mode repeats.

Records contain full prompts and replies, and can include local paths and device, session, organization, or workspace IDs. Credential redaction does not anonymize all content. Review records before sharing them. Generated directories are excluded by `.gitignore`.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Executable not found | Install the native CLI or set `CLAUDE_BINARY` to its full path. |
| Terminal required | Run directly in PowerShell or Terminal rather than piping input. |
| Permission denied on macOS | Check that the discovered native executable has execute permission; reinstalling through the official installer or Homebrew restores the launcher. |
| Unknown CLI option | Check `claude --help`; the live Windows session used version 2.1.316. |
| Connection error before capture | Check whether your execution environment permits loopback connections. |
| Upstream `401` or `403` | Inspect the saved response for credential or account restrictions. |
| Upstream `400` requesting a workspace | Use a credential that works without explicit workspace selection or add the required workspace header. |
| Local `400` after a partial reply | The client requested another exchange after the one-request limit. |

## Development

```bash
npm run check
npm test
```

The automated checks cover executable discovery, request rewriting, credential redaction, response streaming, upstream errors, and the one-request limit. The GitHub Actions workflow runs them on Windows and macOS with fixture credentials and simulated upstream responses; it does not make paid API calls.

Live interactive forwarding has been verified on Windows. Automated macOS coverage does not claim a live Anthropic session was run on a Mac.

## License

[Apache License 2.0](LICENSE). This project is independent and is not affiliated with or endorsed by Anthropic.
