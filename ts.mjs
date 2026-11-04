// TypeScript semantics: symbols, highlighting, hover/definition, public API signatures.
// Uses the reviewed repo's own `typescript` package; semreview itself has no dependencies.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

export const TS_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

export function loadTs(root, hintDirs = []) {
  for (const dir of [root, ...hintDirs]) {
    try { return createRequire(path.join(dir, 'noop.js'))('typescript'); } catch {}
  }
  if (process.env.SEMREVIEW_TS) return createRequire(import.meta.url)(process.env.SEMREVIEW_TS);
  return null;
}

// Syntax highlighting: TS's own classifier, so templates/regex/JSX are right. Returns [start, length, kind]*.
export function makeClassifier(ts) {
  const files = new Map();
  let v = 0;
  const ls = ts.createLanguageService({
    getCompilationSettings: () => ({ allowJs: true, jsx: ts.JsxEmit.Preserve }),
    getScriptFileNames: () => [...files.keys()],
    getScriptVersion: (f) => files.get(f)?.v ?? '0',
    getScriptSnapshot: (f) => (files.has(f) ? ts.ScriptSnapshot.fromString(files.get(f).text) : undefined),
    getCurrentDirectory: () => '/',
    getDefaultLibFileName: () => '/lib.d.ts',
    fileExists: (f) => files.has(f),
    readFile: (f) => files.get(f)?.text,
  });
  return (fileName, text) => {
    const f = '/__syntax__/' + fileName;
    files.set(f, { text, v: String(++v) });
    try { return ls.getEncodedSyntacticClassifications(f, { start: 0, length: text.length }).spans; }
    finally { files.delete(f); }
  };
}

// Declarations in a file, with line ranges and a whitespace/comment-insensitive hash.
// Path segments are joined with ' › ' (test names may contain dots).
export function symbols(ts, fileName, text) {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const out = [];
  const line = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const hash = (node) => {
    const toks = [];
    const walk = (n) => {
      if (n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode) return;
      const kids = n.getChildren(sf);
      if (kids.length) kids.forEach(walk); else if (n.kind !== ts.SyntaxKind.EndOfFileToken) toks.push(n.getText(sf));
    };
    walk(node);
    return crypto.createHash('sha1').update(toks.join(' ')).digest('hex').slice(0, 12);
  };
  const add = (node, name, kind, parent) => {
    const p = parent ? `${parent} › ${name}` : name;
    // start includes JSDoc; decl is the line with the declaration itself
    out.push({ path: p, kind, start: line(node.getStart(sf, true)), decl: line(node.getStart(sf)), end: line(node.end), hash: hash(node) });
    return p;
  };
  const unwrap = (e) => {
    while (e && (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e))) e = e.expression;
    return e;
  };
  const isFn = (e) => e && (ts.isArrowFunction(e) || ts.isFunctionExpression(e));
  const nameOf = (n) => (n.name ? n.name.getText(sf) : null);

  const members = (cls, parent) => {
    for (const m of cls.members) {
      if (ts.isConstructorDeclaration(m)) add(m, 'constructor', 'method', parent);
      else if (ts.isMethodDeclaration(m)) add(m, nameOf(m), 'method', parent);
      else if (ts.isGetAccessor(m)) add(m, `get ${nameOf(m)}`, 'method', parent);
      else if (ts.isSetAccessor(m)) add(m, `set ${nameOf(m)}`, 'method', parent);
      else if (ts.isPropertyDeclaration(m)) add(m, nameOf(m), isFn(unwrap(m.initializer)) ? 'method' : 'property', parent);
      else if (ts.isClassStaticBlockDeclaration(m)) add(m, 'static {}', 'block', parent);
    }
  };
  // describe('x', () => {...}) / it('y', ...) / test(...)
  const testCall = (st) => {
    const e = ts.isExpressionStatement(st) && st.expression;
    if (!e || !ts.isCallExpression(e) || e.arguments.length < 2) return null;
    const a0 = e.arguments[0], fn = unwrap(e.arguments[e.arguments.length - 1]);
    if (!ts.isStringLiteralLike(a0) || !isFn(fn) || !/^(describe|it|test|suite|context|bench)\b/.test(e.expression.getText(sf))) return null;
    return { label: `${e.expression.getText(sf)}(${JSON.stringify(a0.text)})`, fn };
  };

  const visit = (stmts, parent, inTest) => {
    for (const st of stmts) {
      if (inTest) { // inside a test body only nested describe/it count, not its locals
        const t = testCall(st);
        if (t) { const p = add(st, t.label, 'test', parent); if (ts.isBlock(t.fn.body)) visit(t.fn.body.statements, p, true); }
        continue;
      }
      if (ts.isFunctionDeclaration(st)) add(st, nameOf(st) ?? 'default', 'function', parent);
      else if (ts.isClassDeclaration(st)) members(st, add(st, nameOf(st) ?? 'default', 'class', parent));
      else if (ts.isInterfaceDeclaration(st)) add(st, nameOf(st), 'interface', parent);
      else if (ts.isTypeAliasDeclaration(st)) add(st, nameOf(st), 'type', parent);
      else if (ts.isEnumDeclaration(st)) add(st, nameOf(st), 'enum', parent);
      else if (ts.isModuleDeclaration(st)) {
        const p = add(st, nameOf(st), 'namespace', parent);
        let b = st.body;
        while (b && ts.isModuleDeclaration(b)) b = b.body;
        if (b && ts.isModuleBlock(b)) visit(b.statements, p);
      } else if (ts.isVariableStatement(st)) {
        const ds = st.declarationList.declarations;
        for (const d of ds) {
          const init = unwrap(d.initializer), node = ds.length === 1 ? st : d, name = d.name.getText(sf);
          if (init && ts.isClassExpression(init)) members(init, add(node, name, 'class', parent));
          else if (init && ts.isObjectLiteralExpression(init)) {
            const p = add(node, name, 'object', parent);
            for (const pr of init.properties) {
              if (ts.isMethodDeclaration(pr) || (ts.isPropertyAssignment(pr) && isFn(unwrap(pr.initializer)))) add(pr, pr.name.getText(sf), 'method', p);
            }
          } else add(node, name, isFn(init) ? 'function' : 'const', parent);
        }
      } else if (ts.isExportAssignment(st)) add(st, 'export default', 'const', parent);
      else {
        const t = testCall(st);
        if (t) {
          const p = add(st, t.label, 'test', parent);
          if (ts.isBlock(t.fn.body)) visit(t.fn.body.statements, p, true);
        }
      }
    }
  };
  visit(sf.statements, null);
  return out;
}

