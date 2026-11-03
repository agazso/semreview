// Self-check: builds a throwaway repo, starts the server on it, asserts on every endpoint.
// TS_DIR=path/to/node_modules/typescript node test.mjs   (default: ~/Projects/feeds' copy)
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tsDir = process.env.TS_DIR ?? path.join(os.homedir(), 'Projects/feeds/node_modules/typescript');
assert.ok(fs.existsSync(tsDir), `typescript not found at ${tsDir}, set TS_DIR`);
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'semreview-test-'));
const sh = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo });
const write = (p, s) => { fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true }); fs.writeFileSync(path.join(repo, p), s); };

const body = Array.from({ length: 12 }, (_, i) => `    const v${i} = ${i};`).join('\n');
write('tsconfig.json', '{"compilerOptions":{"strict":true,"target":"ES2022","module":"ESNext","moduleResolution":"Bundler"},"include":["src"],"exclude":["src/**/*.test.ts"]}');
write('.gitignore', 'node_modules\n');
write('src/user.ts', `export interface User { id: string; name: string }

export class UserService {
  /** Creates a user. */
  async createUser(name: string): Promise<User> {
${body}
    const id = makeId();
    return { id, name };
  }

  remove(id: string) { return id; }
}

export function makeId(): string { return 'x'; }
`);
sh('init', '-q', '-b', 'main'); sh('add', '.'); sh('commit', '-qm', 'base');
fs.mkdirSync(path.join(repo, 'node_modules'));
fs.symlinkSync(tsDir, path.join(repo, 'node_modules/typescript'));
// head = working tree: change deep inside createUser, whitespace-only change in remove, signature changes
write('src/user.ts', fs.readFileSync(path.join(repo, 'src/user.ts'), 'utf8')
  .replace('id: string; name: string }', 'id: string; name: string; email?: string }')
  .replace('const id = makeId();', "const id = makeId('u');")
  .replace('remove(id: string) { return id; }', 'remove(id: string) {\n    return id;\n  }')
  .replace("makeId(): string { return 'x'; }", "makeId(prefix: string): string { return prefix + 'x'; }"));
write('src/user.test.ts', "import { makeId } from './user';\ndescribe('makeId', () => {\n  it('prefixes', () => { makeId('a'); });\n});\n");

const port = 47000 + Math.floor(Math.random() * 1000);
const server = spawn(process.execPath, [path.join(import.meta.dirname, 'server.mjs'), 'main', '--port', String(port)], { cwd: repo, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((ok) => server.stdout.on('data', (d) => String(d).includes('http://') && ok()));
const get = async (p) => (await fetch(`http://127.0.0.1:${port}${p}`)).json();

try {
  const r = await get('/api/review');
  assert.deepEqual(r.files.map((f) => f.path), ['src/user.ts', 'src/user.test.ts'], 'code first, tests last');
  const [code, test] = r.files;
  assert.equal(test.testFor, 'src/user.ts');
  assert.equal(r.groups[test.group].collapsed, true);
  const sym = (side, p) => side.syms.find((s) => s.path === p);
  assert.equal(sym(code.new, 'UserService › createUser').kind, 'method');
  assert.equal(sym(code.old, 'UserService › remove').hash, sym(code.new, 'UserService › remove').hash, 'reformat is format-only');
  assert.notEqual(sym(code.old, 'makeId').hash, sym(code.new, 'makeId').hash);
  assert.ok(sym(test.new, 'describe("makeId") › it("prefixes")'), 'test blocks are symbols');
  assert.ok(code.new.cls.length > 0, 'highlighting');

  const line = code.new.text.split('\n').findIndex((l) => l.includes("makeId('u')")) + 1;
  const col = code.new.text.split('\n')[line - 1].indexOf('makeId');
  const q = (side, l, c) => `side=${side}&path=src/user.ts&line=${l}&col=${c}`;
  assert.match((await get(`/api/hover?${q('new', line, col)}`)).sig, /makeId\(prefix: string\): string/);
  const def = await get(`/api/def?${q('new', line, col)}`);
  assert.equal(def[0].path, 'src/user.ts');
  assert.match(code.new.text.split('\n')[def[0].line - 1], /export function makeId/);
  const oldLine = code.old.text.split('\n').findIndex((l) => l.includes('makeId()')) + 1;
  assert.match((await get(`/api/hover?${q('old', oldLine, code.old.text.split('\n')[oldLine - 1].indexOf('makeId'))}`)).sig, /makeId\(\): string/, 'base side has its own program');
  // hover inside a test file excluded by tsconfig still works
  assert.match((await get('/api/hover?side=new&path=src/user.test.ts&line=3&col=26')).sig, /makeId/);
  // file endpoint only serves files that are part of a program
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/file?side=new&path=../../etc/passwd`)).status, 404);

  const api = await get('/api/apidiff');
  const by = Object.fromEntries(api.map((a) => [a.name, a]));
  assert.match(by.User.after, /email\?: string/);
  assert.match(by.makeId.before, /\(\) => string/);
  assert.match(by.makeId.after, /\(prefix: string\) => string/);
  assert.equal(by.UserService, undefined, 'class surface unchanged');
  console.log('ok');
} finally {
  server.kill();
  fs.rmSync(repo, { recursive: true, force: true });
}
