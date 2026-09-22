#!/usr/bin/env node
import { run } from '../src/cli.js';

run(process.argv.slice(2))
  .then((code) => {
    if (code) process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`✗ ${err?.stack || err}\n`);
    process.exitCode = 1;
  });
