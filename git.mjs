// Git access: a "Side" is one version of the repo (a commit, or the working tree).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const git = (cwd, args) =>
  execFileSync('git', ['-c', 'core.quotepath=off', ...args], { cwd, encoding: 'utf8', maxBuffer: 1 << 30 });

const z = (s) => s.split('\0').filter(Boolean);

export class Side {
  constructor(root, ref) {
    this.root = root;
    this.ref = ref; // null = working tree
    this.cache = new Map();
  }
  get label() { return this.ref ? this.ref.slice(0, 10) : 'working tree'; }

  // Files tracked in this ref, and files tracked in the index now. A path that is in neither
  // (node_modules, .svelte-kit, other generated stuff) is read from disk for both sides.
  get files() { return (this._files ??= new Set(z(git(this.root, ['ls-tree', '-r', '-z', '--name-only', this.ref])))); }
  get indexFiles() { return (this._idx ??= new Set(z(git(this.root, ['ls-files', '-z'])))); }
  get dirs() {
    if (!this._dirs) {
      this._dirs = new Map(); // dir -> {files:Set, directories:Set}
      const entry = (d) => this._dirs.get(d) ?? this._dirs.set(d, { files: new Set(), directories: new Set() }).get(d);
      for (const f of this.files) {
        let d = path.posix.dirname(f), base = path.posix.basename(f);
        entry(d === '.' ? '' : d).files.add(base);
        while (d !== '.') {
          const parent = path.posix.dirname(d);
          entry(parent === '.' ? '' : parent).directories.add(path.posix.basename(d));
          d = parent;
        }
      }
    }
    return this._dirs;
  }

  rel(abs) {
    const r = path.relative(this.root, abs);
    return r.startsWith('..') || path.isAbsolute(r) ? null : r.split(path.sep).join('/');
  }
  // Does this path come from git (true) or from disk (false)?
  fromGit(rel) {
    return this.ref && rel !== null && !rel.split('/').includes('node_modules') &&
      (this.files.has(rel) || this.indexFiles.has(rel));
  }

  read(rel) {
    if (!this.fromGit(rel)) {
      try { return fs.readFileSync(path.join(this.root, rel), 'utf8'); } catch { return undefined; }
    }
    if (!this.files.has(rel)) return undefined; // tracked now, but not in this ref
    if (!this.cache.has(rel)) {
      // ponytail: one `git show` per file; switch to `git cat-file --batch` if base programs get slow
      this.cache.set(rel, git(this.root, ['show', `${this.ref}:${rel}`]));
    }
    return this.cache.get(rel);
  }

  // Filesystem-ish API on absolute paths, for the TypeScript host.
  readAbs(abs) { const r = this.rel(abs); return r === null ? readDisk(abs) : this.read(r); }
  existsAbs(abs) {
    const r = this.rel(abs);
    if (r === null || !this.fromGit(r)) return fs.existsSync(abs) && fs.statSync(abs).isFile();
    return this.files.has(r);
  }
  dirExistsAbs(abs) {
    const r = this.rel(abs);
    const disk = () => fs.existsSync(abs) && fs.statSync(abs).isDirectory();
    if (r === null || !this.ref || r.split('/').includes('node_modules')) return disk();
    if (r === '' || this.dirs.has(r)) return true;
    return !this.dirsNow().has(r) && disk(); // tracked now but not in ref -> did not exist then
  }
  entriesAbs(abs) {
    const r = this.rel(abs);
    const disk = { files: [], directories: [] };
    try {
      for (const e of fs.readdirSync(abs, { withFileTypes: true })) (e.isDirectory() ? disk.directories : disk.files).push(e.name);
    } catch {}
    if (r === null || !this.ref || r.split('/').includes('node_modules')) return disk;
    // git entries, plus untracked disk entries (generated files)
    const g = this.dirs.get(r) ?? { files: new Set(), directories: new Set() };
    const p = (n) => (r ? `${r}/${n}` : n);
    return {
      files: [...g.files, ...disk.files.filter((n) => !g.files.has(n) && !this.indexFiles.has(p(n)))],
      directories: [...g.directories, ...disk.directories.filter((n) => !g.directories.has(n) && !this.dirsNow().has(p(n)))],
    };
  }
  dirsNow() {
    if (!this._dirsNow) {
      this._dirsNow = new Set();
      for (const f of this.indexFiles) for (let d = path.posix.dirname(f); d !== '.'; d = path.posix.dirname(d)) this._dirsNow.add(d);
    }
    return this._dirsNow;
  }
  mtime(abs) { try { return String(fs.statSync(abs).mtimeMs); } catch { return '0'; } }
}

const readDisk = (abs) => { try { return fs.readFileSync(abs, 'utf8'); } catch { return undefined; } };

export function defaultBase(root) {
  for (const ref of ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master']) {
    try { git(root, ['rev-parse', '--verify', '-q', ref]); return ref; } catch {}
  }
  throw new Error('no base branch found, pass one: semreview <base>');
}

// Changed files between base and head (head = null: working tree, including untracked files).
export function listChanges(root, baseRef, headRef) {
  const range = headRef ? [baseRef, headRef] : [baseRef];
  const parts = z(git(root, ['diff', '--name-status', '-z', '-M', ...range]));
  const out = [];
  for (let i = 0; i < parts.length; ) {
    const st = parts[i++];
    const c = st[0];
    const oldPath = c === 'A' ? null : parts[i];
    const newPath = c === 'R' || c === 'C' ? parts[i + 1] : c === 'D' ? null : parts[i];
    i += c === 'R' || c === 'C' ? 2 : 1;
    out.push({ status: c, oldPath, path: newPath ?? oldPath });
  }
  if (!headRef) {
    for (const p of z(git(root, ['ls-files', '--others', '--exclude-standard', '-z']))) out.push({ status: 'A', oldPath: null, path: p, untracked: true });
  }
  for (const f of out) {
    if (f.untracked) continue;
    const paths = [...new Set([f.oldPath, f.path].filter(Boolean))];
    const patch = git(root, ['diff', '-U0', '--no-color', '--no-ext-diff', '-M', ...range, '--', ...paths]);
    f.binary = /^Binary files /m.test(patch);
    f.hunks = parseHunks(patch);
  }
  return out;
}

export function parseHunks(patch) {
  const hunks = [];
  for (const m of patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    hunks.push({ oldStart: +m[1], oldLines: m[2] === undefined ? 1 : +m[2], newStart: +m[3], newLines: m[4] === undefined ? 1 : +m[4] });
  }
  return hunks;
}
