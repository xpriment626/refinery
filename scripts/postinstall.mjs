#!/usr/bin/env node

const message = `
Refinery installed.

Next steps:
  refinery init --json
  refinery skill install --json
  refinery set auth coral
  refinery doctor --json

Local graph observability:
  refinery ui url --json

Automatic browser opening after graph changes is disabled by default. If you
want it, enable it explicitly (or ask your agent to ask you first):
  refinery ui config --browser-open on --json
`;

process.stderr.write(message);
