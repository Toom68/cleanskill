# Devin CLI memory — findings (measured on this machine, 2026-11-22)

## Where the RAM goes

Each local devin session inside Orca = **two processes**:

```
powershell.exe (PTY root)          ← orca session pid, what diagnostics counts
└─ devin.exe  (--resume <name> | --model … )   TUI/repl
   └─ devin.exe  acp                          Agent Client Protocol worker
```

Measured: ~8 live session-pairs ≈ **2.7 GB total**; individual sessions ranged
265–540 MB and **grow with context length** (this session: 1.89 GB at
121k/262k tokens; >2 GB late in long runs — matching the "~2.8 GB" observation,
which also counts node/MCP children, subprocess trees and peak subagents).

Why it grows:

- the `acp` child holds the whole conversation + tool results in process RAM;
- every exec subagent, MCP server and tool process counts toward the session's
  tree (Orca measures the PTY-root subtree);
- the persisted side is huge too: `sessions.db` ≈ **2.08 GB**, 206 sessions,
  121k `message_nodes`, 28k `tool_call_state` rows — transcripts are already
  on disk, but the live copy is the RAM you pay for.

## What actually reduces it

| lever | effect | cost |
|-------|--------|------|
| `devin cloud` / `devin --cloud` | **best lever** — REPL stays local but `acp` relays to Devin Cloud: the context/exec/memory move off-box; local cost ≈ a thin client. Works inside an Orca terminal today; `devin ssh`/`forward` reach the cloud box | uses Devin Cloud compute/ACUs |
| `/compact` (in-session) | shrinks live context → the acp process sheds the summarized tail | quality hit on edge cases; archive first (`trim` does this) |
| close + `devin --resume <id>` | kills the process; session reloads from `sessions.db` on resume — full history survives, RAM returns to baseline | cold restart; resume re-loads context so long sessions re-inflate |
| `devin rm <id>` | deletes a session row entirely | only for sessions you never want back |
| fewer parallel sessions | linear | obvious |

Not real levers: the 2 GB `sessions.db` is **disk**, not RAM — shrinking it
doesn't lower memory. Windows "Working Set" can also under-report; Orca's
diagnostics reports both `memory` (working set) and `privateMemory` (commit) —
trust privateMemory for the "real" number.

## Disk-backed context — already mostly true

- Full transcript: `sessions.db` (`message_nodes.chat_message` JSON per node).
- Human-readable history: `%APPDATA%\devin\cli\summaries\history_*.md`.
- `devin --export [path]` streams the conversation to a file each turn.
- `clean.mjs trim` exports a session's nodes to `.clean-archive/*.md` — that
  file is then grep-able by any later session. This is the practical "move
  chat to disk" today: the *recall* is disk, the *live context* is compacted.

A true "run the chat on disk" mode (context paged to disk instead of RAM)
would need changes inside devin itself — there is no such flag as of
v3000.11.92. `--cloud` is the supported way to move the working set off-box.

## For more simultaneous agents

1. New work → launch devin sessions `--cloud` where local RAM is the limit.
2. Idle locals → `clean close` (warn → grace → close; `--resume` brings them
   back cheap).
3. Heavy locals that must stay → `clean trim` (`/compact` + disk archive).
4. Long-running devin sessions → restart them periodically; resume is cheap
   and the transcript survives.
