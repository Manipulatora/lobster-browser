/**
 * @lobster/shared-types — the single shared vocabulary for Lobster Browser.
 *
 * Every other package (desktop UI, backend, local API, engine-runner sidecar)
 * imports its domain types from here so the wire contracts never drift.
 */
export * from './engine.js';
export * from './fingerprint.js';
export * from './proxy.js';
export * from './profile.js';
export * from './mobile.js';
export * from './account.js';
export * from './api.js';
export * from './ipc.js';
