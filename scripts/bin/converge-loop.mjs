#!/usr/bin/env node
import { runCli } from "../lib/cli.mjs";

runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
  binPath: new URL(import.meta.url).pathname
}).then((code) => {
  process.exitCode = code;
}).catch((error) => {
  process.stderr.write(`${error?.message || String(error)}\n`);
  process.exitCode = 1;
});