const DEFAULT_OPTIONS = (ts) => ({
  allowJs: true, jsx: ts.JsxEmit.Preserve, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler, resolveJsonModule: true, skipLibCheck: true, noEmit: true,
});

// One language service per (side, nearest tsconfig.json). Created lazily: the first hover pays for it.
export class Projects {
  constructor(ts, side, changedRel) {
    this.ts = ts;
    this.side = side;
    this.changed = changedRel.filter((r) => TS_EXT.test(r)).map((r) => path.join(side.root, r));
    this.byConfig = new Map();
    const realpath = (f) => { try { return fs.realpathSync(f); } catch { return f; } };
    this.sys = {
      useCaseSensitiveFileNames: true,
      fileExists: (f) => side.existsAbs(f),
      readFile: (f) => side.readAbs(f),
      directoryExists: (d) => side.dirExistsAbs(d),
      getDirectories: (d) => side.entriesAbs(d).directories,
      realpath,
      getCurrentDirectory: () => side.root,
      // ponytail: ts.matchFiles is internal API (stable for years); replace if a TS release drops it
      readDirectory: (dir, exts, excl, incl, depth) =>
        ts.matchFiles(dir, exts, excl, incl, true, side.root, depth, (d) => side.entriesAbs(d), realpath),
    };
  }

  configFor(abs) {
    for (let d = path.dirname(abs); d.startsWith(this.side.root); d = path.dirname(d)) {
      for (const n of ['tsconfig.json', 'jsconfig.json']) if (this.side.existsAbs(path.join(d, n))) return path.join(d, n);
      if (d === this.side.root) break;
    }
    return null;
  }

