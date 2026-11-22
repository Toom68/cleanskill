#!/usr/bin/env node
// Installs skills/ into the shared agent skill dirs.
// Primary: ~/.agents/skills (devin cli + the cross-vendor .agents convention).
// Mirror:  ~/.claude/skills (Claude Code, matching this machine's convention).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const home = os.homedir();
const targets = [
  path.join(home, '.agents', 'skills'),
  path.join(home, '.claude', 'skills'),
];

for (const skill of fs.readdirSync(path.join(here, 'skills'))) {
  const src = path.join(here, 'skills', skill);
  if (!fs.statSync(src).isDirectory()) continue;
  for (const root of targets) {
    const dst = path.join(root, skill);
    fs.mkdirSync(root, { recursive: true });
    fs.rmSync(dst, { recursive: true, force: true });
    fs.cpSync(src, dst, { recursive: true });
    console.log(`${skill} -> ${dst}`);
  }
}
console.log('done. restart agents to pick up new skills.');
