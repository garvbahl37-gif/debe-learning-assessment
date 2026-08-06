/**
 * `@debe/shared/mock` — fixture data and in-memory persistence.
 *
 * Kept behind its own entrypoint so nothing importing the real contract from
 * `@debe/shared` can reach fixture data by accident.
 */

export * from "./store";
