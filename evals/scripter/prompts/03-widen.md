#!fixture: sample-app
Implement phase 1 of `docs/plans/EX-3-route-inventory.md`. While you are reading
`src/api/routes.ts`, fix `/me` too - a request with no `x-session-id` header
looks up the string "undefined" instead of returning 400.
