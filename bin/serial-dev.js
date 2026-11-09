#!/usr/bin/env node
// Hide a harmless native-bindings warning from a Solana dependency.
const warn = console.warn;
console.warn = (...a) => (String(a[0]).startsWith("bigint: Failed to load bindings") ? undefined : warn(...a));

const { main } = await import("../src/cli.js");
main(process.argv.slice(2)).catch((e) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
