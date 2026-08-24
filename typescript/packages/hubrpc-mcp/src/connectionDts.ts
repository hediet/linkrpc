/// <reference path="./raw.d.ts" />
import connectionDtsText from "./guest/connection.d.ts?raw";

/**
 * Documentation that the MCP server exposes as a resource. The text is the
 * single source of truth for what `runHubRpcScript` sees inside the QuickJS
 * sandbox — it lives as the real declaration file `connection.d.ts` and is
 * embedded here verbatim. Keep `connection.d.ts` in sync with `sandbox.ts`
 * and `explore.ts`.
 */
export const CONNECTION_DTS: string = connectionDtsText;
