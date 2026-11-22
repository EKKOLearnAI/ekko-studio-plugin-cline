# Cline plugin contract

The manifest ID and local Agent ID are both `cline`. The backend registers Agent API v1 in `apply(ctx)`. The [SDK types](../sdk/src/agents.ts) define the host inputs and outputs. The plugin owns no Studio storage, RPCs, settings views, or checkpoints.

## Native runtime

- The Studio account and Profile that enabled the plugin own native authentication. A run must match the created Studio session, Agent, mode, account, and Profile.
- Cline is launched directly using an argument array. `--acp --auto-approve false` starts ACP v1. Studio requires the Cline identity and an explicit false auto-approval control before sending any prompt. Tool approval maps to the native one-time allow or reject option. Timeout, cancellation and failed interactions yield cancelled.
- The model catalog comes from `session/new` for the active native provider. A model requested by Studio must exist in that catalog. `session/set_config_option` applies it only to the new native session. The response must confirm the model, provider and disabled auto-approval.
- Each run launches one native process. The plugin supplies the host's instructions and prior Studio messages before the current prompt. It forwards incremental text, reasoning summaries and tool lifecycle events from the active ACP session. The complete streamed answer is returned once. Run cancellation sends `session/cancel` and closes the process. A finite startup timeout, run deadline and session disposal also release the process.
- Attachments are read through the host's authorized APIs. A run-private directory contains the file bytes and is removed when the run ends. The prompt supplies the matching path for the file-reading tool. This is compatible with Cline 3.0.75's ACP prompt handler, which extracts text blocks. The total is capped at 32 attachments and 32 MiB.
- Studio MCP entries are passed through ACP setup. Cline 3.0.75 records the entries during setup. Execution of run-scoped Studio MCP tools still needs upstream or end-to-end verification.
- Native stderr and JSON-RPC error data are kept out of Studio logs and approval messages. Model selection does not write to native defaults. Cline maintains its normal OS-level configuration and its own local logs.

The Agent advertises global single chat, streaming, and a manual install guide. Native conversation resume, scoped model proxy, and engine management are outside this version's capability declaration.
