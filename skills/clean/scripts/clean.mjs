#!/usr/bin/env node
// clean — session memory manager for Orca agents.
// Lists live sessions with per-session memory, warns them, closes them, and
// trims long chats (archive context to disk + native compaction).
//
// Usage: clean.mjs <list|peek|warn|close|trim|self> [options] (see --help).
// Backend adapter: today only "orca". The command vocabulary in SKILL.md is
// platform-neutral so a second adapter can be added without changing the
// agent-facing contract.

import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------- CLI plumbing ----------

const args = process.argv.slice(2);
const cmd = args[0];
const rest = args.slice(1);

const FLAG = (name) => rest.includes(name);
const OPT = (name, dflt) => {
  const i = rest.indexOf(name);
  return i >= 0 && i + 1 < rest.length ? rest[i + 1] : dflt;
};
const POSITIONAL = rest.filter((a, i) => !a.startsWith('-') && (i === 0 || !rest[i - 1].startsWith('-') || rest[i - 1] === '--'));

function fail(msg, code = 2) {
  console.error(`clean: ${msg}`);
  process.exit(code);
}
function emit(obj) {
  console.log(JSON.stringify(obj, null, FLAG('--pretty') ? 1 : 0));
}

// ---------- Orca backend ----------

function resolveOrca() {
  if (process.env.ORCA_CLI_COMMAND) return process.env.ORCA_CLI_COMMAND;
  if (process.env.ORCA_DEV_REPO_ROOT) return 'orca-dev';
  if (process.platform === 'linux' && !process.env.ORCA_TERMINAL_HANDLE && !process.env.ORCA_WORKTREE_ID)
    return 'orca-ide'; // bare `orca` on Linux is the GNOME screen reader
  return 'orca';
}
const ORCA = OPT('--orca', resolveOrca());

function orcaRaw(orcaArgs, timeoutMs = 30000) {
  const r = spawnSync(ORCA, orcaArgs, {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 << 20,
    shell: false,
  });
  return r;
}

function orca(orcaArgs, timeoutMs = 30000) {
  const r = orcaRaw([...orcaArgs, '--json'], timeoutMs);
  const out = (r.stdout || '').trim();
  if (!out) {
    const err = (r.stderr || r.error?.message || 'no output').trim();
    throw new Error(`${ORCA} ${orcaArgs.join(' ')}: ${err.split('\n').slice(-2).join(' ')}`);
  }
  const s = out.indexOf('{');
  const j = JSON.parse(s >= 0 ? out.slice(s) : out);
  if (!j.ok) {
    const e = j.error || {};
    const ex = new Error(`${ORCA} ${orcaArgs.join(' ')}: ${e.code || 'error'}${e.message ? ' — ' + e.message : ''}`);
    ex.orcaError = e;
    throw ex;
  }
  return j.result ?? j;
}

// ---------- Self / identity ----------

const SELF = {
  terminal: process.env.ORCA_TERMINAL_HANDLE || null,       // may be stale after a runtime restart
  paneKey: process.env.ORCA_PANE_KEY || null,               // <tabId>:<leafId>
  worktreeId: process.env.ORCA_WORKTREE_ID || null,         // <repoId>::<path>
  repoId: process.env.ORCA_WORKTREE_ID ? process.env.ORCA_WORKTREE_ID.split('::')[0] : null,
};

// ---------- Inventory ----------

function diagnostics() {
  try {
    return orca(['diagnostics', 'memory'], 45000);
  } catch (e) {
    return { worktrees: [], app: null, host: null, error: String(e.message || e) };
  }
}

