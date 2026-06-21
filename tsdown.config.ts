import { defineConfig } from "tsdown";

export default defineConfig([
  // Web surface (DOM): main barrel + browser entry — built with the DOM tsconfig.
  {
    entry: {
      index: "src/index.ts",
      browser: "src/browser.ts"
    },
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    sourcemap: false,
    tsconfig: "tsconfig.build.json"
  },
  // Worker surface (workerd): @moku-labs/room/server — built with the worker tsconfig
  // (@cloudflare/workers-types, no DOM). clean:false so it does not wipe the web output above.
  {
    entry: {
      server: "src/server.ts"
    },
    // ESM-only deploy entry (Cloudflare Workers are ESM). NO dts: the composed app / RoomHub /
    // roomHubPlugin types reference @moku-labs/worker internals (non-exported DurableObjectBase,
    // nested @moku-labs/core PluginInstance) that cannot be portably re-emitted from a downstream
    // library. `@moku-labs/room/server` ships JS-only — it is a wrangler `main` target (default
    // fetch) + the RoomHub DO class; the web entries (`.`/`./browser`) keep full types.
    format: ["esm"],
    dts: false,
    clean: false,
    sourcemap: false,
    tsconfig: "tsconfig.worker.build.json"
  }
]);
