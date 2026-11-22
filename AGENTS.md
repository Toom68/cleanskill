# AGENTS.md — cleanskill

Repo of Orca agent skills. Currently holds one skill: **`clean`** — lists live
Orca sessions with per-session RAM, warns/closes idle ones, trims long chats
by archiving context to disk + native `/compact`.

## Layout

```
skills/<name>/SKILL.md        agent-facing doc — frontmatter: name + description (>– folded,
                             description is the discovery trigger, word it for user phrases)
skills/<name>/scripts/        helper CLIs — node 18+, stdlib only, no deps
skills/<name>/references/     deeper docs loaded on demand
install.mjs                   copies skills/* → ~/.agents/skills + ~/.claude/skills
```

## Dev loop

```bash
# edit in worktree, then:
node install.mjs                                    # reinstall to skill dirs
node --check skills/clean/scripts/clean.mjs        # syntax check
node skills/clean/scripts/clean.mjs list           # read-only smoke test
node skills/clean/scripts/clean.mjs close <t> --dry-run   # safe action test
```

Commit on the worktree's `Toom68/*` branch; remote is
`github.com/Toom68/cleanskill` (`origin`).

## Verification

`list`, `peek`, `warn`, `close --dry-run`, `trim --dry-run` are all safe.
`trim --dry-run` still writes the archive file (to `.clean-archive/`,
gitignored) — that IS the feature. Real `close`/`trim` on a live session has
not been run yet — needs a sacrificial session.

## Orca + devin facts that bite (learned the hard way)

- **Handles are runtime-scoped.** `terminal_handle_stale` = Orca restarted;
  re-`list`, never reuse. Env `ORCA_TERMINAL_HANDLE`/`ORCA_PANE_KEY`/
  `ORCA_WORKTREE_ID` identify your own session — guard them.
- **`orca diagnostics memory --json`** is the per-session memory source
  (same sweep as the app's Resource Usage popover). It reports only live
  managed terminals; `sessionId` = `terminal list`'s `ptyId`; `pid` is the
  PTY-root shell and `memory`/`privateMemory` are whole-tree aggregates.
- `terminal read --screen` → `result.terminal.tail` = array of visible lines;
  non-screen reads page backwards via `oldestCursor`.
- **Dispatch flags:** `worker-stop`/`worker-release` take `--dispatch`, NOT
  `--dispatch-id`. Settled workers (succeeded/failed/abandoned) get `release`;
  live ones get `stop`.
- `orca chat` only has `rename` — chat sessions have no PTY handle and no hard
  CLI close (only `worktree rm`). They take `orca_session_id:<id>` mailboxes.
- `orchestration send --to <mailbox>` needs `--subject` + `--type question`.
- **devin:** session = `devin.exe` TUI + `devin.exe acp` child (~300MB–2.8GB,
  grows with context). Transcripts live in `%APPDATA%\devin\cli\sessions.db`
  (SQLite WAL, `message_nodes.chat_message` = JSON role/content/tool_calls;
  `sessions.working_directory` matches worktree path; ids like `tide-spatula`,
  resumable via `devin --resume <id>`). Native cmds: `/compact`, `/clear`,
  `/handoff`, `/summarize`. `devin --cloud` offloads the agent backend to
  Devin Cloud. `devin skills paths` shows skill dirs.
- **Machine:** Windows, Git Bash, ~16GB RAM often tight — prefer `--json`,
  small commands, and don't fork-bomb. For PowerShell commands use a
  PowerShell shell (Git Bash mangles `$_`). `sqlite3` CLI absent — use
  python's sqlite3 module. `devin list` can hang (TUI lock) — don't rely on it.
- Lone surrogates in transcripts can crash python `print` — always
  `sys.stdout.reconfigure(encoding='utf-8', errors='replace')`.

## Conventions

- No npm/package.json — the repo is plain files; keep it that way.
- Cross-agent portability matters: isolate platform specifics behind the
  5-verb contract (`references/protocol.md`), so other delegation platforms
  can adopt later.
