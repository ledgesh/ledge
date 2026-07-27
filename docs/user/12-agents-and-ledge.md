# Agents and Ledge

Ledge is built to be worked by AI agents as well as by you. An agent CLI such as Claude Code can read, search, create, and edit your notes through Ledge's MCP server. A terminal launched inside a note already knows which note it is in, and a `prompt` code fence turns a paragraph of instructions into a runnable block.

## Connect an agent

Ledge ships an MCP server. `ledge mcp` serves it on stdio, so install the `ledge` command first (see [[The ledge CLI]]). Any MCP-speaking agent can use it. For Claude Code it is one line:

```sh
claude mcp add ledge -- ledge mcp
```

The server exposes ten tools:

| Read | Write |
| --- | --- |
| `list_workspaces`, `list_notes`, `read_note`, `search_notes`, `backlinks`, `tags` | `create_note`, `daily_note`, `append_note`, `edit_note` |

Notes are addressed by title, which survives renames, so an agent's references do not go stale. Every tool goes through the same store and the same path guards as the app.

Two boundaries hold in every case: there is no delete tool, and locked notes refuse their bodies to every agent surface (see [[Note Locking]]).

## Agents know which note they are in

Every shell a note spawns carries two environment variables: `LEDGE_NOTE`, the note's file, and `LEDGE_WORKSPACE`, its workspace folder. An agent launched in a note's terminal drawer picks these up through the MCP server:

- `read_note` with no arguments reads the note the terminal belongs to.
- `append_note` and `edit_note` default to that note.
- `create_note` lands in its workspace.

So "summarize this note" or "add a TODO section here" needs no explanation of what "this" means. Open the note you are working in, press ⌃` for its terminal, start your agent, and talk about "this note" and "this workspace" in plain words.

## Prompt fences

A fenced block whose language is `prompt` is an agent run. Write instructions in it and press ⌘↩. The block's text is piped to the agent CLI in one-shot mode, and the output streams into the panel below like any other run ([[Running Code]]).

Try this one if you have Claude Code installed and connected:

```prompt
Read this note and reply with a one-sentence summary of what prompt fences do.
```

In your own notes, instructions can change things: "append a Next steps section to this note", or "create a note titled Retro from what we discussed above".

The block runs from the note's own shell, so the agent inherits the note's `cwd`, `env`, and the environment variables above.

Two things to expect. There is a pause before the answer appears, because one-shot mode thinks first and prints once. And since nobody is present to answer follow-up questions, the agent is instructed to act and report rather than ask.

By default the fence runs Claude Code (`claude -p`) with Ledge's own tools pre-authorized, because a non-interactive run has no one to click "allow". The command is an interpreter entry in Settings (⌘,) under `blocks.interpreters`, key `prompt`. Point it at any CLI that reads its prompt on stdin to switch agents.

A daily template carrying a prompt fence such as `Summarize [[{{yesterday}}]]` gives every day's note a one-keystroke briefing (see [[Daily Notes and Templates]]).

## What agents cannot see

Agents see the titles, bodies, tags, and links of ordinary notes. They can read this manual too, so "check the Ledge docs" is a fair instruction.

They never see the body of a locked note. Reads refuse with an explanation, searches skip locked notes and report how many they skipped, and listings flag them so an agent can plan around it.

Deletion is yours alone, in the app, where the trash and Undo live.
