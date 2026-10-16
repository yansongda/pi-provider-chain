English | [简体中文](README.zh-CN.md)

# pi-provider-chain

An extension for [Pi](https://pi.dev): **virtual models + automatic fallback when quota runs out**.

It registers a virtual model for every configured entry (mounted under the `yansongda` provider by default, e.g. `yansongda/deepseek-v4.1-flash`) and routes requests to `chain[0]`; as soon as a **quota / subscription / overdue**-class error appears, it advances along `chain[1..]` and writes the degraded state into a shared state file, so it takes effect **across sessions, across processes, and across parent/child subagents**.

## Features

- **Only quota-class errors trigger fallback**: transient 429 rate limits, 5xx, and network errors are left alone and handed back to Pi's own retry.
- **Two trigger paths**: the `retry` fast path (retryable errors); the `agent_before_settle` backstop (non-retryable errors — the failed message is dropped and the run continues once).
- **Cache-friendly**: `retry` stays on the same level, `continuation` reuses the previous physical model, so the prompt cache / thinking signature is invalidated as rarely as possible.
- **Explainable**: a notify message, plus a footer that **permanently shows the current target physical model** (while degraded it appends the backup target and recovery time), plus a visible transcript entry (prefix `[chain]`, **never sent to the model context**).
- **Automatic recovery**: the degradation window is parsed from the `reset at ...` in the error, falling back to a default duration; once the window expires, the first successful primary request reports recovery.
- **Zero runtime dependencies**: only the host packages Pi provides (as peers), no transitive dependencies.

## Installation

```bash
# Install from npm
pi install npm:pi-provider-chain

# Local path (for development; changes need no reinstall)
pi install /Users/yansongda/000-Coding/pi-provider-chain
pi list
```

After installing, configure `~/.pi/agent/provider-chain.json` (or `$PI_CODING_AGENT_DIR/provider-chain.json`); a complete example lives in [`examples/provider-chain.json`](examples/provider-chain.json) and field descriptions in [`examples/README.md`](examples/README.md). Run `/reload` or start a new session for changes to take effect.

## Configuration

The minimal working config (you only have to declare one primary model; see the example file for every optional field):

```json
{
  "virtualProvider": "yansongda",
  "models": [
    {
      "id": "deepseek-v4.1-flash",
      "name": "DeepSeek V4.1 Flash · auto",
      "chain": ["volcengine/deepseek-v4.1-flash", "workbuddy/deepseek-v4.1-flash"]
    }
  ]
}
```

| Field | Required | Default | Description |
| --- | --- | --- | --- |
| `virtualProvider` | ✅ | - | Provider id the virtual models are mounted under (you may reuse an existing provider, or use a brand-new id) |
| `models[].id` | ✅ | - | Virtual model id; must not be identical to a physical model id under `virtualProvider`; duplicates within one config raise an error |
| `models[].name` | - | `models[].id` | Name shown in the `/model` list (ignored when not a string) |
| `models[].thinkingLevels` | - | all levels | Thinking levels available for selection (non-array, or empty after filtering, falls back to all levels) |
| `models[].input` | - | host default (text + image) | Input kinds this virtual model accepts; only `text` / `image` are valid (other values are dropped, duplicates removed); when omitted the field is not sent |
| `models[].contextWindow` / `maxTokens` | - | not declared | Limits shown before the first response (ignored when not a positive number) |
| `models[].chain[]` | ✅ | - | The chain: `chain[0]` is the primary, everything after it is an ordered backup (`provider/id`); an invalid `chain[0]` raises an error, later invalid entries are silently ignored; **a total chain length ≤ 5 is recommended** (the common gateway cap — an over-long chain makes one failure pay the failure cost on provider after provider) |
| `degradePatterns[]` | - | 14 built-ins | Keywords that trigger a fallback on match (case-insensitive; a non-empty list **fully overrides** the defaults, an empty/all-whitespace list falls back to the built-in defaults) |
| `resetPattern` | - | built-in regex | Regex that parses the recovery time out of the error text (capture group 1/2 is date/time, optional group 3 is the timezone) |
| `defaultDegradeMs` | - | `3600000` (1h) | Fallback duration when no recovery time can be parsed (clamped when it exceeds `maxDegradeMs`) |
| `maxDegradeMs` | - | `2592000000` (30d) | **Hard cap** on the fallback duration; clamps the parsed reset time, `defaultDegradeMs`, and a manual `/chain degrade <duration>` |
| `transcriptNotice` | - | `true` | Whether to append a visible entry to the transcript (does not affect the model context) |
| `stateFile` | - | `~/.pi/agent/provider-chain-state.json` | State file path (supports `~`) |

Built-in default `degradePatterns`: `AccountQuotaExceeded`, `QuotaExceeded`, `AgentPlanQuotaExceeded`, `SetLimitExceeded`, `InvalidSubscription`, `subscription has expired`, `AccountOverdueError`, `ServiceOverdue`, `overdue balance`, `usage quota`, `exceeded the quota`, `insufficient_quota`, `out of budget`, `billing`.

> Plain words/phrases automatically get word boundaries (`\bbilling\b`) to reduce false positives; entries containing `_`, digits, or camelCase are matched verbatim.

## Commands

| Command | Description |
| --- | --- |
| `/chain` or `/chain status` | Currently selected model, config and state file paths, and every virtual model's chain and degradation state (subcommands are completed) |
| `/chain degrade [duration]` | Manually fall back to the first backup (`30m` / `2h` / `1d`; defaults to `defaultDegradeMs`, capped by `maxDegradeMs`) |
| `/chain reset` | Clear the degradation state of the provider the current model belongs to (aliases `primary` / `clear`) |
| `/chain reload` | Reload the extension and config (equivalent to `/reload`) |

## State file

`~/.pi/agent/provider-chain-state.json` by default:

```json
{
  "version": 1,
  "degraded": {
    "volcengine": { "level": 1, "until": 1793203199000, "reason": "AccountQuotaExceeded", "at": 1792055998922 }
  }
}
```

- The key is the **provider of `chain[0]`** (all virtual models under one provider share the level).
- Writes use `tmp + rename` atomic replacement; concurrent writes are merged monotonically ("for the same key keep the larger level"), so a parent and a child process never push the level back on each other.
- There is no file lock between read and write: if two processes degrade **different** providers **at the same moment**, a record can theoretically be lost; the provider's next request will degrade again, so it self-heals.
- Every write prunes historical entries older than `until + 24h`.
- After recovery a tombstone entry with `level: 0, reason: "recovered"` is written: it makes the "recovered" notice appear exactly once, and under concurrency it never overwrites an active degradation another process just wrote (the monotonic merge keeps the deeper level).
- When the write fails, the fallback still applies in this process, and a message states that "the state file write failed, so this fallback only applies to the current process".

## How it works

```
Selected yansongda/deepseek-v4.1-flash (virtual model)
        │  route(request, ctx)
        ▼
read state file → level (0 = primary, 1..n = backup chain index; an expired window falls back to 0 automatically)
        │
        ├─ retry, and the error text matches degradePatterns → advance the level and write state (fast path)
        ├─ retry / continuation, and it failed or the previous model is the current level → reuse it (cache-friendly)
        ├─ otherwise walk forward from the current level for a model with credentials, then fall back backwards
        ▼
return the physical model + thinking level (the assistant message records the physical model)
```

Non-retryable quota errors (such as a 403 subscription expiry) go through the `agent_before_settle` backstop: on a match it writes the degraded state first, then drops that failed message and continues the run once; if the entry holding the failed message cannot be located (so it cannot be dropped), the state is still written so the next request goes to a backup.

The footer permanently shows the target physical model of the **currently selected model** (`⬇ volcengine/…` while healthy; `⚠ 备用 workbuddy/… · 恢复 10-28 23:59` while degraded) — degradation info for other models is listed in full by `/chain status`. Transcript entries are prefixed with `[chain]` and come in three visible kinds: degraded (`kind: "degrade"`, with the limited provider `from`, the `reason`, and the trigger path `trigger`; the same sentence as the notify message), recovered (`kind: "recover"`), and routing error (`kind: "error"`, which falls back to the primary but leaves the exception in the transcript for troubleshooting).

## Development

```bash
bun install       # install devDeps / peers
bun run test      # bun test: run every node:test case under tests/
bun run typecheck # tsc --noEmit
bun run pack      # bun pm pack --dry-run, inspect the published contents

# The same suite also runs straight from TS on Node ≥ 22.18 (no test framework); CI guards this promise on Node 24
bun run test:node # equivalent to node --test "tests/**/*.test.ts"
```

```
extensions/provider-chain.ts      Wiring layer (registers virtual models / events / commands / renderers + ctx→ports adapter)
src/constants.ts                  Machine constants + user-facing message templates (leaf module, zero deps)
src/model-ref.ts                  provider/id parsing
src/degrade.ts                    Degradation decision and time parsing (pure functions)
src/state.ts                      State file read/write (atomic write / monotonic merge / pruning)
src/config.ts                     Config loading and validation
src/route-policy.ts               Routing decision (pure functions)
src/router.ts                     Degradation state machine and decisions (ports injected, unit-testable)
src/transcript.ts                 Transcript entry contract and session traversal (pure functions)
src/command.ts                    /chain argument parsing (pure functions)
src/ui.ts                         User-facing message assembly (notify / footer / transcript entries / command output)
examples/                         Copy-pasteable config example + field descriptions
tests/                            node:test unit tests (incl. an assembly integration test with a stubbed pi)
docs/                             Design documents
```

## License

MIT
