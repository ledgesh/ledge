# Ledge

The notebook for developers and DevOps, on macOS. Ledge runs code and commands
straight from your Markdown: write a note, then run a fenced block in place and
watch its output stream in beneath it.

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

Requires [Bun](https://bun.sh) and Xcode: every build compiles the PTY
trampolines against the macOS SDK (`scripts/build-native.ts`) and the app icon
with `actool`. The first `electrobun dev` downloads the Electrobun core
(~27 MB) and assembles a real `.app` under `build/`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The normative standards live in
`docs/contributor/`: [architecture](docs/contributor/architecture.md),
[interactions](docs/contributor/interactions.md),
[locking](docs/contributor/locking.md), and
[testing](docs/contributor/testing.md). The end-user manual (the same pages
the app ships as its built-in docs) lives in [docs/user/](docs/user).

## License

[Apache License 2.0](LICENSE). Copyright 2026 Dan Stevens.
