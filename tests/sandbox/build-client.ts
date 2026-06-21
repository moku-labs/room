/**
 * @file Sandbox client bundler. Bundles the two browser entries (`stage.ts`, `controller.ts`) with
 * `Bun.build` — TypeScript, node_modules resolution, and the lazy `import("trystero/nostr")` code-split all
 * handled — emitting the built JS into `tests/sandbox/dist/`. Extracted from `serve.ts` so BOTH consumers
 * use one build: the Bun static dev server (`serve.ts`, `bun run sandbox`) AND the worker harness, whose
 * `wrangler dev` serves this folder through the `ASSETS` binding (`bun run sandbox:worker`). Run it directly
 * (`bun tests/sandbox/build-client.ts`) to rebuild the assets before booting `wrangler dev`.
 *
 * Intentionally dependency-free (only Bun globals): it must run in the Bun runtime, so it never imports the
 * browser-only `shared.ts`.
 *
 * Room's plugins import `createPlugin` from `@moku-labs/web/browser` (the DOM-safe entry), so a plain
 * browser-targeted `Bun.build` resolves cleanly — NO bundler alias and NO `external` are needed. This is the
 * whole point of the fix that made Room browser-turnkey: a real consumer bundles it the same way, with no
 * special config (see findings.md §5.9.x).
 * @see ./serve.ts
 * @see ./wrangler.jsonc
 */

/** Absolute path of this folder — the sandbox root that holds the HTML + the built `/dist` assets. */
const ROOT = import.meta.dir;

/**
 * Bundles the `stage.ts` + `controller.ts` browser entries into `tests/sandbox/dist/`, throwing on a build
 * failure (with the bundler logs in the message) so a caller — the dev server or the `wrangler dev`
 * pre-step — never serves stale or missing assets.
 *
 * @returns A promise that resolves once both entries are written to `dist/`.
 * @throws {Error} If the `Bun.build` reports any error (the bundler logs are folded into the message).
 * @example
 * ```ts
 * await buildSandboxClient(); // dist/stage.js + dist/controller.js are now fresh
 * ```
 */
export async function buildSandboxClient(): Promise<void> {
  const result = await Bun.build({
    entrypoints: [`${ROOT}/stage.ts`, `${ROOT}/controller.ts`],
    outdir: `${ROOT}/dist`,
    target: "browser",
    splitting: true,
    sourcemap: "linked",
    naming: { entry: "[name].js", chunk: "[name]-[hash].js", asset: "[name]-[hash][ext]" }
  });

  if (!result.success) {
    const detail = result.logs.map(String).join("\n");
    throw new Error(`sandbox client build failed:\n${detail}`);
  }
}

// Run standalone (`bun tests/sandbox/build-client.ts`) — the `wrangler dev` harness builds the assets this
// way before booting, since wrangler serves the folder statically rather than bundling the client itself.
if (import.meta.main) {
  await buildSandboxClient();
  console.info("Room sandbox client built → tests/sandbox/dist/"); // @log-sink
}
