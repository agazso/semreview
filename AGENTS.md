# Agent Guidelines

## Architecture

Read [PLAN.md](PLAN.md) before changing the design: it covers the problem, the design and what the PoC does.

## Dependencies

None, and keep it that way: Node ≥ 22 stdlib only. TypeScript is loaded from the reviewed repo's own
`node_modules`, never installed here.

- `node server.mjs` - Run the server (see README for options)
- `TS_DIR=path/to/node_modules/typescript npm test` - Run the self-check

## Code Style

- Prefer `const` over `let` whenever the variable is not reassigned

## Commits

- Conventional commits, lowercase, imperative: `fix: one sticky breadcrumb per symbol`.
- One commit per change — squash, don't stack fixups.
- Subject only. Add a body just when the _why_ isn't obvious from the diff, and keep
  it to a few wrapped lines.
- No `Co-Authored-By`, no `Generated with Claude Code`, no session links, no emoji.

## Modules

- Use ESM `import`, not CommonJS `require` — in source, scripts, and ad-hoc
  verification snippets (e.g. `node --input-type=module -e "import { symbols } from './ts.mjs'"`).
