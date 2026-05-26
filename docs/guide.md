# Guide

> This guide is fleshed out in milestone M8. It covers worlds, the virtual clock,
> scenarios & provenance, generators, freezing fixtures, and integrating with
> `@dpup/meshcore-ts`'s `MeshCoreClient`.

## Concepts

`meshcore-sim` gives you three things:

- A **world** — a static snapshot of a mesh as observed through the home node
  (nodes, channels, contacts), built with `defineWorld` or `generateWorld`.
- A **scenario** — a timeline of events the world produces (messages arriving,
  nodes going offline, telemetry, adverts), built by hand or with `traffic.*`.
- A **virtual clock** (`SimClock`) the test controls, so time-domain logic runs
  instantly and deterministically.

`SimConnection` ties them together behind the raw `@liamcottle/meshcore.js`
`Connection` interface, so a real `MeshCoreClient` (or any meshcore.js-based app)
runs against a simulated mesh.

See the [API reference](./api.md) for full signatures.
