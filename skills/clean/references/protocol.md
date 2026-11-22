# clean protocol — the 5-verb contract

Everything `clean.mjs` does reduces to five verbs over three address types.
Any platform that can honor these semantics can host the same skill.

| Verb  | Input                  | Contract |
|-------|------------------------|----------|
| list  | —                      | every live session: address, agent type, state, memory (working set + private bytes), idle time, liveness hint, own-project flag |
| peek  | pty handle             | the session's current visible screen, as text |
| warn  | pty handle or mailbox  | deliver "about to be closed" text the agent can see; report accepted/not |
| close | handle / mailbox / workspace | graceful end: PTY kill, worker stop, or workspace bulk close — after warn+grace unless `--no-warn` |
| trim  | handle or mailbox      | archive full context to disk, then ask the agent to compact |

Address types:

- **pty handle** — `term_<uuid>` from `terminal list`. Runtime-scoped: after an
  Orca restart they are replaced (`terminal_handle_stale`); always re-`list`.
- **mailbox** — `orca_session_id:<id>` for structured/chat agents,
  `dispatch:<id>` for supervised workers. Reached via `orchestration send`.
- **workspace** — `id:<repoId>::<path>` or `identity:<key>` from
  `worktree ps`. Closes everything it owns.

## The Orca commands behind each verb

```text
list    orca worktree ps --json                        # workspaces + agents[]
        orca terminal list --worktree <sel> --json     # per live workspace
        orca diagnostics memory --json                 # pid + memory per pty
        orca orchestration worker-list --json          # dispatches (optional)
peek    orca terminal read --terminal <h> --screen --json
        #   → result.terminal.tail = visible lines
warn    orca terminal send --terminal <h> --text "…" --enter [--wait-submit 10]
        orca orchestration send --to <mailbox> --subject "…" --type question
close   orca terminal close --terminal <h> [--tab]
        orca terminal close --worktree <sel> --all     # durable, whole workspace
        orca orchestration worker-stop --dispatch-id <id>
        orca worktree rm --worktree <sel> [--force]    # only when user asked
trim    archive: sessions.db dump (devin) | scrollback page-read (others)
        compact: terminal send "<native /compact>" --enter
```

Joins that make the inventory work:

- `terminal list` row → `ptyId` = `diagnostics memory` `sessions[].sessionId`
  → gives `pid`, `memory`, `privateMemory` (whole process-tree aggregate; the
  pid is the PTY root shell, not the agent itself).
- `worktree ps` `agents[].paneKey` = `<tabId>:<leafId>` → matches a terminal
  row's `tabId`+`leafId` → fills `state`, `orcaSessionId`, `conversationName`.
- `worker-list` `workspace` = `worktreeId`; `terminal` = handle for the join.

## Session states worth knowing

- `terminalVerdict`/`status` on `worktree ps`: `live` terminals attached.
- `agents[].state`: `working` (a turn in flight — never close without strong
  reason), `done`/`idle` (finished a turn — the normal close candidate).
- `programStatus` mirrors the agent's own activity hook when present.
- `liveness` on dispatches: `live`, `unverifiable`, `exited`. `unverifiable`
  + `terminalState: retained` means the PTY record survived a runtime restart
  but the process may be gone — treat as `dead` (close is just cleanup).

## Grace-period semantics

`close` default `--grace 60`. During it, the script polls `terminal read
--screen` on PTY targets every ~5s and emits each changed tail to the caller —
that is the session "replying". Two outcomes:

- reply says "wait/saving/READY" → honor it; `peek` again, extend if needed.
- silence → the agent is idle or can't see input; proceed at deadline.

Mailboxes can't be polled the same way (their replies land in *their* inbox —
`orchestration inbox` shows the *caller's* mail). Grace is time-based only for
chat sessions; check `peek` equivalents by opening the chat tab if it matters.

## Per-agent notes

| agent   | compact cmd | session persistence | close notes |
|---------|-------------|--------------------|-------------|
| devin   | `/compact`  | sqlite `sessions.db` + `summaries/history_*.md`; resume via `devin --resume <id>` | full transcript archivable offline |
| claude  | `/compact`  | `~/.claude/projects/<dir>/…jsonl`; `--resume` | scrollback archive |
| codex   | `/compact`  | `~/.codex/sessions`; `codex resume` | untested here (quota) — same path in theory |
| copilot | `/compact`  | varies | same path in theory |
| other   | checkpoint prompt to `.clean-checkpoint.md` | — | — |

## Edge cases

- **Stale handle** → `terminal_handle_stale`: re-`list`, use the replacement;
  `close` already retries once automatically via ptyId.
- **Ambiguous selector** → orca errors list candidate selectors; copy one.
- **`runtime_unavailable`** → Orca busy/restarting; wait seconds and retry.
- **`agent_prompt_blocked`** → a permission/trust menu is up in that terminal;
  the warning text can't be submitted. `peek` to see it; the agent is asking
  its user something — closing it is the user's call.
- **Bulk close partial failure** → reported as `unverifiable`; do NOT claim
  processes exited. Re-`list` and inspect.
- **Handles ≠ PIDs.** Memory maps via `ptyId`, never by guessing process names.
- **`--environment <id>`** required for paired-server targets; `local` pins to
  this machine even when `ORCA_ENVIRONMENT` is set. `clean.mjs` does not set
  it — export `ORCA_ENVIRONMENT` or run the raw commands yourself.