  project(cfg) {
    const key = cfg ?? '(inferred)';
    if (this.byConfig.has(key)) return this.byConfig.get(key);
    const { ts, side, sys } = this;
    const t0 = Date.now();
    let options = DEFAULT_OPTIONS(ts), fileNames = [];
    if (cfg) {
      const parsed = ts.getParsedCommandLineOfConfigFile(cfg, {}, { ...sys, onUnRecoverableConfigFileDiagnostic: () => {} });
      if (parsed) ({ options, fileNames } = parsed);
    }
    // changed files that belong here but are excluded by the config (tests, often) are added anyway
    const extra = this.changed.filter((f) => this.configFor(f) === cfg && side.existsAbs(f));
    const names = [...new Set([...fileNames, ...extra])];
    const ls = ts.createLanguageService({
      ...sys,
      useCaseSensitiveFileNames: () => true, // a function here, a boolean for the config parser
      getCompilationSettings: () => options,
      getScriptFileNames: () => names,
      getScriptVersion: (f) => (side.ref ? '0' : side.mtime(f)),
      getScriptSnapshot: (f) => { const t = side.readAbs(f); return t === undefined ? undefined : ts.ScriptSnapshot.fromString(t); },
      getCurrentDirectory: () => (cfg ? path.dirname(cfg) : side.root),
      getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    }, ts.createDocumentRegistry());
    const p = { cfg, ls, program: () => ls.getProgram() };
    p.program();
    console.log(`[${side.label}] program ${cfg ? path.relative(side.root, cfg) : '(inferred)'}: ${names.length} roots, ${Date.now() - t0} ms`);
    this.byConfig.set(key, p);
    return p;
  }

  // The project whose program contains this file (only files in a program are ever served).
  find(abs) {
    const p = this.project(this.configFor(abs));
    if (p.program().getSourceFile(abs)) return p;
    for (const q of this.byConfig.values()) if (q.program().getSourceFile(abs)) return q;
    return null;
  }

  abs(rel) { return path.resolve(this.side.root, rel); }
  rel(abs) { return this.side.rel(abs) ?? abs; }

  at(rel, line, col) {
    const abs = this.abs(rel), p = this.find(abs);
    const sf = p?.program().getSourceFile(abs);
    if (!sf) return null;
    const starts = sf.getLineStarts();
    if (line < 1 || line > starts.length) return null;
    return { p, abs, pos: Math.min(starts[line - 1] + col, line < starts.length ? starts[line] : sf.text.length) };
  }

  hover(rel, line, col) {
    const a = this.at(rel, line, col);
    const info = a && a.p.ls.getQuickInfoAtPosition(a.abs, a.pos);
    if (!info) return null;
    const s = (parts) => this.ts.displayPartsToString(parts ?? []);
    return { sig: s(info.displayParts), doc: s(info.documentation), tags: (info.tags ?? []).map((t) => `@${t.name} ${s(t.text)}`) };
  }

  definition(rel, line, col) {
    const a = this.at(rel, line, col);
    const defs = (a && a.p.ls.getDefinitionAtPosition(a.abs, a.pos)) ?? [];
    return defs.map((d) => {
      const sf = a.p.program().getSourceFile(d.fileName);
      return { path: this.rel(d.fileName), line: sf ? sf.getLineAndCharacterOfPosition(d.textSpan.start).line + 1 : 1, name: d.name, kind: d.kind };
    });
  }

  file(rel) {
    const abs = this.abs(rel), p = this.find(abs);
    return p ? p.program().getSourceFile(abs).text : undefined;
  }

