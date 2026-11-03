import { defineConfig } from "tsdown";

export default defineConfig([
  // Client core (`.`) — the browser + node-test surface. Built with the DOM tsconfig; full types (dual ESM+CJS).
  {
    entry: { index: "src/index.ts" },
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    sourcemap: false,
    tsconfig: "tsconfig.build.json"
  },
  // Server core (`./server`, workerd) — built with the worker tsconfig (@cloudflare/workers-types, no DOM).
  // ESM-only. The dts names @cloudflare/workers-types ambient globals (DurableObjectState, ExecutionContext, …),
  // which every worker app already has. clean:false so it does not wipe the client output above.
  {
    entry: { server: "src/server.ts" },
    format: ["esm"],
    dts: true,
    clean: false,
    sourcemap: false,
    tsconfig: "tsconfig.worker.build.json"
  }
]);
