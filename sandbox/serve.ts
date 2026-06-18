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

// The Room library source imports `createPlugin` from `@moku-labs/web` (the MAIN entry, D1), which drags
// in the full SSG graph — including the native `@resvg/resvg-js` (.node) OG-image renderer and other
// server-only code that cannot be bundled for the browser. The `/browser` entry exports the SAME
// `createPlugin` but is DOM-safe, so we alias the bare `@moku-labs/web` specifier to it at bundle time.
// FINDING (see ../.planning/build/findings.md): a real Room consumer bundling for the browser must do the
// same; the library would be more turnkey if its plugins imported `createPlugin` from `@moku-labs/web/browser`.
const webBrowserEntry = Bun.resolveSync("@moku-labs/web/browser", ROOT);
const aliasWebToBrowser = {
  name: "alias-web-to-browser",
  setup(build: Bun.PluginBuilder) {
    build.onResolve({ filter: /^@moku-labs\/web$/ }, () => ({ path: webBrowserEntry }));
  }
};

const result = await Bun.build({
  entrypoints: [`${ROOT}/stage.ts`, `${ROOT}/controller.ts`],
  outdir: `${ROOT}/dist`,
  target: "browser",
  splitting: true,
  sourcemap: "linked",
  plugins: [aliasWebToBrowser],
  // Belt-and-suspenders: the markdown renderer LAZY-loads the OPTIONAL, uninstalled `mermaid-isomorphic`
  // peer dep. The demo never renders mermaid, so externalize it — the dynamic `import()` is never evaluated.
  external: ["mermaid-isomorphic"],
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
