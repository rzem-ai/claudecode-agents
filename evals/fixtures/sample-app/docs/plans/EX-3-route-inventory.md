# EX-3 Route inventory script - plan

Status: approved by the human on 2026-09-20.

## Phase 1 - the script

Add `scripts/list-routes.mjs`, which reads `src/api/routes.ts` as text and
prints `METHOD path` for every `app.<method>("<path>"` call, sorted by path.
Nothing under `src/` changes. Tests: the fixture's two routes come out as
`GET /me` and `POST /sessions/refresh`, in that order, and a missing file exits
non-zero.
