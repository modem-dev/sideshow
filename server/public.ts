// Stable public server-core entrypoint for integrations that reuse sideshow's
// HTTP/SSE/MCP app without depending on the package's internal dist layout.

export { createApp, type AppOptions, type AuthenticateHook } from "./app.js";
export { JsonFileStore } from "./storage.js";
export type * from "./types.js";
