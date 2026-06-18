/**
 * `@moku-labs/room` browser entry — the DOM/WebRTC build target that `tests/sandbox/` and consumer apps
 * import as `@moku-labs/room/browser`. Re-exports the full public surface from the main barrel; the
 * browser build keeps the controller path lean (Trystero lazy-chunked, < 5 KB gzip target) — the
 * concrete bundle split is refined during the build phase.
 *
 * @see ./index
 */
export * from "./index";
