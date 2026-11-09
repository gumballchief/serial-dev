#!/usr/bin/env node
// Hide a harmless native-bindings warning from a Solana dependency.
const warn = console.warn;
console.warn = (...a) => (String(a[0]).startsWith("bigint: Failed to load bindings") ? undefined : warn(...a));

const { startMcp } = await import("../src/mcp.js");
startMcp().catch((e) => {
  console.error(`serial-dev mcp: ${e.message}`);
  process.exit(1);
});
