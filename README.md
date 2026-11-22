# cleanskill

Agent skills for Orca memory hygiene.

## `clean` — list, warn, close, trim

Presents whatever agent runs it with every live session in Orca (terminals,
chat agents, workers) plus per-session RAM, then lets the agent warn → wait →
close idle sessions, or `trim` a heavy chat (archive context to disk + native
`/compact`). Works from devin cli, claude code, codex, copilot — anything
inside Orca.

```
skills/clean/SKILL.md      the skill (agents read this)
skills/clean/scripts/      clean.mjs — the 5-verb helper (node 18+, no deps)
skills/clean/references/   protocol contract + devin RAM findings
```

### Install

```bash
node install.mjs          # copies to ~/.agents/skills/clean (+ ~/.claude/skills/clean)
```

### Quick look

```bash
node skills/clean/scripts/clean.mjs list
node skills/clean/scripts/clean.mjs close term_abc123 --grace 60
node skills/clean/scripts/clean.mjs trim term_abc123
```
