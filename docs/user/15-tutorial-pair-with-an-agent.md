# Tutorial: Pair with an Agent

This tutorial gets an AI agent working inside your notes, three ways: a conversation in a note's terminal, one-shot prompt fences, and agent-driven capture from anywhere. It builds on [[Agents and Ledge]]; the examples use Claude Code, but any MCP-speaking CLI fits.

## One-time setup

Install the shell command ("Install Shell Command (ledge)" in the palette), then connect the agent to Ledge's MCP server:

```sh
claude mcp add ledge -- ledge mcp
```

## Way one: talk in the note

Open any note you are working on and press ⌃` for its terminal drawer, then start `claude`. Because the terminal belongs to the note, the agent already knows what "here" means: ask "read this note and tell me what's missing", "add a section comparing the two options above", "find my other notes that mention this design". No paths, no copying text into a chat window; the note is the shared context, and edits land in the file you are looking at, live.

This is the mode for working sessions: you write, the agent reads and reacts, and everything it adds is in your note when the session ends, not in a chat log.

## Way two: prompt fences

For asks you make repeatedly, write them into the note as a `prompt` fence and they become a button. A meeting note might end with:

```
Extract every action item from this note into a checklist under a new "Actions" heading, with owners in bold.
```

Give that fence the `prompt` language, and after every meeting it is one ⌘↩. The fence runs one-shot: the agent acts and reports rather than asking questions, so write the instruction with the decisions already made.

Fences compose with templates ([[Daily Notes and Templates]]): a template that carries a fence gives every stamped note a built-in agent action, like the morning-briefing example in [[Tutorial: A Daily Workflow]].

## Way three: capture from anywhere

An agent that can run shell commands can work your notes with the CLI alone, no MCP needed ([[The ledge CLI]]). A Claude Code session in any project can be told "append what we just decided to my Decisions note" and `ledge append` gets it there; `ledge search` and `ledge cat` let it check your notes before answering. Your notes become memory that outlives any one session.

## The boundaries

Worth knowing before you lean in: agents can read and write notes but never delete them (the trash and Undo stay yours, in the app), and a locked note's body is invisible to every agent surface no matter what ([[Note Locking]]). So the notes you want kept out of the loop just get locked, and everything else is fair game.
