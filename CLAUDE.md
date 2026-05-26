# CLAUDE.md

Project guidance for Claude Code lives in **[AGENTS.md](./AGENTS.md)** — read it
first. It covers the architecture, the `Connection` contract, the layout, and
conventions.

## TL;DR

- A deterministic, behavioral MeshCore **test** simulator. `SimConnection` is a
  drop-in for a raw `@liamcottle/meshcore.js` `Connection`, consumed by
  `@dpup/meshcore-ts`'s `MeshCoreClient`. The grown-up form of a connection stub.
- Model observable behavior, **never** RF physics, real crypto, or a digital twin.
- Verify changes with: `bun run typecheck` · `bun run test` · `bun run build`.
- ESM-only, Node ≥ 18, `NodeNext`, `verbatimModuleSyntax`, `strict` — use `.js`
  import extensions and split `import type` / `export type`.

## Key exports

- `defineWorld` / `node` / `channel` / `contact` — world builders.
- `generateWorld` — procedural world generator (seeded, deterministic).
- `SimClock` + `Clock` interface — the virtual clock the app injects.
- `SimConnection` + `asConnection()` — the raw `Connection` drop-in.
- `scenario` / `at` + `SimEvent` kinds — the dynamic-fixture timeline.
- `traffic.burst` / `crosstalk` / `quiet` / `outOfOrder` — scenario generators.
- `serializeWorld` / `loadWorld` / `serializeScenario` / `loadScenario` — freeze fixtures.
- `SimError`, `ChannelKind`, `NodeRole` — supporting types and errors.

## Don't-regress list (details in AGENTS.md)

1. Messages flow through the **device-queue model** (`MsgWaiting` +
   `getWaitingMessages()`), never pushed directly.
2. `SimConnection` speaks **`Raw*` shapes + numeric push codes** at the boundary
   (`Uint8Array` keys, epoch seconds) — meshcore-ts normalizes them.
3. **Deterministic**: same seed ⇒ identical fixtures, byte for byte. No
   `Date.now()`/`setTimeout`; time comes from `SimClock`.
4. Keep verified vs. unverified channel traffic distinct (the provenance table).
5. `sentAt` on `MessageEvent`/`ChannelMessageEvent` overrides `senderTimestamp`
   in the encoded shape — the `outOfOrder` model. Don't conflate with `at`.
