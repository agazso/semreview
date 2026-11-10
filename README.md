# semreview

Review a TypeScript/JavaScript branch by symbol, not by line: every hunk shows the function it is in, the
sidebar lists changed functions instead of files, hover shows types, Ctrl/⌘-click opens the definition next to
the diff, tests go last, and "API changes" compares exported signatures between base and head.

![screenshot](docs/screenshot.png)

```sh
node ~/Projects/semreview/server.mjs        # one server for every repo under ~/Projects
```

| URL | Reviews |
|---|---|
| `localhost:4747/snaha/swarm-id/pull/914` | GitHub PR #914: its base branch…its head (swap `https://github.com` for `http://localhost:4747`) |
| `localhost:4747/snaha/swarm-id/feat/some-branch` | default branch…that branch |
| `localhost:4747/snaha/swarm-id/` | default branch…the working tree, uncommitted changes included |
| `…?base=develop` | any of the above against another base |
| `localhost:4747/` | list of repos (or, when started inside a repo, that repo's working tree) |

The path is the repo's folder under `~/Projects`, matched case-insensitively. Every page load runs `git fetch`
for the branch or PR and its base, so you see what GitHub shows; PR heads are stored as
`refs/semreview/pull/<n>` (remove all with `git for-each-ref --format='%(refname)' refs/semreview | xargs -n1 git update-ref -d`).
The PR's base branch comes from `gh pr view`; without `gh` it falls back to the default branch.

Options: `--port 4747`, `--projects <dir>` (or `SEMREVIEW_PROJECTS=<dir>`); started inside a repo, `[base] [--head <ref>]` set what `/` shows.
Semantics use each repo's own `typescript` package (no install for semreview itself; Node ≥ 22). An optional
`.semreview.json` in a repo overrides groups and hidden files (see `DEFAULT_CONFIG` in `server.mjs`).

Self-check: `node test.mjs` (set `TS_DIR` to a `node_modules/typescript` directory).

Background, research and roadmap: [PLAN.md](PLAN.md).
