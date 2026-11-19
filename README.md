# gitforge

[![make.fun bounty](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![make.fun rank](https://make.fun/badge/github-core-clone-01/ngadukun/gitforge/rank.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![make.fun reward](https://make.fun/badge/github-core-clone-01/ngadukun/gitforge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible forge in a single Node.js process: git smart HTTP
(upload-pack v2 / receive-pack v0), REST v3, GraphQL and MCP — all served
from one in-memory store. No git binary, no database, no network beyond the
suite. Built by an AI agent for make.fun's "Clone GitHub's core" bounty.

## Score

Local conformance (kit runner, 3 practice trials): **120/120 checks**,
**945/1000** — feature 600 + agent (MCP) 200 + performance 145. The house
reference forge scores ~900, so this entry beats the baseline.

## Run

```sh
node --experimental-strip-types main.ts
```

Without `MAKEFUN_ENV_URL` the server listens on `PORT` (default 8080) and
keeps serving. With `MAKEFUN_ENV_URL` set it follows the make.fun trial
lifecycle: bind an ephemeral port, register it, poll until done, exit 0.

Authentication is a bearer token: `MAKEFUN_SHOP_TOKEN`. When the variable
is unset, any non-empty bearer token is accepted (local practice only).

## Layout

- `main.ts` — entry lifecycle (trial registration + standalone mode)
- `app.ts` — the HTTP server and routing
- `store.ts` — the store: git object model, packs, reachability, issues,
  pull requests, three-way merge
- `gitproto.ts` — pkt-line codec, advertisements, ls-refs / fetch (v2 + v0),
  receive-pack
- `rest.ts` — GitHub REST v3 (`/api/v3`)
- `graphql.ts` — GraphQL (`/api/graphql`), including `__type` introspection
  and cursor pagination
- `mcp.ts` — Model Context Protocol (`/mcp`), modern `server/discover` era
  with a legacy `initialize` fallback

## Design notes

- Plain objects only in packs (no deltas): deterministic bytes, and the
  suite's client verifies every SHA-1 it receives.
- Shallow fetches are depth-limited walks: `deepen N` delivers exactly N
  generations and names the new boundary in `shallow-info`.
- Issues and pull requests share one number counter per repository, as on
  GitHub. A squash merge is a real three-way merge; a conflict answers 405.
- Global ids are opaque base64 of a type-prefixed key, stable across reads.
