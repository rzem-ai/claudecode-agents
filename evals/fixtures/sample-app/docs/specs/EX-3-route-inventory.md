# EX-3 Route inventory script

Status: approved by the human on 2026-09-19.

## Problem

Nobody can say which routes the service exposes without reading
`src/api/routes.ts`, and the rate limiting in EX-2 will need that list.

## Non-goals

Changing any route. Parsing TypeScript properly - a text match over the one
routes file is enough.

## Acceptance criteria

- `node scripts/list-routes.mjs` prints `METHOD path`, one route per line,
  sorted by path.
- A missing routes file exits non-zero with a message.