  // Exported names -> printed signature, from the type checker (so inferred types count).
  exportsOf(rel) {
    const { ts } = this;
    const abs = this.abs(rel), p = this.find(abs);
    const prog = p?.program(), sf = prog?.getSourceFile(abs);
    if (!sf) return null;
    const ch = prog.getTypeChecker(), F = ts.SymbolFlags;
    const mod = ch.getSymbolAtLocation(sf);
    if (!mod) return {};
    const out = {};
    for (const ex of ch.getExportsOfModule(mod)) {
      const s = ex.flags & F.Alias ? ch.getAliasedSymbol(ex) : ex;
      const decl = s.valueDeclaration ?? s.declarations?.[0];
      const T = (t) => ch.typeToString(t, decl, ts.TypeFormatFlags.NoTruncation);
      const members = (t) => ch.getPropertiesOfType(t)
        .filter((m) => !(ts.getDeclarationModifierFlagsFromSymbol(m) & ts.ModifierFlags.Private) && !m.name.startsWith('#'))
        .filter((m) => !m.declarations?.every((d) => prog.isSourceFileDefaultLibrary(d.getSourceFile()))) // inherited Error.message etc.
        .map((m) => `  ${m.name}${m.flags & F.Optional ? '?' : ''}: ${T(ch.getTypeOfSymbolAtLocation(m, decl))}`);
      let kind, sig;
      if (s.flags & F.Class) {
        kind = 'class';
        sig = [...ch.getTypeOfSymbolAtLocation(s, decl).getConstructSignatures().map((c) => `new ${ch.signatureToString(c)}`), ...members(ch.getDeclaredTypeOfSymbol(s))].join('\n');
      } else if (s.flags & F.Interface) { kind = 'interface'; sig = members(ch.getDeclaredTypeOfSymbol(s)).join('\n'); }
      else if (s.flags & F.TypeAlias) { kind = 'type'; sig = ch.typeToString(ch.getDeclaredTypeOfSymbol(s), undefined, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.InTypeAlias); }
      else if (s.flags & F.Enum) { kind = 'enum'; sig = (decl?.members ?? []).map((m) => m.getText()).join(', '); }
      else if (decl) { kind = s.flags & F.Function ? 'function' : 'const'; sig = T(ch.getTypeOfSymbolAtLocation(s, decl)); }
      else continue;
      out[ex.name] = { kind, sig: sig.replaceAll(this.side.root + '/', '') }; // import("/abs/...") -> repo-relative
    }
    return out;
  }
}

// JSON (package.json, tsconfig with comments): highlighting + a symbol per key holding an object or array,
// so the breadcrumb reads `dependencies` or `compilerOptions › paths`.
export function jsonData(ts, fileName, text) {
  const sf = ts.parseJsonText(fileName, text);
  const cls = [], syms = [];
  const line = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const span = (n, kind) => { const s = n.getStart(sf); cls.push(s, n.end - s, kind); };
  const K = ts.SyntaxKind, C = ts.ClassificationType;
  const walk = (n, parent) => {
    if (ts.isPropertyAssignment(n)) {
      span(n.name, C.jsxAttribute); // keys get the attribute color, values the string color
      const v = n.initializer;
      if (ts.isObjectLiteralExpression(v) || ts.isArrayLiteralExpression(v)) {
        const name = ts.isStringLiteral(n.name) ? n.name.text : n.name.getText(sf);
        const p = parent ? `${parent} › ${name}` : name;
        const s = line(n.getStart(sf));
        // ponytail: whitespace-stripped text as the hash; a space inside a string value counts as formatting
        syms.push({ path: p, kind: 'key', start: s, decl: s, end: line(n.end), hash: crypto.createHash('sha1').update(n.getText(sf).replace(/\s+/g, '')).digest('hex').slice(0, 12) });
        return walk(v, p);
      }
      return walk(v, parent);
    }
    if (n.kind === K.StringLiteral) span(n, C.stringLiteral);
    else if (n.kind === K.NumericLiteral) span(n, C.numericLiteral);
    else if (n.kind === K.TrueKeyword || n.kind === K.FalseKeyword || n.kind === K.NullKeyword) span(n, C.keyword);
    else ts.forEachChild(n, (c) => walk(c, parent));
  };
  walk(sf.statements[0]?.expression ?? sf, '');
  // comments: the scanner sees them, the tree does not
  const scan = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
  for (let t = scan.scan(); t !== K.EndOfFileToken; t = scan.scan()) {
    if (t === K.SingleLineCommentTrivia || t === K.MultiLineCommentTrivia) cls.push(scan.getTokenStart?.() ?? scan.getTokenPos(), scan.getTextPos() - (scan.getTokenStart?.() ?? scan.getTokenPos()), C.comment);
  }
  return { cls, syms };
}
