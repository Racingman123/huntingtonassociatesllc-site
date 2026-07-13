// Next.js treats `server-only` as a compile-time guard. Integration tests run
// in a Node-only Vitest process, so resolving it to this empty module preserves
// the intended boundary without requiring the Next.js compiler.
export {};
