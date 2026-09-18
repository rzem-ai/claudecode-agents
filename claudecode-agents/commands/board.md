---
description: Start this session's board web UI if it is not running, on a random loopback port, and print its URL
---

Open the board for this session. The web UI is per Claude Code instance: it runs inside this session's own board MCP process, binds `127.0.0.1` on a port the kernel picks, and stops when the session ends. Nothing else depends on it - the task tools and the hooks read and write the task files directly whether or not it is up - so it exists only for the human to look at.

## Procedure

1. Call the `board_serve` tool on the board MCP server (`mcp__plugin_claudecode-agents_board__board_serve`). It starts the UI if it is not already running and returns `{running, url, host, port}`; a second call returns the same URL, so there is nothing to check first.
2. Print the URL on its own line, and say that it is loopback-only and ends with this session. Do not open a browser and do not run anything else.
3. If the tool is not available, the board MCP server is not loaded in this session, for one of three reasons: the plugin is not enabled here, the `board` binary is not built, or this repository has no `.boards/` yet - the server resolves the board at startup and refuses to start without one. Say which: `${CLAUDE_PLUGIN_ROOT}/board/board.sh --help` fails when the binary is missing, and `${CLAUDE_PLUGIN_ROOT}/board/board.sh task list` run in the repository says `no board here` when the board is. For the last, run `/claudecode-agents:init` and then start a new session, because MCP servers load at startup. Then stop. Do not start `board serve` from Bash as a substitute: a server outside the MCP process outlives the session and answers to nobody.

Never bind it to another interface from here. The override for a board that must be reachable from elsewhere is `board serve --host <interface> --port <n>` run deliberately, outside a session, by the human.
