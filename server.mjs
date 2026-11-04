#!/usr/bin/env node
// semreview [base] [--head <ref>] [--port <n>] [--projects <dir>]
//
//   /                              the repo you started it in: base...working tree (or --head)
//   /<repo>/                       any repo under ~/Projects: default branch...its working tree
//   /<repo>/<branch>               default branch...that branch (fetched from origin first)
//   /<repo>/pull/<n>               the GitHub PR's base...head, fetched as refs/semreview/pull/<n>
//   ?base=<ref>                    overrides the base on any of these
//
// <repo> is the path under ~/Projects, case-insensitive: /snaha/swarm-id/pull/914 is a github.com URL with the host swapped.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { git, tryGit, Side, defaultBase, listChanges, findRepo, listRepos } from './git.mjs';
import { loadTs, makeClassifier, symbols, Projects, TS_EXT } from './ts.mjs';

const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(`--${name}`); return i < 0 ? def : argv.splice(i, 2)[1]; };
const port = +opt('port', process.env.PORT ?? 4747);
const projectsDir = path.resolve(opt('projects', process.env.SEMREVIEW_PROJECTS ?? path.join(os.homedir(), 'Projects')));
const headArg = opt('head', null);
const cwdRoot = tryGit(process.cwd(), ['rev-parse', '--show-toplevel']);

const DEFAULT_CONFIG = {
  // A file goes to the first group whose globs match; `rest` takes everything else. Display order is the array
  // order, except `first` groups go on top and `last` groups at the end.
  groups: [
    { name: 'API surface & types', include: ['**/*.d.ts', '**/types.ts', '**/types/**', '**/index.ts', '**/*.graphql', '**/openapi*.{json,yaml,yml}', '**/*.proto'] },
    { name: 'Config & CI', include: ['**/*.{yml,yaml,toml}', '**/package.json', '**/tsconfig*.json', '**/Dockerfile', '**/.*ignore', '**/.{npmrc,nvmrc,editorconfig}', '.github/**'], first: true },
    { name: 'Docs', include: ['**/*.{md,mdx,rst}'], last: true },
    { name: 'Tests', include: ['**/*.test.*', '**/*.spec.*', '**/__tests__/**', '**/test/**', '**/tests/**', '**/e2e/**'], collapsed: true, last: true },
    { name: 'Code', rest: true },
  ],
  hidden: ['**/pnpm-lock.yaml', '**/package-lock.json', '**/yarn.lock', '**/bun.lockb', '**/*.snap', '**/dist/**', '**/*.min.js', '**/*.map'],
};
const matches = (p, globs) => (globs ?? []).some((g) => path.matchesGlob(p, g));
const MAX_TEXT = 2_000_000;

class HttpError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; } }

