/**
 * @file Sandbox dev server. Bundles the two browser entries via the shared {@link buildSandboxClient}
 * builder — TypeScript, node_modules resolution, and the lazy `import("trystero/nostr")` code-split all
 * handled — then serves the static HTML + the built `/dist` assets over `Bun.serve`. Run it with
 * `bun run sandbox` (or `bun sandbox/serve.ts`); the Playwright smoke/interop e2e config reuses it as its
 * `webServer`. The worker harness (`?signaling=server`) serves the SAME built assets through `wrangler dev`'s
 * `ASSETS` binding instead — see `./build-client.ts` + `./wrangler.jsonc`.
 *
 * Intentionally dependency-free (only Bun globals): it must run in the Bun server runtime, so it never
 * imports the browser-only `shared.ts`. The port is read from `$PORT` (default 5179, matching the e2e
 * config's expectation).
 */
import { buildSandboxClient } from "./build-client";

const ROOT = import.meta.dir;
const PORT = Number(process.env.PORT ?? 5179);

// One build, shared with the worker harness (`build-client.ts`): throws on failure so we never serve stale
// or missing assets.
await buildSandboxClient();

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
