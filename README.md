# Cline CLI for Ekko Studio

Cline registers as `plugin:cline/cline`. It supports streaming single chat in **global** and **scoped** mode.

## Setup

1. Install or update this [plugin repository](https://github.com/EKKOLearnAI/ekko-studio-plugin-cline) in Studio’s Plugin Center and enable it.
2. Open **Agent management → Cline CLI → Install**. Studio installs the official npm platform package selected by the `cline` npm release and verifies the native executable. The Studio host needs Node.js and npm.
3. Select **Cline CLI** in a new chat. For **global**, open **Settings → Configuration file** on the Agent card and run the displayed login command as the Studio service OS account. Refresh the model list to select a model from the active Cline provider. For **scoped**, select a provider and model configured in Studio. Scoped mode uses the Studio model gateway and starts without a Cline account.

Use **Check for updates** and **Update** for the Studio-managed engine. **Delete** removes the managed binary and retains native authentication and configuration. An external Cline installation detected on the host remains managed by its installer. For an explicit override, set `EKKO_CLINE_EXECUTABLE` to the absolute path of the external binary. Studio launches the native binary directly, including when a standard npm wrapper is on PATH.

## Configuration in Studio

- **Skills** edits descriptions and Markdown in Cline’s user Skill directory. Disabling a Skill parks its `SKILL.md` next to the original path. Edits and removal preserve companion files.
- **MCP servers** manages stdio, streamable HTTP, and SSE entries in the native `cline_mcp_settings.json`. Existing credentials are masked and retained when the mask is kept.
- **Configuration file** shows the engine status and login command, and edits the native `providers.json` and `globalState.json`. Settings writes verify the revision and preserve masked credentials.

The Studio account and Profile that enabled the plugin can manage native settings. Their scoped sessions can access their native Skills and MCP servers alongside the isolated Studio model.

## Runtime

- Both modes require Studio tool approvals and use a fresh ACP session per turn. Studio retains the chat history. A selected model is verified before prompting.
- Global uses the native `~/.cline` directory or the absolute `EKKO_CLINE_CONFIG_DIR` from the service environment. Cline ACP can restore native Cline, ClinePass, or ChatGPT Subscription credentials. Advanced deployments can set `CLINE_PROVIDER` and `CLINE_API_KEY` in the Studio service environment for a native provider.
- Scoped uses an isolated Cline configuration and the Studio Chat Completions proxy. The bound Studio model and run credential are isolated from native Cline settings.
- Global returns token counts from the completed native Cline session whenever available. Scoped usage is recorded by the Studio model proxy.
- Files and images are staged so Cline’s file-reading tools can access the uploaded bytes. Image inspection depends on the format, native tool and selected model. Studio MCP tool execution and native session resume still need acceptance.
- See the [plugin contract](docs/CONTRACTS.md) for the runtime and management details.

## Develop

Use Node.js 24.2 or a newer 24.x release.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run harness:check
npm test
npm pack --dry-run --ignore-scripts
```

Set `EKKO_CLINE_NATIVE_TEST_CLI` to an absolute path to the official Cline binary to include the native tests. They use isolated configuration with local Anthropic-compatible and Chat Completions endpoints. The tested native release is `3.0.75`.

The plugin is MIT licensed. The bundled Studio SDK retains its [license](sdk/LICENSE) and [notice](sdk/NOTICE). The [official Cline app icon](https://github.com/cline/cline/blob/0905884ab51cc10207902a07d992157568a0ed95/assets/branding/cline-app-icon.png) is included unchanged with the [upstream Apache 2.0 license](assets/CLINE-ICON-LICENSE). Cline’s trademarks are the property of their respective owners.