function inventory({ allProjects = false } = {}) {
  const ps = orca(['worktree', 'ps', '--limit', '10000']);
  const diag = diagnostics();
  const workers = (() => {
    try { return orca(['orchestration', 'worker-list']).workers || []; }
    catch { return []; }
  })();

  const memBySessionId = new Map();   // ptyId -> {pid, memory, privateMemory, cpu}
  const memByWorktree = new Map();    // worktreeId -> {memory, privateMemory}
  for (const w of diag.worktrees || []) {
    memByWorktree.set(w.worktreeId, { memory: w.memory, privateMemory: w.privateMemory });
    for (const s of w.sessions || []) memBySessionId.set(s.sessionId, s);
  }

  const rows = [];
  for (const w of ps.worktrees || []) {
    const wt = {
      worktreeId: w.worktreeId,
      repo: w.repo,
      name: w.displayName || w.path.split(/[\\/]/).pop(),
      path: w.path,
      status: w.status,
      address: w.address?.worktree || `id:${w.worktreeId}`,
      liveTerminals: w.liveTerminalCount || 0,
      verdict: w.terminalVerdict,
      mine: w.repoId === SELF.repoId,
      workspaceMemory: memByWorktree.get(w.worktreeId) || null,
      sessions: [],
    };

    // Agent/PTY terminals in this workspace (only if it has live ones; keeps the sweep cheap)
    if (wt.liveTerminals > 0) {
      try {
        const tl = orca(['terminal', 'list', '--worktree', wt.address]);
        for (const t of tl.terminals || []) {
          const mem = memBySessionId.get(t.ptyId) || null;
          const isSelf =
            (SELF.terminal && t.handle === SELF.terminal) ||
            (SELF.paneKey && `${t.tabId}:${t.leafId}` === SELF.paneKey);
          wt.sessions.push({
            kind: 'pty',
            agent: t.agentIdentity || 'shell',
            handle: t.handle,
            ptyId: t.ptyId,
            paneKey: `${t.tabId}:${t.leafId}`,
            title: t.title,
            connected: t.connected,
            writable: t.writable,
            pid: mem?.pid ?? null,
            memory: mem?.memory ?? null,
            privateMemory: mem?.privateMemory ?? null,
            lastOutputAt: t.lastOutputAt,
            preview: (t.preview || '').replace(/\s+/g, ' ').slice(0, 140),
            self: !!isSelf,
          });
        }
      } catch (e) {
        wt.terminalListError = String(e.message || e);
      }
    }

    // Tracked agents (chats, structured sessions, worker PTYs)
    for (const a of w.agents || []) {
      const existing = wt.sessions.find((s) => s.paneKey === a.paneKey);
      if (existing) {
        existing.sessionId = a.orcaSessionId || existing.sessionId;
        existing.mailbox = a.orcaSessionId ? `orca_session_id:${a.orcaSessionId}` : existing.mailbox;
        existing.state = a.state || a.programStatus?.state || existing.state;
        existing.conversation = a.conversationName || null;
        continue;
      }
      wt.sessions.push({
        kind: a.hasLivePty ? 'pty' : a.paneKey?.startsWith('structured-agent-session-') ? 'chat' : 'agent',
        agent: a.agentType || 'agent',
        handle: null,
        paneKey: a.paneKey,
        sessionId: a.orcaSessionId || null,
        mailbox: a.orcaSessionId ? `orca_session_id:${a.orcaSessionId}` : null,
        state: a.state || a.programStatus?.state || null,
        conversation: a.conversationName || null,
        lastMessage: a.lastAssistantMessage ? String(a.lastAssistantMessage).replace(/\s+/g, ' ').slice(0, 140) : null,
        memory: memBySessionId.get(a.paneKey)?.memory ?? null,
        self: SELF.paneKey ? a.paneKey === SELF.paneKey : false,
      });
    }

    // Supervised dispatches bound to this workspace
    for (const k of workers) {
      if (k.workspace !== w.worktreeId) continue;
      const already = wt.sessions.some((s) => s.handle === k.terminal);
      if (already) { const s = wt.sessions.find((s) => s.handle === k.terminal); s.dispatchId = k.dispatchId; s.taskId = k.taskId; s.kind = 'worker'; s.state = s.state || k.state; s.liveness = k.liveness; continue; }
      wt.sessions.push({
        kind: 'worker',
        agent: 'worker',
        handle: k.terminal || null,
        dispatchId: k.dispatchId,
        taskId: k.taskId,
        mailbox: `dispatch:${k.dispatchId}`,
        state: k.state,
        liveness: k.liveness,
        terminalState: k.terminalState,
        memory: null,
        self: false,
      });
    }

    const DEAD = new Set(['done', 'succeeded', 'failed', 'abandoned', 'exited', 'completed']);
    for (const s of wt.sessions) {
      s.live = s.self ? true
        : (s.memory && s.memory > 0) ? true
        : s.handle ? (s.connected !== false && !DEAD.has(s.state || '')) && s.liveness !== 'exited'
        : s.mailbox ? !DEAD.has(s.state || '')
        : false;
    }

    if (allProjects || wt.mine || wt.liveTerminals > 0 || wt.sessions.some((s) => s.live) || wt.status === 'active' || wt.status === 'working')
      rows.push(wt);
  }
  return { host: diag.host || null, app: diag.app || null, worktrees: rows };
}

