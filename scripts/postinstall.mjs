#!/usr/bin/env node

const message = `
Refinery installed.

Next steps:
  refinery setup inspect --json
  refinery skill install --json
  refinery setup start --json

The setup command returns a short-lived loopback URL. If an agent installed
Refinery, it should open that URL in its in-app browser so the human can enter
the Coral key without placing it in chat, shell arguments, or logs.

Local graph observability:
  refinery ui url --json

Automatic browser opening after graph changes is disabled by default. If you
want it, enable it explicitly (or ask your agent to ask you first):
  refinery ui config --browser-open on --json
`;

process.stderr.write(message);
