/**
 * @file Sandbox dev server. Bundles the two browser entries (`stage.ts`, `controller.ts`) with `Bun.build`
 * — TypeScript, node_modules resolution, and the lazy `import("trystero/nostr")` code-split all handled —
 * then serves the static HTML + the built `/dist` assets over `Bun.serve`. Run it with `bun run sandbox`
 * (or `bun sandbox/serve.ts`); the Playwright e2e config reuses it as its `webServer`.
 *
 * Intentionally dependency-free (only Bun globals): it must run in the Bun server runtime, so it never
 * imports the browser-only `shared.ts`. The port is read from `$PORT` (default 5179, matching the e2e
 * config's expectation).
 */

const ROOT = import.meta.dir;
const PORT = Number(process.env.PORT ?? 5179);

// Room's plugins import `createPlugin` from `@moku-labs/web/browser` (the DOM-safe entry), so a plain
// browser-targeted Bun.build resolves cleanly — NO bundler alias and NO `external` are needed. This is the
// whole point of the fix that made Room browser-turnkey: a real consumer bundles it the same way, with no
// special config. (Previously the plugins imported the MAIN entry, which dragged the native
// `@resvg/resvg-js` + lazy `mermaid-isomorphic` and required an alias here — see findings.md §5.9.x.)
const result = await Bun.build({
  entrypoints: [`${ROOT}/stage.ts`, `${ROOT}/controller.ts`],
  outdir: `${ROOT}/dist`,
  target: "browser",
  splitting: true,
  sourcemap: "linked",
  naming: { entry: "[name].js", chunk: "[name]-[hash].js", asset: "[name]-[hash][ext]" }
});

if (!result.success) {
  console.error("sandbox build failed:");
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// Static page routes → file on disk; everything else (CSS, /dist/*) is resolved relative to this folder.
const PAGES: Record<string, string> = {
  "/": "index.html",
  "/stage": "stage.html",
  "/controller": "controller.html"
};

const server = Bun.serve({
  port: PORT,
  async fetch(request) {
    const { pathname } = new URL(request.url);
    const relative = PAGES[pathname] ?? pathname.replace(/^\/+/, "");
    const file = Bun.file(`${ROOT}/${relative}`);

    if (await file.exists()) return new Response(file);
    return new Response("Not found", { status: 404 });
  }
});

console.info(`Room sandbox running at ${server.url}`);
console.info(`  Stage:      ${server.url}stage`);
console.info(`  Controller: ${server.url}controller`);
