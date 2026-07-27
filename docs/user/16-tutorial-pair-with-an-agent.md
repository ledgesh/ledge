# Tutorial: Pair with an Agent

Get an AI agent working inside your notes, three ways: a conversation in a note's terminal, one-shot prompt fences, and capture from anywhere.

This builds on [[Agents and Ledge]]. The examples use Claude Code, but any MCP-speaking CLI works.

## 1. Connect the agent

Install the shell command with "Install Shell Command (ledge)" in the palette, then connect the agent to Ledge's MCP server:

```sh
claude mcp add ledge -- ledge mcp
```

## 2. Talk to an agent in a note

Open a note you are working on, press ⌃` for its terminal drawer, and start `claude`.

The terminal belongs to the note, so the agent already knows what "here" means. Ask it to "read this note and tell me what's missing", "add a section comparing the two options above", or "find my other notes that mention this design". No paths, and no copying text into a chat window. Edits land in the file you are looking at, live.

Use this for working sessions: you write, the agent reads and reacts, and everything it adds is in your note when the session ends rather than in a chat log.

## 3. Turn repeated asks into prompt fences

For an instruction you give repeatedly, write it into the note as a `prompt` fence and it becomes a button. A meeting note might end with:

```
Extract every action item from this note into a checklist under a new "Actions" heading, with owners in bold.
```

Give that fence the `prompt` language and after every meeting it is one ⌘↩.

The fence runs one-shot: the agent acts and reports rather than asking questions, so write the instruction with the decisions already made.

Fences work in templates too ([[Daily Notes and Templates]]). A template carrying a fence gives every stamped note a built-in agent action, like the morning briefing in [[Tutorial: A Daily Workflow]].

## 4. Capture from anywhere

An agent that can run shell commands can work your notes with the CLI alone, with no MCP setup ([[The ledge CLI]]).

Tell a Claude Code session in any project to "append what we just decided to my Decisions note" and `ledge append` gets it there. `ledge search` and `ledge cat` let it check your notes before answering. Your notes become memory that outlives any one session.

## The boundaries

Agents can read and write notes but never delete them. The trash and Undo stay yours, in the app.

A locked note's body is invisible to every agent surface ([[Note Locking]]). Lock the notes you want kept out of the loop.
