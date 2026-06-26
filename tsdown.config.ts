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
  // ESM-only; NO dts: the hub plugin / `Hub` DO types reference @cloudflare/workers-types ambient globals
  // (DurableObjectState, DurableObjectNamespace, …) that cannot be portably re-emitted from a downstream
  // library — the `.` entry keeps full types. clean:false so it does not wipe the client output above.
  {
    entry: { server: "src/server.ts" },
    format: ["esm"],
    dts: false,
    clean: false,
    sourcemap: false,
    tsconfig: "tsconfig.worker.build.json"
  }
]);
