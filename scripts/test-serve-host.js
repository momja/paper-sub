// Run with: node --test scripts/test-serve-host.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const cli = fileURLToPath(new URL('../bin/paper.js', import.meta.url));

for (const { name, envHost, args, expected } of [
  { name: 'defaults to loopback', envHost: '', args: [], expected: '127.0.0.1' },
  { name: 'uses PAPER_HOST', envHost: '0.0.0.0', args: [], expected: '0.0.0.0' },
  { name: '--host overrides PAPER_HOST', envHost: '192.0.2.1', args: ['--host', '127.0.0.1'], expected: '127.0.0.1' },
]) {
  test(name, { timeout: 15000 }, async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'paper-host-test-'));
    const env = { ...process.env, PAPER_HOST: envHost, PAPER_CHROME: 'off' };
    delete env.PAPER_CANVAS_DIR;
    const child = spawn(process.execPath, [cli, 'serve', '--no-open', '--port', '24321', ...args], {
      cwd, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const closed = once(child, 'close');
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    try {
      let lock;
      for (let i = 0; i < 100; i++) {
        try {
          lock = JSON.parse(await readFile(path.join(cwd, '.paper-canvas/server.json'), 'utf8'));
          break;
        } catch {}
        assert.equal(child.exitCode, null, output);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.ok(lock, `server started: ${output}`);
      assert.equal(lock.host, expected);
      const response = await fetch(`http://127.0.0.1:${lock.port}/api/state`);
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).frames, []);
    } finally {
      child.kill('SIGTERM');
      await closed;
      await rm(cwd, { recursive: true, force: true });
    }
  });
}
