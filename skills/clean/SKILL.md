---
name: clean
description: >-
  List live Orca agent sessions with their RAM usage, then warn and close idle
  ones to free memory. Use when the user says "clean", "clean up sessions",
  "free memory/RAM", "which agents are running", "close idle agents/sessions",
  "that session is eating memory", or "trim/compact this chat". Shows every
  worktree's terminals, chat agents and workers sorted by memory, own project
  first; sends an "about to be closed" warning, reads the reply, waits a grace
  period, then closes. `trim` archives a long chat's context to disk (devin
  sessions.db export or scrollback) then sends the agent's native /compact so
  RAM drops without losing the transcript. Works for any agent CLI Orca can run
  (devin, claude, codex, copilot, ...); Orca is the only backend today, the
  protocol is written so other delegation platforms can adopt it.
---

# clean — Orca session memory manager

Presents the calling agent with every live session running in Orca (terminals,
chat agents, supervised workers), how much RAM each holds, and lets that agent
warn a session, wait for its reply, then close or trim it.

Requires the `orca` CLI (v1.4+) and a running Orca. Works from any agent —
devin cli, claude code, codex, copilot — because all of it is ordinary `orca`
commands plus one Node helper script.

## Resolve the helper

```text
node <skill-dir>/scripts/clean.mjs <command> [options]
```

`<skill-dir>` is the directory this SKILL.md lives in. Node 18+ required (any
agent box has it). If `node` is missing, every step below also has a raw `orca`
equivalent in `references/protocol.md` — run those instead. All orca calls take
`--json`; pass `--environment <id>` on `clean.mjs` via `--orca` overrides / the
env var `ORCA_CLI_COMMAND` when targeting a paired server (handles are
server-scoped).

## Commands

```text
node scripts/clean.mjs list [--all] [--json]   # sessions + memory; own repo first
node scripts/clean.mjs peek <handle>           # what the terminal currently shows
node scripts/clean.mjs warn <target>           # send the warning only
node scripts/clean.mjs close <target>          # warn → grace → close
      [--grace <sec>] [--message <m>] [--no-warn] [--tab] [--dry-run]
node scripts/clean.mjs trim <target>           # archive context + send /compact
      [--archive <dir>] [--then-close] [--force] [--dry-run]
node scripts/clean.mjs self                    # your own session identity
```

`<target>` is any of: a `term_…` handle, a `ptyId` suffix,
`orca_session_id:…` / `dispatch:<id>` mailbox, a dispatch id, or a worktree
selector (`id:`, `identity:`, `name:`, `path:`) to address a whole workspace.
`list` prints the exact id to use per row.

## The clean workflow — follow it in order

1. **Measure.** `clean.mjs list` shows host RAM, the Orca app footprint, each
   worktree's total, and per-session memory (`pty,devin,working` etc.). Rows
   marked `SELF` are you. Finished/detached rows are collapsed; `--all` shows
   them. If nothing exceeds your threshold, stop — do not close for the sake
   of it.

2. **Confirm candidates with the user.** Report the list as a table
   (workspace, agent, state, memory, idle time, last preview). Let the user
   pick what goes, unless they already said "close idle ones above X MB" or
   similar. Prefer `dead`/`done` sessions and shells over `working` ones.

3. **Warn first — always.** `clean.mjs close <target> --grace 60` (default)
   sends each target "you're about to be closed… reply if you need time",
   then polls PTY targets and prints any reply it catches during the grace
   window. Use `--message` to override. For chat/mailbox sessions the warning
   goes to their mailbox (`orchestration send --type question`); they may not
   be watching — that is why the grace period exists. Only pass `--no-warn`
   when the session is already dead or the user demanded immediacy.

4. **Read the reply.** During the grace window `close` prints each changed
   screen tail. If a session replies that it is saving work, wait — run
   `clean.mjs peek <handle>` again before closing; give it the time it asks
   for (within reason). A `READY`/silence outcome means proceed.