const gh = (root, args) => {
  try { return execFileSync('gh', args, { cwd: root, encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
};
// GitHub numbers issues and PRs together: say which it is, and offer PRs that mention it
function notAPr(root, n) {
  const issue = gh(root, ['api', `repos/{owner}/{repo}/issues/${n}`, '-q', 'if .pull_request then "" else .title end']);
  if (!issue) return new HttpError(404, `PR #${n} not found on origin`);
  const prs = (gh(root, ['pr', 'list', '--state', 'all', '--search', n, '--json', 'number,title,state', '-q', '.[] | "\\(.number)\\t\\(.state)\\t\\(.title)"']) ?? '')
    .split('\n').filter(Boolean).map((l) => { const [number, state, title] = l.split('\t'); return { number: +number, state, title }; });
  return new HttpError(404, `#${n} is an issue, not a pull request: "${issue}"`, { prs });
}

// ---------- what a URL means ----------
const sha = (root, ref) => tryGit(root, ['rev-parse', '--verify', '-q', '--end-of-options', `${ref}^{commit}`]);
const defaultBranch = (root) => tryGit(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']) ?? defaultBase(root);
const prBases = new Map(); // `${root}#${n}` -> base branch from GitHub, so hover calls resolve to the same review

function fetchRefs(root, refspecs, warnings) {
  if (!refspecs.length) return true;
  const ok = tryGit(root, ['fetch', '--quiet', '--no-tags', 'origin', '--end-of-options', ...refspecs]) !== null;
  if (!ok && warnings) warnings.push('git fetch from origin failed, showing local refs');
  return ok;
}
const baseSpec = (b) => (b.startsWith('origin/') ? [`+refs/heads/${b.slice(7)}:refs/remotes/${b}`] : []);

// route: URL path without the API suffix. doFetch: only the page load fetches; hover etc. reuse its result.
function resolve(route, baseParam, doFetch) {
  if (route === '/') {
    if (!cwdRoot) throw new HttpError(404, 'index');
    return {
      root: cwdRoot, name: path.basename(cwdRoot), baseName: baseParam ?? argv[0] ?? defaultBase(cwdRoot),
      head: headArg ? sha(cwdRoot, headArg) : null, label: headArg ?? 'working tree', warnings: [],
    };
  }
  const segs = route.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
  const repo = findRepo(projectsDir, segs);
  if (!repo) throw new HttpError(404, `no git repo for ${route} under ${projectsDir}`);
  const { root, rest } = repo;
  const warnings = [];
  let baseName = baseParam, head = null, label = 'working tree';

  if (rest[0] === 'pull' && /^\d+$/.test(rest[1] ?? '')) {
    const n = rest[1], key = `${root}#${n}`;
    if (doFetch && !baseParam) {
      // the PR's real base branch; without gh (or offline) fall back to the default branch
      const b = gh(root, ['pr', 'view', n, '--json', 'baseRefName', '-q', '.baseRefName']);
      if (b) prBases.set(key, `origin/${b}`);
      else warnings.push('could not ask GitHub for the PR base (gh), using the default branch');
    }
    baseName ??= prBases.get(key) ?? defaultBranch(root);
    if (doFetch) fetchRefs(root, [`+refs/pull/${n}/head:refs/semreview/pull/${n}`, ...baseSpec(baseName)], warnings);
    head = sha(root, `refs/semreview/pull/${n}`);
    if (!head) throw doFetch ? notAPr(root, n) : new HttpError(404, `PR #${n} not found on origin`);
    label = `PR #${n}`;
  } else if (rest.length) {
    const branch = rest.join('/');
    if (branch.startsWith('-') || tryGit(root, ['check-ref-format', '--branch', branch]) === null) throw new HttpError(400, `bad branch name: ${branch}`);
    baseName ??= defaultBranch(root);
    if (doFetch) {
      fetchRefs(root, baseSpec(baseName), warnings);
      fetchRefs(root, [`+refs/heads/${branch}:refs/remotes/origin/${branch}`]); // fails for local-only branches, fine
    }
    const remote = sha(root, `refs/remotes/origin/${branch}`), local = sha(root, `refs/heads/${branch}`);
    if (!remote && !local) throw new HttpError(404, `no branch ${branch} locally or on origin`);
    // the newer of the two; if they diverged, origin wins (that is what the PR shows)
    const localAhead = local && remote && local !== remote && tryGit(root, ['merge-base', '--is-ancestor', remote, local]) !== null;
    head = !remote || localAhead ? local : remote;
    label = `${branch} (${head === remote ? 'origin' : 'local'})`;
    if (local && remote && local !== remote && !localAhead && tryGit(root, ['merge-base', '--is-ancestor', local, remote]) === null) {
      warnings.push(`local ${branch} and origin/${branch} have diverged; showing origin`);
    }
  }
  baseName ??= defaultBranch(root);
  return { root, name: repo.name, baseName, head, label, warnings };
}

// ---------- one review: a repo, a base and a head ----------
class Review {
  constructor({ root, name, baseName, head, label }) {
    Object.assign(this, { root, name, baseName, head, label });
    this.mergeBase = git(root, ['merge-base', '--end-of-options', baseName, head ?? 'HEAD']).trim();
    this.sides = { old: new Side(root, this.mergeBase), new: new Side(root, head) };
    this.files = [];
  }

  sideData(side, rel, isTs) {
    const text = side.read(rel);
    if (text === undefined || text.includes('\0') || text.length > MAX_TEXT) return null;
    return { text, cls: isTs ? this.classify(rel, text) : [], syms: isTs ? symbols(this.ts, rel, text) : [] };
  }

  build() {
    const { root, sides } = this;
    const changes = listChanges(root, this.mergeBase, this.head);
    this.ts ??= loadTs(root, changes.map((c) => path.join(root, path.dirname(c.path))));
    this.classify ??= this.ts && makeClassifier(this.ts);
    const key = changes.map((c) => c.path).join('\0');
    if (this.ts && key !== this.projectsKey) {
      // the changed files are extra roots of each program; rebuild (lazily) when that set changes
      this.projectsKey = key;
      this.projects = {
        old: new Projects(this.ts, sides.old, changes.map((c) => c.oldPath).filter(Boolean)),
        new: new Projects(this.ts, sides.new, changes.filter((c) => c.status !== 'D').map((c) => c.path)),
      };
    }
    let config = DEFAULT_CONFIG;
    try { const t = sides.new.read('.semreview.json'); if (t) config = { ...DEFAULT_CONFIG, ...JSON.parse(t) }; } catch {}
    const groups = config.groups;
    const order = groups.map((g, i) => [g.first ? -1 : g.last ? 1 : 0, i]); // match in array order, display `first` groups on top and `last` ones at the end
    const rest = groups.findIndex((g) => g.rest);

    const files = changes.map((c) => {
      const isTs = !!this.ts && TS_EXT.test(c.path);
      const hidden = matches(c.path, config.hidden);
      let group = groups.findIndex((g) => !g.rest && matches(c.path, g.include));
      if (group < 0) group = rest < 0 ? groups.length - 1 : rest;
      const f = { ...c, group, hidden, ts: isTs };
      if (hidden || c.binary) return f;
      f.old = c.oldPath ? this.sideData(sides.old, c.oldPath, isTs) : null;
      f.new = c.status === 'D' ? null : this.sideData(sides.new, c.path, isTs);
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
    this.files = files;
    return {
      repo: this.name, base: this.baseName, mergeBase: this.mergeBase.slice(0, 10),
      head: this.head ? `${this.label} ${this.head.slice(0, 10)}` : this.label, semantics: !!this.ts, tsVersion: this.ts?.version,
      groups: groups.map((g) => ({ name: g.name, collapsed: !!g.collapsed })), files,
    };
  }

  apiDiff() {
    const out = [];
    for (const f of this.files) {
      if (!f.ts || f.hidden) continue;
      const before = f.oldPath ? this.projects.old.exportsOf(f.oldPath) : {};
      const after = f.status === 'D' ? {} : this.projects.new.exportsOf(f.path);
      if (!before || !after) continue; // not part of any program
      for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
        const b = before[name], a = after[name];
        if (b && a && b.sig === a.sig && b.kind === a.kind) continue;
        out.push({ path: f.path, name, change: !b ? 'added' : !a ? 'removed' : 'changed', kind: (a ?? b).kind, before: b?.sig, after: a?.sig });
      }
    }
    return out;
  }
}

// Reviews keyed by repo + exact commits, so a new push is a new review. Programs are big: keep a few.
const reviews = new Map();
const KEEP = 3;
function getReview(route, baseParam, doFetch) {
  const r = resolve(route, baseParam, doFetch);
  const baseSha = sha(r.root, r.baseName);
  if (!baseSha) throw new HttpError(404, `base ${r.baseName} not found`);
  const key = [r.root, baseSha, r.head ?? 'worktree'].join('\0');
  let review = reviews.get(key);
  if (review) { reviews.delete(key); Object.assign(review, { name: r.name, baseName: r.baseName, label: r.label }); } // same commits, other URL
  else review = new Review(r);
  reviews.set(key, review); // most recent last
  while (reviews.size > KEEP) reviews.delete(reviews.keys().next().value);
  return { review, warnings: r.warnings };
}

// ---------- HTTP ----------
const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#0969da"/><path d="M4 5h8M4 8h5M4 11h7" stroke="#fff" stroke-width="1.6"/></svg>';
const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};
const escHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const indexPage = () => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>semreview</title>
<style>:root{color-scheme:light dark}body{font:15px/1.6 system-ui,sans-serif;max-width:720px;margin:32px auto;padding:0 16px}a{color:#0969da;text-decoration:none}code{font-size:13px}</style>
<h1>semreview</h1><p>Repos under <code>${escHtml(projectsDir)}</code>. Open <code>/&lt;repo&gt;/&lt;branch&gt;</code> or
<code>/&lt;repo&gt;/pull/&lt;n&gt;</code>; a repo alone shows its working tree.</p>
<ul>${listRepos(projectsDir).map((r) => `<li><a href="/${r.split('/').map(encodeURIComponent).join('/')}/">${escHtml(r)}</a></li>`).join('')}</ul>`;

// Only answer to localhost names: with every repo under ~/Projects behind this port, a DNS-rebinding page must not read it.
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

http.createServer((req, res) => {
  if (!LOCAL_HOST.test(req.headers.host ?? '')) return send(res, 403, { error: 'forbidden host' });
  const u = new URL(req.url, 'http://localhost');
  const q = (k) => u.searchParams.get(k);
  try {
    if (u.pathname === '/favicon.ico') return send(res, 200, ICON, 'image/svg+xml');
    const api = u.pathname.match(/^(.*?)\/-\/api\/(\w+)$/);
    if (!api) {
      // a page: check the route resolves (cheap, no fetch), drop GitHub's /files, /commits… suffixes
      const pr = u.pathname.match(/^(.*\/pull\/\d+)\/.+$/);
      if (pr) { res.writeHead(302, { location: pr[1] + u.search }); return res.end(); }
      if (u.pathname === '/' && !cwdRoot) return send(res, 200, indexPage(), 'text/html; charset=utf-8');
      if (u.pathname !== '/' && !findRepo(projectsDir, u.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s)))) {
        return send(res, 404, indexPage(), 'text/html; charset=utf-8');
      }
      return send(res, 200, fs.readFileSync(new URL('./index.html', import.meta.url)), 'text/html; charset=utf-8');
    }
    const [, route, ep] = api;
    const { review, warnings } = getReview(route || '/', q('base'), ep === 'review');
    if (ep === 'review') return send(res, 200, { ...review.build(), warnings });
    if (review.ts === undefined) review.build(); // server restarted under an open page
    const projects = review.projects;
    if (!projects) return send(res, 200, null);
    if (ep === 'apidiff') return send(res, 200, review.apiDiff());
    if (!q('path')) return send(res, 400, { error: 'path required' });
    const P = projects[q('side') === 'old' ? 'old' : 'new'];
    const at = [q('path'), +q('line'), +q('col')];
    if (ep === 'hover') return send(res, 200, P.hover(...at));
    if (ep === 'def') return send(res, 200, P.definition(...at));
    if (ep === 'file') {
      const text = P.file(q('path')); // only files that are part of a program
      if (text === undefined) return send(res, 404, { error: 'not in any program' });
      const isTs = TS_EXT.test(q('path'));
      return send(res, 200, { path: q('path'), text, cls: isTs ? review.classify(q('path'), text) : [], syms: isTs ? symbols(review.ts, q('path'), text) : [] });
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    if (!e.status) console.error(e);
    send(res, e.status ?? 500, { error: e.message, ...e.extra });
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`semreview: repos under ${projectsDir}${cwdRoot ? `; / is ${path.basename(cwdRoot)}` : ''}`);
  console.log(`http://localhost:${port}/`);
});
