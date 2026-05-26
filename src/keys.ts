/**
 * Deterministic node-key derivation.
 *
 * Every {@link import("./world.js").SimNode} needs a 32-byte public key so that
 * contacts, messages and adverts can reference *real* keys that line up across
 * a world. The simulator does no real cryptography (PRD §4) — it only needs a
 * key that is **stable and unique per node id**, so reads are internally
 * consistent and reproducible.
 *
 * Derivation is therefore a plain hash of the id, with **no seed**: the same id
 * always yields the same key, in every world and on every run. This is
 * deliberately distinct from `random.ts` — that PRNG adds seeded *variety*;
 * this adds seedless *identity*.
 *
 * The hash is FNV-1a expanded with an xorshift mixer, run forward to fill all
 * 32 bytes. It is not cryptographic and is never used as such.
 */

import { toHex } from "@dpup/meshcore-ts";

/** Length of a derived public key, in bytes (matches a MeshCore Ed25519 key). */
const KEY_BYTES = 32;

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * Derive a stable 32-byte public key for a node id, as lowercase hex.
 *
 * Same id ⇒ same 64-character hex string, every run, with no seed. Different
 * ids produce different keys with overwhelming probability.
 */
export function deriveNodeKey(id: string): string {
  // Seed an FNV-1a hash from the id bytes, then run an xorshift mixer forward
  // to expand the 32-bit state into a full 32-byte key. Each byte advances the
  // state, so the whole key depends on the whole id.
  let h = FNV_OFFSET_BASIS;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i) & 0xff;
    h = Math.imul(h, FNV_PRIME);
  }

  const out = new Uint8Array(KEY_BYTES);
  let state = h >>> 0;
  for (let i = 0; i < KEY_BYTES; i++) {
    // xorshift32
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    out[i] = state & 0xff;
  }

  return toHex(out);
}
