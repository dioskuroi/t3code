# omp

T3 Code runs the independent `omp` CLI as an agent, using the accounts and credentials you
already configured for omp. omp is its own agent CLI — it is not opencode and unrelated to the
separate [opencode](./providers-opencode.md) provider T3 Code also supports. omp is zero-config
in T3 Code: there is no provider settings form beyond the enable switch, and the binary is
discovered on the server's `PATH`.

## Set Up omp

1. Install omp on the machine running the T3 Code server and make sure `omp` is on that
   machine's `PATH`. T3 Code starts `omp --mode rpc` itself; there is no **Binary path** setting
   to override discovery.
2. Sign in once, in a terminal on that machine: run `omp login`. Providers that use an API key can
   skip this step by exporting the key (see the table below) — the T3 Code server process passes
   its environment to omp.
3. Open **Settings → Providers**, enable omp, and refresh it. The status check runs a short-lived
   `omp --mode rpc --no-session` process, so refreshing never logs you in, creates a session, or
   touches your MCP servers.

T3 Code needs an omp that speaks RPC protocol v2. An omp too old to negotiate v2 fails the status
check with an upgrade hint.

## Credentials

omp resolves credentials from its own configuration or from the environment. Keys set as
environment variables for the omp provider instance are inherited by the omp process:

| Provider          | API key environment variable         |
| ----------------- | ------------------------------------ |
| zai               | `ZAI_API_KEY`                        |
| zhipu-coding-plan | `ZHIPU_API_KEY`                      |
| moonshot          | `MOONSHOT_API_KEY` or `KIMI_API_KEY` |
| deepseek          | `DEEPSEEK_API_KEY`                   |

OAuth-style providers are not configured with keys: run `omp login` once in a terminal on the
server machine, then refresh the provider in T3 Code.

## Models

The model picker lists every model omp reports, grouped by the omp provider each model belongs
to — `zai`, `zhipu-coding-plan`, `moonshot`, `deepseek`, and any custom providers you configured
in omp. T3 Code passes the catalog through unfiltered; refresh the provider after changing your
omp configuration.

New threads start on the model omp itself resolves (its configured default). Models are applied
with omp's own `set_model` while the thread is idle, and the choice is restored when T3 Code
restarts the omp process. When omp cannot apply a model, the turn fails with omp's error and a
re-selection hint — T3 Code never falls back to a different model.

Models with reasoning show a **Thinking** setting with the levels omp offers for that model,
such as off, low, high, and max. Levels apply fail-closed the same way: an unapplied level fails
the turn instead of silently running at another level.

## Permission Modes

omp enforces permissions in its own process; T3 Code maps the thread's mode to omp's
`--approval-mode`:

- **Supervised** runs `omp --approval-mode always-ask`: omp asks before writes and commands, and
  the requests appear in the conversation with omp's own choices (approve once, approve for this
  session, or deny).
- **Auto-accept edits** runs `omp --approval-mode write`.
- **Full access** runs `omp --approval-mode yolo`.
- **Auto** does not declare a native omp mode. A thread stored with **Auto** runs in
  **Supervised** on the omp driver; omp's automatic review is not used.

omp remembers session-level approvals ("approve for this session") inside its process, so they
expire when T3 Code recycles the omp process and never leak across threads. There is no
cross-session **Always** approval; persistent limits belong in omp's own configuration.

Switching a thread's permission mode takes effect the next time the omp process is used: T3 Code
restarts omp with the new `--approval-mode` while the thread is idle (a switch requested during a
turn applies after it ends). The restart reuses the same session, so the conversation carries
over. See [permission modes](./permission-modes.md) for the full comparison.

## Known Limits

- **Large frames**: omp's RPC transport caps a single frame at 1 MiB. Attaching many or large
  images can exceed the limit; the turn then fails with the measured size and asks you to
  compress or attach fewer images. Nothing is truncated or dropped silently.
- **No cross-session approvals**: as above, remembered approvals live only inside the running omp
  process.
- **No rollback or fork**: omp threads cannot be rolled back or forked in T3 Code yet.
- **Steering**: messages sent mid-turn join the running omp turn. Background agent work wakes the
  thread as new turns, so turn boundaries can look finer-grained than on other providers.
