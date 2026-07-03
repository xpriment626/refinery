#!/usr/bin/env node

const message = `
Refinery installed.

Next steps:
  refinery init
  refinery set auth coral
  refinery doctor --json
`;

process.stderr.write(message);
