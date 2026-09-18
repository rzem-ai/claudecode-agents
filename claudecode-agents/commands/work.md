---
description: Focus this checkout on one board item, so the hooks move that item as agents start and stop - the human's hand on what task_focus does for the lead
---

Focus this checkout on the board item given as the argument. The argument is an item id in any case (`bd-12`, `BD-12.3`), or nothing to show the current focus, or `clear` to forget it.

## Procedure

1. With an id: call the board MCP server's `task_focus` tool (`mcp__plugin_claudecode-agents_board__task_focus`) with `{id}`. It resolves the id, writes `.boards/.focus` in the main checkout, and returns `{focused}`. Print the canonical id and the item's title from `task_view`, in one line.
2. With `clear`: call `task_focus` with `{clear: true}` and say the focus is cleared.
3. With nothing: call `task_focus` with `{}` and print the focused id, or say that nothing is focused.
4. If the tool refuses the id, say the item is not on this board and stop; do not create one.
5. If the tool is not available, the board MCP server is not loaded in this session - the plugin is not enabled here, or the `board` binary is not built. Say which by checking whether `${CLAUDE_PLUGIN_ROOT}/board/board.sh --help` runs, and stop.

Never move the item's status. Focusing says which item the hooks move; the hooks do the moving.
