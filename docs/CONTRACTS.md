# Cline plugin contract

The manifest ID and local Agent ID are both `cline`. The backend registers Agent API v1 in `apply(ctx)`. The [SDK types](../sdk/src/agents.ts) define the host inputs and outputs. The plugin supports global and scoped single chat with streaming.

## Engine management and login

- Agent management uses the latest metadata for the official `cline` npm release. The plugin installs its matching `@cline/cli-<platform>-<architecture>` package without lifecycle scripts. The standalone CLI runs directly and needs no npm wrapper at runtime.
- Plugin data under `engine/` contains the managed releases and `current.json`. A missing pointer preserves detection of an existing external engine. A null pointer represents a removed managed engine. A `release-…` value selects a verified staged installation. Upgrade compares the previous version, validates the staged binary version, commits the selection atomically and then removes the old release. Engine removal retains the Cline login and configuration.
- The activating Studio user and Profile can manage the engine and open the native login command. The `native-login` RPC returns a shell-quoted executable, configuration override if present, and `auth`. It returns an empty string when Cline is missing. The settings view displays that command without reading credentials.
- The Skill, MCP and configuration editors share the MiniMax Code layout. Skill writes preserve additional frontmatter and accompanying files. MCP writes retain the native transport and masked secrets. Configuration writes compare the observed revision of both Cline JSON files. The existing `native-login` view ID opens the configuration editor.
- `EKKO_CLINE_EXECUTABLE` still takes precedence as an external engine override. Before a managed installation, a native binary on PATH or an official npm wrapper may also be detected. Status exposes the runtime version and source.

## Native runtime

- The Studio account and Profile that enabled the plugin own the global native login. Scoped mode uses the actual caller’s Studio model authorization. A run must match the created Studio session, Agent, mode, account and Profile.
- Cline is launched with `--acp --auto-approve false`. Studio requires the Cline ACP v1 identity and explicit false auto-approval before prompting. For the active session, requests from the native `run_commands` or `Bash` tool receive the one-time allow option. Other tools use Studio’s approval interaction. Timeout, cancellation and failed interactions yield cancelled.
- The global model catalog comes from `session/new` for the active native provider. The selected model must exist in that catalog. The response to `session/set_config_option` must confirm the model, provider and disabled auto-approval. Model selection does not write the native default.
- Scoped writes per-turn `providers.json` and `models.json` in a private directory. The model registry supplies the exact Studio-selected model ID and available limits. The isolated native provider talks to an authenticated loopback proxy over Chat Completions. The proxy adds the Studio lease credential when calling the host. Cline receives only a per-turn loopback key. The proxy and isolated directory are released on completion, cancellation or failure. The plugin verifies Cline’s scoped provider and model before prompting.
- The activating owner’s scoped runs can use the configured native Skills and MCP entries. The model provider’s native credentials stay outside the scoped configuration.
- In global mode, the plugin reads the finished native session’s aggregate token counters and returns them in the Agent result. Cache write tokens contribute to the input count. Scoped model requests remain accounted for by the Studio proxy.
- Each turn starts a native process and receives the host’s instructions and prior messages. It forwards incremental text, reasoning summaries and tool events from the active ACP session. The complete answer is returned once. Cancellation sends `session/cancel` and closes the process. Startup timeout and session disposal also release the process.
- Attachments are read through authorized Studio APIs. A run-private directory contains the bytes and is removed when the run ends. The prompt supplies a path for Cline’s file-reading tool. Cline 3.0.75’s ACP prompt handler extracts text blocks. The per-turn limit is 32 attachments and 32 MiB.
- Studio sends its MCP entries through ACP setup. Cline 3.0.75 records those entries at setup time. Actual execution of run-scoped Studio MCP tools still needs verification.
- Native stderr and JSON-RPC error data are kept out of Studio logs and approval messages. Cline maintains its own normal logs in the configured directory.

The Agent advertises single chat and streaming. Native conversation resume remains disabled.