function cmdList() {
  const inv = inventory({ allProjects: FLAG('--all') || FLAG('-a') });
  if (FLAG('--json')) return emit(inv);

  if (inv.host) {
    const h = inv.host;
    console.log(
      `host: ${fmtBytes(h.usedMemory)} used / ${fmtBytes(h.totalMemory)} total ` +
      `(${Math.round(h.memoryUsagePercent)}%), free ${fmtBytes(h.freeMemory)}`
    );
  }
  if (inv.app) console.log(`orca app: ${fmtBytes(inv.app.memory)}`);
  console.log('');

  const showAll = FLAG('--all') || FLAG('-a');
  let printedOther = false;
  const groups = [inv.worktrees.filter((w) => w.mine), inv.worktrees.filter((w) => !w.mine)];
  groups.forEach((group, gi) => {
    if (!group.length) return;
    if (gi === 1) { printedOther = true; console.log('--- other projects ---'); }
    for (const w of group) {
      const wm = w.workspaceMemory ? `  workspace-mem ${fmtBytes(w.workspaceMemory.memory)}` : '';
      const live = w.sessions.filter((s) => s.live);
      const dead = w.sessions.length - live.length;
      console.log(`${w.mine ? '*' : ' '} ${w.repo}/${w.name}  [${w.status}] terms=${w.liveTerminals}${wm}`);
      const shown = showAll ? w.sessions : live;
      for (const s of shown.sort((a, b) => (b.memory || 0) - (a.memory || 0))) {
        const mem = s.memory != null ? fmtBytes(s.memory).padStart(8) : '      - ';
        const idle = s.lastOutputAt ? idleStr(Date.now() - s.lastOutputAt) : '';
        const id = s.handle || s.mailbox || s.paneKey || '';
        const flags = [s.kind, s.agent, s.state, s.self ? 'SELF' : '', s.live ? '' : 'dead'].filter(Boolean).join(',');
        console.log(`    ${mem}  ${flags.padEnd(26)} ${idle.padEnd(8)} ${id}`);
        if (s.preview) console.log(`             preview: ${s.preview.slice(0, 110)}`);
      }
      if (!showAll && dead > 0) console.log(`             (+${dead} finished/detached — see --all)`);
    }
  });
  if (!printedOther) console.log('(no other live workspaces — pass --all for the full picture)');
  console.log('\nclose:  clean.mjs close <handle>   trim:  clean.mjs trim <handle>');
}

// ---------- Message / close / trim ----------

function findSession(ref) {
  const inv = inventory({ allProjects: true });
  for (const w of inv.worktrees) {
    for (const s of w.sessions) {
      if (
        s.handle === ref || s.ptyId === ref || s.sessionId === ref ||
        s.mailbox === ref || s.paneKey === ref || s.dispatchId === ref ||
        (s.ptyId && s.ptyId.endsWith(ref)) || (s.paneKey && s.paneKey.endsWith(ref))
      ) return { workspace: w, session: sniffAgent(s) };
    }
    // allow addressing a workspace itself (closes all its terminals)
    if (w.worktreeId === ref || w.path === ref || w.address === ref) { w.sessions.forEach(sniffAgent); return { workspace: w, session: null }; }
  }
  return null;
}

// Orca can lag in tagging an agent started by hand in a plain shell (e.g. a
// parked session the user resumed) — recognise known agent TUIs on screen
const AGENT_SCREEN = { devin: /Ask Devin to build/ };
function sniffAgent(s) {
  if (s.kind !== 'pty' || s.agent !== 'shell' || !s.handle) return s;
  const tail = screenTail(s.handle, 30) || '';
  const last = tail.split('\n').map((l) => l.trimEnd()).filter(Boolean).pop() || '';
  if (SHELL_PROMPT.test(last)) return s;
  const hit = Object.entries(AGENT_SCREEN).find(([, re]) => re.test(tail));
  if (hit) { s.agent = hit[0]; s.agentFrom = 'screen'; }
  return s;
}

function refreshHandle(s, workspaceAddress) {
  // Handles are runtime-scoped; if a handle went stale, re-resolve via ptyId.
  try {
    const tl = orca(['terminal', 'list', '--worktree', workspaceAddress]);
    for (const t of tl.terminals || []) {
      if (t.ptyId === s.ptyId || `${t.tabId}:${t.leafId}` === s.paneKey) {
        s.handle = t.handle; return t.handle;
      }
    }
  } catch {}
  return s.handle;
}

