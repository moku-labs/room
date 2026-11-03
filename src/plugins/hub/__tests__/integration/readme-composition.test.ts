/**
 * @file Guards the README's server-tier composition: the plugin list a reader copies must compose under
 * the real `@moku-labs/worker` `createApp` (`deployPlugin` depends on more plugins than it looks like).
 */

import * as worker from "@moku-labs/worker";
import { describe, expect, it } from "vitest";
import readme from "../../../../../README.md?raw";
import { hubPlugin } from "../../index";

/**
 * Reads the plugin names of the README's server-tier `createApp` example.
 *
 * @returns The identifiers inside its `plugins: [...]` array, in order.
 * @example
 * ```ts
 * readmePluginNames(); // ["storagePlugin", "kvPlugin", ...]
 * ```
 */
function readmePluginNames(): string[] {
  const start = readme.indexOf("// your-app/src/server.ts");
  const list = /plugins: \[([^\]]+)\]/.exec(readme.slice(start))?.[1] ?? "";
  return list.split(",").map(name => name.trim());
}

describe("README server-tier composition", () => {
  it("composes under the real worker createApp, exactly as written", () => {
    const exports = { ...worker, hubPlugin } as unknown as Record<string, never>;
    const plugins = readmePluginNames().map(name => exports[name]);

    expect(() =>
      worker.createApp({
        plugins,
        pluginConfigs: {
          durableObjects: { hub: { binding: "ROOM_HUB", className: "Hub" } },
          kv: { rateLimit: { name: "ratelimit", binding: "RATE_LIMIT" } }
        }
      } as never)
    ).not.toThrow();
  });
});
