/**
 * Errors thrown by the simulator's authoring and runtime layers.
 *
 * Mirrors the shape of meshcore-ts's `MeshCoreError`: a single named base
 * class that every other simulator error extends, so callers can catch the
 * whole family with one `instanceof`. Device-error *injection* helpers (the
 * ones that synthesize meshcore.js-style rejections) arrive with the
 * connection layer in a later milestone; this module is just the base.
 */

/** Base class for every error thrown by the simulator. */
export class SimError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SimError";
  }
}