function cmdPeek() {
  const ref = POSITIONAL[0];
  if (!ref) fail('peek needs a terminal handle');
  try {
    const r = orca(['terminal', 'read', '--terminal', ref, '--screen']);
    const t = r.terminal || r;
    const text = Array.isArray(t.tail) ? t.tail.join('\n') : String(t.text ?? t.content ?? JSON.stringify(t, null, 1));
    console.log(text.slice(-12000));
  } catch (e) {
    if (e.orcaError?.code === 'terminal_handle_stale') fail('handle is stale — re-run `clean.mjs list` and use the fresh handle');
    throw e;
  }
}

function sendWarning(s, message, waitSubmit) {
  if (s.handle) {
    const sendArgs = ['terminal', 'send', '--terminal', s.handle, '--text', message, '--enter'];
    if (waitSubmit) sendArgs.push('--wait-submit', String(waitSubmit));
    try { return { via: 'terminal', result: orca(sendArgs) }; }
    catch (e) {
      if (e.orcaError?.code === 'terminal_handle_stale') throw e;
      throw e;
    }
  }
  if (s.mailbox || s.dispatchId) {
    const to = s.mailbox || `dispatch:${s.dispatchId}`;
    return { via: 'mailbox', result: orca(['orchestration', 'send', '--to', to, '--subject', message, '--type', 'question']) };
  }
  throw new Error('no route to session (no handle, no mailbox) — warn manually or close the workspace');
}

function screenTail(handle, lines = 14) {
  try {
    const r = orca(['terminal', 'read', '--terminal', handle, '--screen']);
    const t = r.terminal || r;
    const text = Array.isArray(t.tail) ? t.tail.join('\n') : String(t.text ?? t.content ?? '');
    return text.split('\n').slice(-lines).join('\n');
  } catch { return null; }
}

function cmdWarn() {
  const ref = POSITIONAL[0];
  if (!ref) fail('warn needs a target (handle | ptyId | mailbox | dispatch id | worktree)');
  const message = OPT('--message', OPT('-m', defaultWarn(OPT('--grace', '60'))));
  const found = findSession(ref) || fail(`no session matches "${ref}"`);
  const targets = found.session ? [found.session] : found.workspace.sessions.filter((s) => s.handle || s.mailbox);
  if (!targets.length) fail('nothing reachable in that workspace');
  const results = [];
  for (const s of targets) {
    if (s.self) { results.push({ target: s.handle || s.mailbox, skipped: 'self' }); continue; }
    try { results.push({ target: s.handle || s.mailbox, ...sendWarning(s, message, FLAG('--wait-submit') ? 10 : 0) }); }
    catch (e) { results.push({ target: s.handle || s.mailbox, error: String(e.message || e) }); }
  }
  emit({ sent: results });
}

// agents that can exit and later reload the same conversation from disk:
// park = exit the agent, keep the (cheap) shell, pre-type its resume command
const PARK = {
  // on exit devin prints "devin.exe -r <id>" alone on a line, then
  // "… devin.exe -r lists recent sessions" — anchor so "lists" never matches
  devin: {
    exit: '/exit',
    proc: 'devin',
    resume: (id, flags) => ['devin', flags, '--resume', id].filter(Boolean).join(' '),
    hint: /^\s*devin(?:\.exe)?\s+(?:-r|--resume)\s+([\w-]+)\s*$/gm,
  },
};

