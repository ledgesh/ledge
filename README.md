# Ledge

Runnable Markdown notes for macOS. Write notes with fenced code blocks, then run
a block in place and see its output stream in beneath it. The shell is a real
persistent session, so state carries from one block to the next.

Built with [Electrobun](https://electrobun.dev): a Bun main process drives the
shell over a bun:ffi PTY, and the editor is CodeMirror in a system WebView, wired
to Bun over a typed RPC channel.

## Stack

- **Bun main process** (`src/bun`): the FFI PTY (`pty.ts`), OSC 133 marker parser
  (`markers.ts`), and the window + RPC wiring (`index.ts`).
- **View** (`src/mainview`): React + Tailwind + shadcn/ui chrome, with the
  CodeMirror editor (`editor/`) mounted inside it. Vite builds it to `dist/`.
- **Shared** (`src/shared`): the typed RPC contract between the two.

## Develop

```sh
bun install
bun run start      # vite build, then launch the app (electrobun dev)
bun run dev:hmr    # same, with a Vite dev server for hot module reload
bun run build      # production build
```

Requires [Bun](https://bun.sh). The first `electrobun dev` downloads the
Electrobun core (~27 MB) and assembles a real `.app` under `build/`.
