# cleanskill

[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![node ≥ 18](https://img.shields.io/badge/node-%E2%89%A5%2018-blue)](https://nodejs.org)
![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
![runs inside Orca](https://img.shields.io/badge/runs%20inside-Orca-black)

**Agent skills for Orca memory hygiene — see which sessions are eating your RAM, warn them, then close or trim them.**

Each Devin CLI session starts around **2.8 GB** and only grows. Run a handful of agents and the box is out of memory. `clean` gives any agent running inside Orca the tools to fix that itself — list every live session with its real memory footprint, warn it politely, give it time to save its work, then close it. Long chats get `trim`: archive the full transcript to disk, then send the agent's native `/compact` so context shrinks without losing the transcript.

## What it does

| Verb | What it does |
|---|---|
| `list` | Every live Orca session — terminals, chat agents, workers — with per-session RAM, own project first |
| `peek` | Show what a session's terminal is currently displaying |
| `warn` | Send "you're about to be closed" — reads and reports the reply |
| `close` | Warn → wait a grace period → close. Devin sessions get **parked**: the agent exits (RAM freed), the terminal stays with `devin --resume <id>` pre-typed, so Enter brings it back. Refuses to close *you* |
| `trim` | Archive the transcript to `.clean-archive/`, then send `/compact` |

```console
$ node clean.mjs list
host: 8.30GB used / 17.09GB total (49%), free 8.78GB
orca app: 1.01GB

* cleanskill/Continue  [working] terms=1  workspace-mem 1.01GB
      1.01GB  pty,devin,working,SELF     live     term_ffe483cc-…
             preview: ⠀⢰Guide Devin while it works
* cleanskill/master  [inactive] terms=0
--- other projects ---
  cadence-windows/orch  [active] terms=1  workspace-mem 1.69GB
      1.69GB  pty,devin                  3m idle  term_0080dae9-…
             preview: ─Context: 144k / 262k tokens (54%)─

close:  clean.mjs close <handle>   trim:  clean.mjs trim <handle>
```

## Install

```bash
git clone https://github.com/Toom68/cleanskill.git
cd cleanskill
node install.mjs    # → ~/.agents/skills/clean  (+ ~/.claude/skills/clean)
```

Then any agent can run it — or you can run the helper directly:

```bash
node skills/clean/scripts/clean.mjs list
node skills/clean/scripts/clean.mjs close term_abc123 --grace 60
node skills/clean/scripts/clean.mjs trim term_abc123 --session tall-nation
```

Node 18+, zero dependencies. The skill is just a `SKILL.md` + one `clean.mjs` script over ordinary `orca` CLI commands, so it works from **Devin CLI, Claude Code, Codex, Copilot** — anything Orca can run. Requires a running Orca.

## The part that makes it safe

- **Warn-first, always.** `close` messages the session, polls its screen during the grace window, and shows you the reply before terminating anything.
- **Self-preservation.** It knows which session is *itself* and refuses to close or trim it — including refusing to bulk-close a workspace you're inside.
- **Archive before compaction.** `trim` never compacts until the transcript is on disk. For Devin it exports the real `message_nodes` history out of `sessions.db` (verified: 723 messages → 1.3 MB markdown, resumable via `devin --resume <id>`); other agents get paged scrollback captures.
- **Everything is dry-runnable** (`--dry-run`) and stale Orca handles are detected and re-listed instead of retried blindly.

## Why Devin eats so much RAM — and the actual levers

Measured findings live in [`skills/clean/references/devin-memory.md`](skills/clean/references/devin-memory.md). Short version: each session is a `devin.exe` TUI + a `devin.exe acp` child holding the full conversation in memory, plus every MCP server and subprocess in its tree. The fixes that actually work:

1. **close + `devin --resume`** — the only lever that hands RAM back immediately; the 2 GB `sessions.db` persists everything to disk
2. **`trim`** — archive + `/compact`: shrinks context and slows re-growth, but the process heap isn't returned eagerly (measured: flat RSS right after a 152k→compacted run)
3. **`devin --cloud`** — relays ACP to Devin Cloud; the context and its memory leave your box entirely

## Repo layout

```
skills/clean/SKILL.md        the skill — what agents read
skills/clean/scripts/        clean.mjs — the 5-verb helper (node 18+, no deps)
skills/clean/references/
    protocol.md              the list/peek/warn/close/trim contract + raw orca commands
    devin-memory.md          the RAM investigation: 2.8 GB anatomy, disk story, cloud
install.mjs                  copies the skill into shared agent-skill dirs
AGENTS.md                    dev loop, verification, hard-won Orca/Devin facts
```

## Portability

Orca is the only backend today, but the skill is written as a **5-verb contract** (`list / peek / warn / close / trim` over three address types: PTY handle, mailbox, workspace). A second delegation platform only needs to reimplement those five verbs — see [`protocol.md`](skills/clean/references/protocol.md).

## License

MIT