5. **Close.** After grace, the same command finishes: PTYs via
   `terminal close` (`--tab` for the whole tab), dispatches via
   `worker-stop`, a whole workspace via `terminal close --worktree <sel>
   --all` (durable — removes tabs, layouts and resume records). Chat sessions
   have no PTY handle: the warning is delivered to their mailbox and the only
   hard close is removing the workspace (`orca worktree rm --worktree <sel>`)
   — always ask the user before that.

6. **Verify.** Re-run `clean.mjs list` and report the host freed-memory delta.
   A `terminal_handle_stale` error means the runtime restarted: re-list and
   retry with the fresh handle — never dual-send to an old handle.

## `trim` — shrink a long chat, keep the context

For a session that should keep working but has grown heavy:

1. `clean.mjs trim <handle>` first archives context **to disk**:
   - **devin**: dumps the session's full `message_nodes` transcript from
     `%APPDATA%\devin\cli\sessions.db` (or `$CHISEL_SESSION_DB`) to
     `.clean-archive/devin-<id>-<ts>.md`, matched by `working_directory`.
     The file header notes `devin --resume <id>` for later recall.
   - **other agents**: pages the terminal scrollback to a `.log` file.
2. Then it sends the agent's native compaction command — `/compact` for
   devin/claude/codex/copilot/opencode/pi/grok — or, for unknown agents, a
   checkpoint instruction asking it to write `.clean-checkpoint.md` (goal,
   decisions, open work, key paths) so the essentials survive in-context.
3. It re-measures after ~15s and reports memory before/after. A full /compact
   can take minutes; re-run `list` later for the true delta. `--then-close`
   appends the close hint for after the compaction lands.

If archiving fails or is skipped for a session whose native compact command
would run, `trim` refuses — compacting with nothing on disk defeats the
purpose. Pass `--force` to compact anyway, or point `--archive` somewhere
writable. Checkpoint prompts sent to unknown agents and mailbox sessions are
non-destructive and still go through.

The archive is the point: the trimmed transcript stays on disk where any
agent can grep it later — quality preserved, RAM reclaimed.

## Safety rules — non-negotiable

- **Never act on SELF.** `clean.mjs self` prints your own handle/paneKey;
  `close`/`trim`/`warn` refuse it, and bulk workspace close is refused when the
  workspace contains your session.
- **Own project first, others only when asked.** `list` ranks your repo's
  worktrees first. Warn/close/trim on another project's workspace needs an
  explicit user instruction ("close the cadence workers", "clean everywhere")
  — never venture out unprompted, and tell the user the sessions belong to
  other projects.
- **Idle ≠ safe.** A `done`/`idle` state means the agent finished a turn, not
  that its work is saved. The warn-and-wait step exists precisely for that —
  never skip it on a session that could hold unsaved state.
- **Dead targets are free, not urgent.** `dead`/`detached` rows hold no agent
  process; closing them only frees the tab/layout. Use `--no-warn` for them.
- **Don't double-close.** After any close error, re-`list` before retrying;
  handles are runtime-scoped and change on restart.
- **Other projects are running.** This machine is memory-constrained — run
  `list`, report honestly, and let the user decide anything ambiguous.

## Portability

Everything above is expressed as a 5-verb contract — `list / peek / warn /
close / trim` — over three address types (pty handle, mailbox, workspace).
`clean.mjs` isolates all Orca specifics behind that contract; a second
platform only needs to reimplement those verbs (see
`references/protocol.md` for the semantics each verb must preserve and the
raw `orca` commands behind each).

## Reference docs

- `references/protocol.md` — the warn→wait→close contract, mailbox/dispatch
  addressing, per-agent notes, raw orca command equivalents, edge cases.
- `references/devin-memory.md` — why devin sessions reach ~2.8GB, what
  `--cloud` buys you, and how the disk-backed context story works today.
