# semreview: plan

A diff viewer for reviewing large TypeScript/JavaScript changes (often agent-written) by hand, for the parts
where agentic review is not enough: security, correctness, API design.

Status (2026-11-03): local proof of concept works, including GitHub-style PR/branch URLs over local repos.

## The problem

Text diffs (`git diff`, GitHub "Files changed") show *lines*, not *what changed*:

1. **No function context.** You can't see which function a hunk is in unless its declaration falls within the 3–5
   context lines. GitHub makes you click "expand up" repeatedly; large functions and files make it worse.
   Root cause, partly: the `@@ … @@ funcname` hint is a per-language regex, and **git has no built-in JS/TS
   pattern** (git 2.47 ships ada, bash, cpp, csharp, golang, java, kotlin, python, rust… but not javascript).
   TS falls back to "nearest line at column 0", usually the `class` line.
2. **No semantics.** You can't hover for a type or jump to a definition, so you open the branch in VS Code
   and end up with two windows (diff + code) for two versions.
3. **Bad order.** Tests sit next to code, so a linear review alternates code/test/code/test. Tests matter less
   for review and belong at the end, collapsed. Lockfiles and generated files should not be in the way at all.

## Research (2026-11-03)

Nothing found that does all three. What exists:

| Tool | Function context | Hover / go-to-def | Ordering / hide tests | Notes |
|---|---|---|---|---|
| GitHub "Files changed" | regex hunk header | click-to-definition (precise TS since 2024), no hover types | no | jumps away to the code browser |
| VS Code + GitHub Pull Requests ext | partial | full LSP on the new side | no, file by file | multi-diff editor; heavy, order fixed |
| Sourcegraph browser extension | no | hover + defs on GitHub PRs | no | needs a Sourcegraph instance + SCIP indexes; current status unclear |
| SemanticDiff (VS Code/GitHub), CodeRabbit "Semantic view" (May 2026) | moves/refactors, ignores formatting | no | no | less noise, no navigation |
| sem, tpt-semadiff, ataperata/semantic-diff | entity-level (function/class) diffs via tree-sitter | no | no | CLIs; good ideas to borrow |
| diffhub, difit, Plannotator, Glimpse | GitHub-style | no | file filter | local web viewers + comments handed to an agent; same shape, no semantics |
| ClankerDiff (jcarver989/diff) | ? | tree-sitter "definition cards" | ? | closest in spirit; heuristic, not LSP; 0 stars |
| DiffsHub (diffshub.com) | no | no | no | swap github.com→diffshub.com for a better view of public PRs; built on `@pierre/diffs` |

Unverified: whether VS Code's diff editor does sticky scroll (would fix #1 there); whether Sourcegraph's
extension is still maintained.

