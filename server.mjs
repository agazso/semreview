#!/usr/bin/env node
// semreview [base] [--head <ref>] [--repo <dir>] [--port <n>]
// Serves a semantic review of base...head (head defaults to the working tree, uncommitted changes included).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { git, Side, defaultBase, listChanges } from './git.mjs';
import { loadTs, makeClassifier, symbols, Projects, TS_EXT } from './ts.mjs';

const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(`--${name}`); return i < 0 ? def : argv.splice(i, 2)[1]; };
const repoDir = opt('repo', process.cwd());
const port = +opt('port', process.env.PORT ?? 4747);
const headArg = opt('head', null);
const root = git(repoDir, ['rev-parse', '--show-toplevel']).trim();
const baseName = argv[0] ?? defaultBase(root);
const headRef = headArg && git(root, ['rev-parse', '--verify', headArg]).trim();
const mergeBase = git(root, ['merge-base', baseName, headRef ?? 'HEAD']).trim();
const sides = { old: new Side(root, mergeBase), new: new Side(root, headRef) };

const DEFAULT_CONFIG = {
  // Display order. A file goes to the first group whose globs match; `rest` takes everything else.
  groups: [
    { name: 'API surface & types', include: ['**/*.d.ts', '**/types.ts', '**/types/**', '**/index.ts', '**/*.graphql', '**/openapi*.{json,yaml,yml}', '**/*.proto'] },
    { name: 'Docs, config & CI', include: ['**/*.md', '**/*.{yml,yaml,toml}', '**/Dockerfile', '**/.*ignore', '.github/**'], last: true },
    { name: 'Tests', include: ['**/*.test.*', '**/*.spec.*', '**/__tests__/**', '**/test/**', '**/tests/**', '**/e2e/**'], collapsed: true, last: true },
    { name: 'Code', rest: true },
  ],
  hidden: ['**/pnpm-lock.yaml', '**/package-lock.json', '**/yarn.lock', '**/bun.lockb', '**/*.snap', '**/dist/**', '**/*.min.js', '**/*.map'],
};
const matches = (p, globs) => (globs ?? []).some((g) => path.matchesGlob(p, g));

let ts, classify, projects, projectsKey, lastFiles = [];
const MAX_TEXT = 2_000_000;

function sideData(side, rel, isTs) {
  const text = side.read(rel);
  if (text === undefined || text.includes('\0') || text.length > MAX_TEXT) return null;
  return { text, cls: isTs ? classify(rel, text) : [], syms: isTs ? symbols(ts, rel, text) : [] };
}