// the agent's own command line, read before it exits: carries its resume id
// (when it was resumed) and the launch flags Orca used (permission mode,
// workspace trust) so the pre-typed resume reproduces the same launch
function agentLaunch(rootPid, name) {
  if (!rootPid) return null;
  let rows = [];
  if (process.platform === 'win32') {
    const r = spawnSync('powershell', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process | Where-Object Name -eq '${name}.exe' | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress`], { encoding: 'utf8' });
    try { rows = [].concat(JSON.parse(r.stdout || '[]')).map((p) => ({ ppid: p.ParentProcessId, args: p.CommandLine || '' })); } catch {}
  } else {
    const r = spawnSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' });
    rows = (r.stdout || '').split('\n').map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map((m) => ({ ppid: +m[2], args: m[3] }));
  }
  const p = rows.find((x) => x.ppid === rootPid && x.args.includes(name));
  if (!p) return null;
  const argv = (p.args.match(/"[^"]*"|\S+/g) || []).slice(1);
  let id = null; const flags = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--resume' || argv[i] === '-r') id = argv[++i] || null;
    else if (KEEP_FLAGS.has(argv[i]) && argv[i + 1]) flags.push(argv[i], argv[++i]);
  }
  return { id, flags: flags.join(' ') };
}
// launch flags safe to replay on resume — anything else (e.g. a one-shot
// initial prompt) is dropped so resuming never re-sends work
const KEEP_FLAGS = new Set(['--permission-mode', '--respect-workspace-trust', '--model']);
const SHELL_PROMPT = /(^PS [^>]*>|[$#%>])\s*$/;

function resumeGuess(s, w) {
  if (s.agent !== 'devin') return null;
  const p = devinSessions(w.path);
  if (p.skipped) return null;
  const want = OPT('--session', null);
  return want && p.sessions.some((x) => x.id === want) ? want : p.sessions[0].id;
}

function parkOne(s, w) {
  const spec = PARK[s.agent];
  const launch = agentLaunch(s.pid, spec.proc);
  orca(['terminal', 'send', '--terminal', s.handle, '--text', spec.exit, '--enter']);
  // wait for the agent to hand the PTY back to its shell
  let tail = '', back = false;
  for (const deadline = Date.now() + 30000; Date.now() < deadline;) {
    sleep(2000);
    tail = screenTail(s.handle, 30) || '';
    const last = tail.split('\n').map((l) => l.trimEnd()).filter(Boolean).pop() || '';
    if (SHELL_PROMPT.test(last)) { back = true; break; }
  }
  if (!back) return { target: s.handle, via: 'park', error: `${s.agent} did not exit within 30s — still running; peek it, or close --hard` };
  // the agent's own exit hint beats the db guess (several sessions can share a dir)
  const hinted = [...tail.matchAll(spec.hint)].pop()?.[1];
  const id = hinted || launch?.id || resumeGuess(s, w);
  if (!id) return { target: s.handle, via: 'park', parked: true, resume: null, note: 'agent exited, shell kept; resume id unknown' };
  const resume = spec.resume(id, launch?.flags);
  orca(['terminal', 'send', '--terminal', s.handle, '--text', resume]); // no --enter: one keypress to resume
  return { target: s.handle, via: 'park', parked: true, resume, idFrom: hinted ? 'exit screen' : launch?.id ? 'process command line' : 'sessions.db (newest in dir — verify)' };
}

function closeOne(s, w, opts) {
  if (s.self) return { target: s.handle || s.mailbox, skipped: 'self' };
  if (s.handle && PARK[s.agent] && !opts.hard) return parkOne(s, w);
  if (s.dispatchId) {
    // settled workers get release (frees the retained terminal only);
    // live/unverifiable ones get stop (fences the dispatch + helpers)
    const settled = /succeeded|failed|done|abandoned|completed|exited/i.test(s.state || '') || s.liveness === 'exited';
    const verb = settled ? 'worker-release' : 'worker-stop';
    return { target: s.dispatchId, via: verb, result: orca(['orchestration', verb, '--dispatch', s.dispatchId], 60000) };
  }
  if (s.handle) {
    const a = ['terminal', 'close', '--terminal', s.handle];
    if (opts.tab) a.push('--tab');
    try {
      return { target: s.handle, result: orca(a, 60000) };
    } catch (e) {
      const old = s.handle;
      if (e.orcaError?.code === 'terminal_handle_stale' && refreshHandle(s, w.address) !== old) {
        return closeOne(s, w, opts); // retry once with the fresh handle
      }
      throw e;
    }
  }
  if (s.mailbox) {
    // Chat sessions have no PTY handle to close — the only agent-level route is
    // asking it to finish; the hard close is removing the workspace.
    return { target: s.mailbox, skipped: 'chat session: no hard close — use --worktree <sel> to remove the workspace, or ask it to wrap up' };
  }
  return { target: s.paneKey || '?', skipped: 'no close route' };
}

function cmdClose() {
  const ref = POSITIONAL[0];
  if (!ref) fail('close needs a target (handle | ptyId | mailbox | dispatch id | worktree selector)');
  const grace = parseFloat(OPT('--grace', '60'));
  const noWarn = FLAG('--no-warn');
  const dryRun = FLAG('--dry-run');
  const opts = { tab: FLAG('--tab'), hard: FLAG('--hard') };
  const found = findSession(ref) || fail(`no session matches "${ref}"`);
  const targets = found.session ? [found.session] : found.workspace.sessions.filter((s) => !s.self && (s.handle || s.mailbox || s.dispatchId));
  if (!targets.length) fail('nothing to close there (or it is your own session)');
  const parks = (s) => !!(s.handle && PARK[s.agent] && !opts.hard);

  const plan = targets.map((s) => ({ target: s.handle || s.mailbox || s.dispatchId, kind: s.kind, agent: s.agent, memory: s.memory, state: s.state, mode: parks(s) ? 'park' : 'close' }));
  if (dryRun) return emit({ dryRun: true, wouldClose: plan, graceSeconds: noWarn ? 0 : grace });

  const out = { warned: [], replies: [], closed: [] };

  if (!noWarn) {
    const message = OPT('--message', defaultWarn(String(grace)));
    for (const s of targets) {
      try { out.warned.push({ target: s.handle || s.mailbox, ...sendWarning(s, message, 10) }); }
      catch (e) { out.warned.push({ target: s.handle || s.mailbox, error: String(e.message || e) }); }
    }
    // grace period: poll PTY targets so the caller can see the session's reply
    const deadline = Date.now() + grace * 1000;
    let lastSeen = new Map();
    while (Date.now() < deadline) {
      for (const s of targets) {
        if (!s.handle) continue;
        const tail = screenTail(s.handle);
        if (tail && tail !== lastSeen.get(s.handle)) {
          lastSeen.set(s.handle, tail);
          out.replies.push({ at: new Date().toISOString(), target: s.handle, tail });
        }
      }
      sleep(Math.min(5000, Math.max(500, deadline - Date.now())));
    }
  }

  if (!found.session && found.workspace.liveTerminals > 0 && !targets.some(parks)) {
    if (found.workspace.sessions.some((t) => t.self)) {
      emit({ error: 'target workspace contains your own session — refusing bulk close; close the other terminals individually', workspace: found.workspace.worktreeId });
      process.exit(3);
    }
    // workspace target: one durable bulk close for every terminal it owns
    try {
      out.closed.push({ workspace: found.workspace.address, result: orca(['terminal', 'close', '--worktree', found.workspace.address, '--all'], 120000) });
    } catch (e) {
      out.closed.push({ workspace: found.workspace.address, error: String(e.message || e), note: 'bulk close unverifiable — do not claim processes exited; inspect before retrying' });
    }
    for (const s of targets.filter((t) => t.dispatchId && !t.handle)) {
      try { out.closed.push(closeOne(s, found.workspace, opts)); } catch (e) { out.closed.push({ target: s.dispatchId, error: String(e.message || e) }); }
    }
  } else {
    for (const s of targets) {
      try { out.closed.push(closeOne(s, found.workspace, opts)); }
      catch (e) { out.closed.push({ target: s.handle || s.mailbox || s.dispatchId, error: String(e.message || e) }); }
    }
  }
  emit(out);
}

// ---------- trim ----------

const COMPACT_CMD = {
  devin: '/compact',
  claude: '/compact',
  codex: '/compact',
  copilot: '/compact',
  opencode: '/compact',
  pi: '/compact',
  grok: '/compact',
};

function devinSessions(worktreePath) {
  // Devin CLI keeps the full message forest in a SQLite db — reading it is
  // safe even while the session is live (WAL mode).
  const db = process.env.CHISEL_SESSION_DB ||
    path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'devin', 'cli', 'sessions.db');
  if (!fs.existsSync(db)) return { skipped: `no devin sessions.db at ${db}` };
  const py = ['python', 'python3', 'py'].find((p) => spawnSync(p, ['-V'], { encoding: 'utf8' }).status === 0);
  if (!py) return { skipped: 'python not found — install python3 to archive devin transcripts' };
  const script = `
import sqlite3, json
db = sqlite3.connect(r'''${db}''')
target = r'''${worktreePath.replace(/\\/g, '/')}'''.lower().replace('\\\\', '/')
rows = db.execute("select id, working_directory, model, created_at, last_activity_at, title from sessions").fetchall()
out = []
for sid, wdir, model, c, l, title in rows:
    if not wdir or wdir.lower().replace('\\\\', '/') != target:
        continue
    n = db.execute("select count(*) from message_nodes where session_id=?", [sid]).fetchone()[0]
    out.append({'id': sid, 'dir': wdir, 'model': model, 'title': title, 'created': c, 'last': l, 'messages': n})
print(json.dumps(out))`;
  const r = spawnSync(py, ['-c', script], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) return { skipped: `sqlite probe failed: ${(r.stderr || '').slice(-300)}` };
  const sessions = JSON.parse(r.stdout.trim() || '[]');
  if (!sessions.length) return { skipped: `no devin session for ${worktreePath}` };
  sessions.sort((a, b) => (b.last || 0) - (a.last || 0));
  return { db, py, sessions };
}

function archiveDevin(worktreePath, outDir) {
  const p = devinSessions(worktreePath);
  if (p.skipped) return p;
  const { db, py, sessions } = p;
  const want = OPT('--session', null);
  const sess = want ? sessions.find((s) => s.id === want) || { error: `no session "${want}" in ${worktreePath}; candidates: ${sessions.map((x) => x.id).join(', ')}` } : sessions[0];
  if (sess.error) return { skipped: sess.error };
  fs.mkdirSync(outDir, { recursive: true });
  const dump = spawnSync(py, ['-c', `
import sqlite3, json, sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
db = sqlite3.connect(r'''${db}''')
nodes = db.execute("select chat_message, created_at from message_nodes where session_id=? order by row_id", ['${sess.id}']).fetchall()
for msg, ts in nodes:
    try:
        m = json.loads(msg)
        role = m.get('role') or '?'
        content = m.get('content') or ''
        if isinstance(content, list): content = ' '.join(str(c.get('text', c) if isinstance(c, dict) else c) for c in content)
        print(f"\\n## {role}\\n{content}")
        for tc in m.get('tool_calls') or []:
            print(f"\\n> tool {tc.get('name')}: " + json.dumps(tc.get('arguments'))[:2000])
    except Exception:
        try: print("\\n## raw\\n" + msg[:4000].encode('utf-8', 'replace').decode('utf-8'))
        except Exception: print("\\n## raw\\n<undecodable node>")
`], { encoding: 'utf8', maxBuffer: 256 << 20 });
  const file = path.join(outDir, `devin-${sess.id}-${Date.now()}.md`);
  fs.writeFileSync(file, `# devin session ${sess.id} (resume: devin --resume ${sess.id})\n# dir ${sess.dir} | model ${sess.model} | ${sess.messages} messages\n` + (dump.stdout || ''));
  return { file, session: sess.id, messages: sess.messages, candidates: sessions.length };
}

function archiveScrollback(handle, outDir) {
  try {
    // page backwards through scrollback with oldestCursor (bounded)
    let chunks = [], cursor = null, pages = 0;
    for (; pages < 100; pages++) {
      const a = ['terminal', 'read', '--terminal', handle];
      if (cursor) a.push('--cursor', String(cursor));
      const r = orca(a);
      const t = r.terminal || r;
      const text = Array.isArray(t.tail) ? t.tail.join('\n') : String(t.text ?? t.content ?? '');
      chunks.unshift(text);
      const oldest = t.oldestCursor ?? t.oldest_cursor ?? null;
      if (oldest == null || oldest === cursor || t.limited === false) break;
      cursor = oldest;
    }
    const all = chunks.join('\n').trim();
    if (!all) return { skipped: 'empty scrollback' };
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, `scrollback-${handle.replace(/^term_/, '')}-${Date.now()}.log`);
    fs.writeFileSync(file, all);
    return { file, bytes: all.length, pages: pages + 1 };
  } catch (e) { return { skipped: String(e.message || e) }; }
}

function cmdTrim() {
  const ref = POSITIONAL[0];
  if (!ref) fail('trim needs a target (handle | ptyId | paneKey)');
  const outDir = path.resolve(OPT('--archive', '.clean-archive'));
  const thenClose = FLAG('--then-close');
  const dryRun = FLAG('--dry-run');
  const found = findSession(ref) || fail(`no session matches "${ref}"`);
  const s = found.session;
  if (!s) fail('trim targets one session, not a workspace');
  if (s.self) fail('refusing to trim your own session');

  const memBefore = s.memory != null ? { memory: s.memory, privateMemory: s.privateMemory } : null;

  // 1) archive context to disk
  let archive;
  if (s.agent === 'devin') archive = archiveDevin(found.workspace.path, outDir);
  else if (s.handle) archive = archiveScrollback(s.handle, outDir);
  else archive = { skipped: 'chat session — archive its transcript via the agent UI or `devin --export`' };

  if (dryRun) return emit({ dryRun: true, target: s.handle || s.mailbox, agent: s.agent, archive, memBefore, wouldSend: COMPACT_CMD[s.agent] || '(checkpoint prompt)' });

  // never run a destructive /compact with no transcript on disk — the archive
  // is the whole point of trim. Checkpoint prompts (unknown agents, mailbox
  // sessions) don't destroy context, so they may proceed without one.
  if ((archive.skipped || archive.error) && s.handle && COMPACT_CMD[s.agent] && !FLAG('--force')) {
    fail(`archive did not complete (${archive.skipped || archive.error}) — refusing to ${COMPACT_CMD[s.agent]} with nothing on disk. Fix the archive path or pass --force.`);
  }

  // 2) send the agent's native compaction command; unknown agents get a
  //    checkpoint-summary instruction they can act on autonomously
  let sent = null;
  if (s.handle) {
    const text = COMPACT_CMD[s.agent] ||
      'Please write a compact checkpoint of this conversation (goal, decisions, open work, key file paths) to .clean-checkpoint.md in the repo root, then reply READY. Your transcript has been archived to disk; the checkpoint keeps the essentials in-context.';
    try { sent = orca(['terminal', 'send', '--terminal', s.handle, '--text', text, '--enter', '--wait-submit', '15']); }
    catch (e) { sent = { error: String(e.message || e) }; }
  } else if (s.mailbox) {
    const body = 'compact-checkpoint: write .clean-checkpoint.md (goal/decisions/open work/paths), reply READY';
    try { sent = orca(['orchestration', 'send', '--to', s.mailbox, '--subject', body, '--type', 'question']); }
    catch (e) { sent = { error: String(e.message || e) }; }
  }

  let memAfter = null;
  if (s.handle && sent && !sent.error) {
    // give the compactor a short window, then re-measure (a full /compact can
    // take a while — this is a hint, not a guarantee)
    sleep(15000);
    const inv = inventory({ allProjects: true });
    outer: for (const w of inv.worktrees) for (const x of w.sessions) if (x.ptyId === s.ptyId || x.handle === s.handle) { memAfter = { memory: x.memory, privateMemory: x.privateMemory }; break outer; }
  }

  const report = { target: s.handle || s.mailbox || s.paneKey, agent: s.agent, archive, compactSent: sent, memBefore, memAfter };
  if (thenClose) {
    report.close = 'run: clean.mjs close ' + (s.handle || ref);
  }
  emit(report);
}

// ---------- self ----------

function cmdSelf() {
  emit({
    terminal: SELF.terminal,
    paneKey: SELF.paneKey,
    worktreeId: SELF.worktreeId,
    repoId: SELF.repoId,
    note: 'never close/trim/warn this terminal or its paneKey',
  });
}

// ---------- helpers ----------

function fmtBytes(b) {
  if (b == null) return '-';
  if (b >= 1e9) return (b / 1e9).toFixed(2) + 'GB';
  if (b >= 1e6) return (b / 1e6).toFixed(0) + 'MB';
  return (b / 1e3).toFixed(0) + 'kB';
}
function idleStr(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'live';
  if (m < 60) return m + 'm idle';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h idle';
  return Math.floor(h / 24) + 'd idle';
}
function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function defaultWarn(grace) {
  return `⚠ clean: you're about to be closed to free system memory (grace ${grace}s). Reply immediately if you need to save work, or say READY when safe to close.`;
}

const HELP = `clean — Orca session memory manager
  list [--all] [--json]            live sessions per workspace + memory (own project first)
  peek <handle>                    print the terminal's current screen
  warn <target> [--message m]      send the about-to-close warning only
  close <target> [--grace s]       warn → wait (polls replies) → close
                                   resumable agents (devin) are parked: agent exits,
                                   shell stays with its resume command pre-typed
        [--hard] [--session id]    kill the terminal instead / resume id to pre-type
        [--no-warn] [--tab]        skip warning / close the whole tab
        [--dry-run]                show what would close
  trim <target> [--archive dir]    archive context to disk + send /compact
        [--then-close] [--dry-run]
  self                             print this session's Orca identity
target = term_ handle | ptyId suffix | orca_session_id:… | dispatch id | worktree selector
orca = ${ORCA}`;

if (!cmd || FLAG('--help') || FLAG('-h')) console.log(HELP);
else {
  try {
    ({ list: cmdList, peek: cmdPeek, warn: cmdWarn, close: cmdClose, trim: cmdTrim, self: cmdSelf }[cmd] ||
      fail(`unknown command ${cmd}`))();
  } catch (e) {
    console.error('clean: ' + String(e.message || e));
    process.exit(1);
  }
}