Sources:
[GitHub precise TS nav](https://github.blog/changelog/2024-03-14-precise-code-navigation-for-typescript-projects) ·
[GitHub code nav in PRs](https://github.blog/news-insights/product-news/precise-code-navigation-python-code-navigation-pull-requests/) ·
[Sourcegraph PR code nav](https://sourcegraph.com/blog/code-navigation-in-github-pull-requests) ·
[scip-typescript](https://sourcegraph.com/blog/announcing-scip-typescript) ·
[SemanticDiff](https://semanticdiff.com/) ·
[CodeRabbit Semantic Diff](https://www.coderabbit.ai/blog/introducing-semantic-diff) ·
[sem](https://github.com/ataraxy-labs/sem) ·
[tpt-semadiff](https://github.com/tpt-solutions/tpt-semadiff) ·
[ataperata/semantic-diff](https://github.com/ataperata/semantic-diff) ·
[diffhub](https://github.com/mblode/diffhub) ·
[difit](https://github.com/yoshiko-pg/difit) ·
[Plannotator](https://plannotator.ai/code-review/) ·
[Glimpse](https://github.com/dotbrains/glimpse) ·
[ClankerDiff symbol nav](https://github.com/jcarver989/diff/pull/110) ·
[@pierre/diffs](https://diffs.com/) ·
[DiffsHub](https://noqta.tn/en/blog/diffshub-pierre-virtualized-github-diff-viewer-2026) ·
[VS Code PR ext](https://github.com/microsoft/vscode-pull-request-github/releases/tag/v0.126.0) ·
[Reviewing agent PRs](https://github.blog/ai-and-ml/generative-ai/agent-pull-requests-are-everywhere-heres-how-to-review-them/)

### Zero-code stopgap for plain `git diff`

Tested: hunk headers show `async createUser(name: string): Promise<User> {` instead of `export class UserService {`,
and `if (…) {` lines are skipped.

```gitconfig
# ~/.gitconfig   (plus `*.ts *.tsx *.js *.mjs diff=ts`, one per line, in ~/.config/git/attributes)
[diff "ts"]
  xfuncname = "!^[ \t]*(if|for|while|switch|catch|with|else if)[ \t(]\n^[ \t]*(((export|default|async|declare|abstract|public|private|protected|static|readonly|get|set)[ \t]+)*(function\\*?|class|interface|enum|type|namespace)[ \t]+[A-Za-z_$].*|(export[ \t]+)?(const|let|var)[ \t]+[A-Za-z_$][A-Za-z0-9_$]*[^=]*=[ \t]*(async[ \t]+)?(function|\\(|[A-Za-z_$][A-Za-z0-9_$]*[ \t]*=>).*|((public|private|protected|static|async|override|readonly|get|set)[ \t]+)*[#A-Za-z_$][A-Za-z0-9_$]*[ \t]*(<[^>]*>)?\\(.*\\)[^;]*\\{[ \t]*)$"
```
`git diff -W` shows whole functions; `git diff main... -- . ':!*.test.*'` then `-- '*.test.*'` gives code first, tests last.

## Design

**Core decision: the TypeScript compiler API, not an editor.** The reviewed repo's own `typescript` package
gives a `LanguageService` per tsconfig: `getQuickInfoAtPosition` is hover, `getDefinitionAtPosition` is go-to-definition,
the checker gives exported signatures. No Monaco, no VS Code web view, no websocket LSP, no tree-sitter.
Memory is about one `tsc` per touched tsconfig, built lazily on first hover.

**A "side" is one version of the repo**: a commit (read via `git show`) or the working tree. The base side is the
merge-base. Both sides get their own programs; files that are not tracked (node_modules, generated
`.svelte-kit/` configs) come from disk for both, so no worktree or second `npm install` is needed.

Features, in the order they pay off:

1. **Per-symbol view.** Parse both versions, list declarations (functions, classes and members, consts,
   object-literal methods, `describe`/`it` blocks) with line ranges and a whitespace/comment-insensitive hash.
   Each hunk gets a sticky breadcrumb (`UserService › createUser`) plus the declaration line when it is scrolled
   out of view, and a "show whole function" button. The sidebar lists **changed symbols** (+ added, − removed,
   ~ modified, ≈ formatting only) instead of files.
2. **Review order.** Glob groups from `.semreview.json` (defaults: API surface & types → code → docs/config →
   tests, collapsed; lockfiles/snapshots/dist hidden). Test files are paired with their code file (same stem, or
   same basename across `src/` and `tests/`) and linked both ways.
3. **Hover and Ctrl/⌘-click** on both sides of the diff; definitions open in a side panel in the same page,
   with a back stack, and hover works there too.
4. **Exported API diff.** For each changed module, compare checker-printed signatures of its exports between
   base and head. Inferred return types count. This is the screen for API-design review.

## PoC: what exists

`server.mjs` (HTTP + review assembly), `git.mjs` (sides, changed files, hunks), `ts.mjs` (symbols, highlighting,
language services, API signatures), `index.html` (vanilla UI), `test.mjs` (self-check). No dependencies; Node ≥ 22.

```
cd some/ts/repo && node ~/Projects/semreview/server.mjs [base] [--head <ref>] [--port 4747]
TS_DIR=…/node_modules/typescript node ~/Projects/semreview/test.mjs
```

Tried on `~/Projects/feeds` (pnpm monorepo, 3 tsconfigs, Svelte app): 21 files, programs build in 0.5–1.7 s
each on first hover, hover/definition through import aliases, test↔code pairing, API diff of `HEAD~40..HEAD~2`
finds added `RateLimitError`/`isRateLimitError`.

Known limits (deliberate, see `ponytail:` comments):
- Semantics only for TS/JS; `.svelte`/`.vue` files get a plain diff.
- Unified view only; no split view.
- Whole changed files are sent to the browser; fine for hundreds of files, not thousands.
- Definition panel shows a 500-line window; multiple definitions → first one.
- Working-tree programs follow file edits (mtime); a *new* changed file needs a page reload.
- Project references / solution-style tsconfigs: changed files are still added, but references are not followed.
- `git show` per file for base programs; `git cat-file --batch` when it gets slow.

## Next (local)

- Comments on lines/symbols, stored in `.git/semreview-comments.json`, exported as a markdown prompt for an agent
  (diffhub/difit do this; cheap to add).
- "Reviewed" per symbol, not only per file; and reset it when the symbol's hash changes.
- Find references from the panel ("who calls this changed function?"), with call sites outside the diff.
- Move/rename detection between symbols (same hash, different path).
- Svelte/Vue via their language tools (svelte2tsx) if the team needs it.

## Done: GitHub-style URLs over local repos (2026-11-03)

Instead of cloning, the server maps URLs onto repos already under `~/Projects`, where `node_modules` and
`typescript` are installed: `/<repo>/pull/<n>`, `/<repo>/<branch>`, `/<repo>/`. Each page load fetches the PR or
branch and its base from origin (`refs/semreview/pull/<n>` for PRs; the PR's base via `gh pr view`). Reviews are
keyed by repo + exact commits (a new push is a new review), the last 3 are kept in memory. Only `localhost`
Host headers are answered (DNS rebinding), and URL paths cannot leave the projects dir.

Limits: dependency types come from whatever is installed in the checkout (if the PR bumps a package, hover shows
the old one); repos not under `~/Projects` are not served.

## Toward the team version: change the URL, get the view

Target: `https://review.<team-domain>/<owner>/<repo>/pull/<n>` is the same PR with this view; a bookmarklet
or a tiny browser extension rewrites `github.com` to it.

What the PoC already does right for this: sides can be two refs (`--head`), so a PR is just
`merge-base(base, refs/pull/N/head)` vs `refs/pull/N/head`; the server only serves files that are part of a
program (no arbitrary file reads); everything goes through four JSON endpoints.

To build:
1. **Route** `/:owner/:repo/pull/:n` → resolve the PR's base/head via the GitHub API → a review session.
2. **Repo cache**: one blobless mirror per repo (`git clone --mirror --filter=blob:none`), `git fetch` the PR refs
   on each visit. Sides read from it exactly as they do now.
3. **Dependencies for types**: node_modules per lockfile hash, installed with `--ignore-scripts` in a sandbox and
   shared across PRs with the same lockfile. Without them, types from packages show as `any`, but the
   in-repo navigation still works.
4. **Auth**: GitHub OAuth; only show a repo to users GitHub says can read it; the server's token is read-only.
   Type-checking does not execute repo code (language service plugins are not loaded outside tsserver), but
   the install step must stay sandboxed.
5. **Program lifetime**: LRU of language services per (repo, commit, tsconfig) with a memory cap; precompute on
   PR open via a webhook so the first hover is warm.
6. **Comments** go back to GitHub as review comments (line mapping is already there: hunks are git's own).

Open questions: self-host vs SaaS (code stays in-house → self-host); GitLab; whether to precompute SCIP indexes
so the hosted page can be static.
