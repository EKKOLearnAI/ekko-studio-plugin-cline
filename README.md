# Cline CLI for Ekko Studio

Use Cline's native model catalog and tool approvals in Studio single chat. The Studio Agent ID is `plugin:cline/cline`.

## Install

1. Install the official [Cline CLI](https://cline.bot/cli) on the Studio host. This plugin was verified against Cline CLI 3.0.75.
2. Run `cline auth` as the OS account running Studio. Cline ACP can restore native Cline, ClinePass, or ChatGPT Subscription credentials. Advanced deployments can pin the native provider with Cline's `CLINE_PROVIDER` and supply `CLINE_API_KEY` through the Studio service environment.
3. In Studio's Plugin Center, install [this GitHub repository](https://github.com/EKKOLearnAI/ekko-studio-plugin-cline), then enable it. Select Cline CLI and a model from the active native provider in a single chat.

If Studio cannot find Cline on its PATH, set `EKKO_CLINE_EXECUTABLE` to the absolute binary path in the Studio service environment. On macOS and Linux, the normal npm executable is discovered and its native binary is launched directly. On Windows, a native `cline.exe` is used. For a custom Cline configuration directory, set `EKKO_CLINE_CONFIG_DIR` and sign in with `cline --config <directory> auth`.

The Studio account and Profile that enabled the plugin can access the host's native Cline login. Each turn starts a fresh ACP session, applies the selected model to that session and uses Studio chat history for context. Studio handles tool permission requests. Scope is global single chat. Studio model proxy, native session resume and run-scoped MCP tool execution await verification. Files and images are staged for Cline's file-reading tools. Image inspection depends on the selected model, the file format and Cline's tool support.

## Develop

Use Node.js 24.2 or a newer 24.x release.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run harness:check
npm test
npm pack --dry-run --ignore-scripts
```

Set `EKKO_CLINE_NATIVE_TEST_CLI` to an absolute path to the official Cline binary to include the native test. It uses an isolated configuration and a local Anthropic-compatible test server.

See [the plugin contract](docs/CONTRACTS.md) for runtime behavior. The plugin is MIT licensed. The bundled Studio SDK retains its [license](sdk/LICENSE) and [notice](sdk/NOTICE). Install the upstream CLI separately under its own license.