function buildReview() {
  const changes = listChanges(root, mergeBase, headRef);
  ts ??= loadTs(root, changes.map((c) => path.join(root, path.dirname(c.path))));
  classify ??= ts && makeClassifier(ts);
  const key = changes.map((c) => c.path).join('\0');
  if (ts && key !== projectsKey) {
    // the set of changed files decides the extra root files of each program; rebuild lazily when it changes
    projectsKey = key;
    projects = {
      old: new Projects(ts, sides.old, changes.map((c) => c.oldPath).filter(Boolean)),
      new: new Projects(ts, sides.new, changes.filter((c) => c.status !== 'D').map((c) => c.path)),
    };
  }
  let config = DEFAULT_CONFIG;
  try { const t = sides.new.read('.semreview.json'); if (t) config = { ...DEFAULT_CONFIG, ...JSON.parse(t) }; } catch {}
  const groups = config.groups;
  const order = groups.map((g, i) => [g.last ? 1 : 0, i]); // `last` groups match early but display at the end
  const rest = groups.findIndex((g) => g.rest);

  const files = changes.map((c) => {
    const isTs = !!ts && TS_EXT.test(c.path);
    const hidden = matches(c.path, config.hidden);
    let group = groups.findIndex((g) => !g.rest && matches(c.path, g.include));
    if (group < 0) group = rest < 0 ? groups.length - 1 : rest;
    const f = { ...c, group, hidden, ts: isTs };
    if (hidden || c.binary) return f;
    f.old = c.oldPath ? sideData(sides.old, c.oldPath, isTs) : null;
    f.new = c.status === 'D' ? null : sideData(sides.new, c.path, isTs);
    if (c.untracked) f.hunks = [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: f.new ? f.new.text.split('\n').length - (f.new.text.endsWith('\n') ? 1 : 0) : 0 }];
    return f;
  });
  // pair foo.test.ts / __tests__/foo.ts with foo.ts
  const stem = (p) => p.replace(/\/__tests__\//, '/').replace(/\.(test|spec)(?=\.[^.]+$)/, '').replace(/\.[^./]+$/, '');
  const base = (p) => path.posix.basename(stem(p));
  const codeFiles = files.filter((f) => !groups[f.group].collapsed && !f.hidden);
  for (const f of files) {
    if (!groups[f.group].collapsed) continue;
    const sameStem = codeFiles.filter((c) => stem(c.path) === stem(f.path));
    const sameName = codeFiles.filter((c) => base(c.path) === base(f.path)); // tests/ next to src/
    const pair = sameStem.length ? sameStem : sameName.length === 1 ? sameName : [];
    if (pair.length) f.testFor = pair[0].path;
  }

  const rank = (f) => order[f.group];
  files.sort((a, b) => rank(a)[0] - rank(b)[0] || rank(a)[1] - rank(b)[1] || a.path.localeCompare(b.path));
  lastFiles = files;
  return {
    repo: path.basename(root), base: baseName, mergeBase: mergeBase.slice(0, 10),
    head: headRef ? headArg : 'working tree', semantics: !!ts, tsVersion: ts?.version,
    groups: groups.map((g) => ({ name: g.name, collapsed: !!g.collapsed })), files,
  };
}

function apiDiff() {
  const out = [];
  for (const f of lastFiles) {
    if (!f.ts || f.hidden) continue;
    const before = f.oldPath ? projects.old.exportsOf(f.oldPath) : {};
    const after = f.status === 'D' ? {} : projects.new.exportsOf(f.path);
    if (!before || !after) continue; // not part of any program
    for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const b = before[name], a = after[name];
      if (b && a && b.sig === a.sig && b.kind === a.kind) continue;
      out.push({ path: f.path, name, change: !b ? 'added' : !a ? 'removed' : 'changed', kind: (a ?? b).kind, before: b?.sig, after: a?.sig });
    }
  }
  return out;
}

const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#0969da"/><path d="M4 5h8M4 8h5M4 11h7" stroke="#fff" stroke-width="1.6"/></svg>';
const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const q = (k) => u.searchParams.get(k);
  try {
    if (u.pathname === '/') return send(res, 200, fs.readFileSync(new URL('./index.html', import.meta.url)), 'text/html; charset=utf-8');
    if (u.pathname === '/favicon.ico') return send(res, 200, ICON, 'image/svg+xml');
    if (u.pathname === '/api/review') return send(res, 200, buildReview());
    if (!projects) return send(res, 200, null);
    if (u.pathname === '/api/apidiff') return send(res, 200, apiDiff());
    if (!q('path')) return send(res, 400, { error: 'path required' });
    const P = projects[q('side') === 'old' ? 'old' : 'new'];
    const at = [q('path'), +q('line'), +q('col')];
    if (u.pathname === '/api/hover') return send(res, 200, P.hover(...at));
    if (u.pathname === '/api/def') return send(res, 200, P.definition(...at));
    if (u.pathname === '/api/file') {
      const text = P.file(q('path')); // only files that are part of a program
      if (text === undefined) return send(res, 404, { error: 'not in any program' });
      const isTs = TS_EXT.test(q('path'));
      return send(res, 200, { path: q('path'), text, cls: isTs ? classify(q('path'), text) : [], syms: isTs ? symbols(ts, q('path'), text) : [] });
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: e.message });
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`semreview: ${path.basename(root)} ${baseName} (${mergeBase.slice(0, 10)}) → ${headRef ? headArg : 'working tree'}`);
  console.log(`http://localhost:${port}/`);
});
