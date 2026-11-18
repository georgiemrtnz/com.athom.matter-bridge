import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Environment, Logger, LogLevel } from '@matter/main';
import MatterBridgeServer from '../lib/MatterBridgeServer.mjs';

const source = readFileSync(new URL('../lib/MatterBridgeServer.mjs', import.meta.url), 'utf8');

const directory = mkdtempSync(join(tmpdir(), 'matter-bridge-memory-'));
after(async () => {
  await Environment.default.runtime.close();
  rmSync(directory, { recursive: true, force: true });
});

function createServer(extra = {}) {
  return new MatterBridgeServer({
    api: {},
    debug: () => {},
    port: 0,
    storageServiceLocation: directory,
    ...extra,
  });
}

test('the server does not import the full matter.js cluster, device, behavior or endpoint catalogs', () => {
  const barrel = /from '@matter\/main\/(clusters|devices|behaviors|endpoints)'/;
  assert.equal(barrel.test(source), false);
});

test('every deep import binds the same class the catalog exports', async () => {
  const imports = [...source.matchAll(/^import \{ (\w+) \} from '@matter\/main\/(clusters|devices|behaviors|endpoints)\/([\w-]+)';$/gm)];
  assert.ok(imports.length >= 40, `expected the deep imports, found ${imports.length}`);
  for (const [, symbol, kind, file] of imports) {
    const deep = await import(`@matter/main/${kind}/${file}`);
    const catalog = await import(`@matter/main/${kind}`);
    assert.ok(deep[symbol], `${symbol} missing from @matter/main/${kind}/${file}`);
    assert.equal(deep[symbol], catalog[symbol], `${symbol} differs from the catalog export`);
  }
});

test('matter.js logs at NOTICE by default', () => {
  Logger.level = LogLevel.DEBUG;
  createServer();
  assert.equal(Logger.level, LogLevel.NOTICE);
});

test('the matter.js log level can be raised for troubleshooting', () => {
  createServer({ matterLogLevel: 'debug' });
  assert.equal(Logger.level, LogLevel.DEBUG);
});

test('an invalid matter.js log level falls back to NOTICE', () => {
  const messages = [];
  createServer({ matterLogLevel: 'chatty', debug: (...args) => messages.push(args.join(' ')) });
  assert.equal(Logger.level, LogLevel.NOTICE);
  assert.match(messages[0], /Invalid matter.js log level/);
});
