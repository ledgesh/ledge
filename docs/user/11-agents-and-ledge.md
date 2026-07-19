# Agents and Ledge

Ledge is built to be worked by AI agents as well as by you. An agent CLI like Claude Code can read, search, create, and edit your notes through Ledge's MCP server, a terminal launched inside a note already knows which note it is sitting in, and a `prompt` code fence turns a paragraph of instructions into a runnable block.

## Connecting an agent

Ledge ships an MCP server: `ledge mcp` serves it on stdio (install the `ledge` command first; see [[The ledge CLI]]). Any MCP-speaking agent can use it; for Claude Code it is one line:

```sh
claude mcp add ledge -- ledge mcp
```

The tools it exposes: `list_workspaces`, `list_notes`, `read_note`, `search_notes`, `backlinks`, `tags`, `create_note`, `daily_note`, `append_note`, and `edit_note`. Notes are addressed by title, which survives renames, so an agent's references do not go stale. Every tool goes through the same store and the same path guards as the app itself, and two boundaries hold by construction: there is no delete tool, and locked notes refuse their bodies to every agent surface, always (see [[Note Locking]]).

## "This note" just works

Every shell a note spawns carries two facts in its environment: `LEDGE_NOTE`, the note's own file, and `LEDGE_WORKSPACE`, its workspace folder. An agent launched in a note's terminal drawer picks these up through the MCP server, so "summarize this note" or "add a TODO section here" needs no explanation of what "this" means: `read_note` with no arguments reads the note the terminal belongs to, `append_note` and `edit_note` default to it, and `create_note` lands in its workspace.

So the workflow can be exactly this: open the note you are working in, press ⌃` for its terminal, start your agent, and talk about "this note" and "this workspace" in plain words.

## Prompt fences

A fenced block whose language is `prompt` is an agent run. Write instructions in it, press ⌘↩, and the block's text is piped to the agent CLI in one-shot mode, with the output streaming into the panel below like any other run (see [[Running Code]]). This one is safe to try right here, if you have Claude Code installed and connected:

```prompt
Read this note and reply with a one-sentence summary of what prompt fences do.
```

In your own notes the instructions can also change things: "append a Next steps section to this note", "create a note titled Retro from what we discussed above".

Because the block runs from the note's own shell, the agent inherits the note's cwd, env, and the this-note facts above, so instructions can say "this note" and mean it. Expect a quiet pause before the answer appears: one-shot mode thinks first and prints once. And since nobody is there to answer follow-up questions, the agent is told up front to act and report rather than ask.

By default the fence runs Claude Code (`claude -p`) with Ledge's own tools pre-authorized, since a non-interactive run has no one to click "allow". The command is just an interpreter entry in Settings (⌘,) under `blocks.interpreters`, key `prompt`: point it at any CLI that reads its prompt on stdin to switch agents.

Templates compose with this: a daily template carrying a prompt fence like `Summarize [[{{yesterday}}]]` gives every day's note a one-keystroke morning briefing (see [[Daily Notes and Templates]]).

## What agents see and do not see

Agents see titles, bodies, tags, and links of ordinary notes, and they can read this manual too, so "check the Ledge docs" is a fair instruction. What they never see is the body of a locked note: reads refuse with an explanation, searches skip them and say how many they skipped, and listings flag them so an agent can plan around it. Deletion stays yours alone, in the app, where the trash and Undo live.
