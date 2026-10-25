import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AUTH_FILENAME,
  readAuthFile,
  removeAuthFile,
  resolveAuthPath,
  resolveDshHome,
  writeAuthFile,
} from '../lib/store.js';

/** @type {string} */
let home;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wb-store-'));
});

describe('resolveDshHome', () => {
  it('prefers DSH_HOME', () => {
    assert.equal(resolveDshHome({ DSH_HOME: '/custom/dsh' }), '/custom/dsh');
  });

  it('ignores an empty DSH_HOME', () => {
    const result = resolveDshHome({ DSH_HOME: '   ' });
    assert.ok(result.endsWith('.dsh'));
  });
});

describe('resolveAuthPath', () => {
  it('uses $DSH_HOME/.workbuddy-auth.json', () => {
    const path = resolveAuthPath({ env: { DSH_HOME: home } });
    assert.equal(path, join(home, AUTH_FILENAME));
  });

  it('honours WORKBUDDY_AUTH_FILE, because the bridge does', () => {
    // If the user pointed the bridge at another file, seeding the default
    // path would write a credential nothing reads.
    const path = resolveAuthPath({ env: { DSH_HOME: home, WORKBUDDY_AUTH_FILE: '/tmp/other.json' } });
    assert.equal(path, '/tmp/other.json');
  });

  it('lets an explicit path win over the environment', () => {
    const path = resolveAuthPath({ env: { WORKBUDDY_AUTH_FILE: '/tmp/other.json' }, authFile: '/tmp/explicit.json' });
    assert.equal(path, '/tmp/explicit.json');
  });

  it('ignores an empty WORKBUDDY_AUTH_FILE', () => {
    const path = resolveAuthPath({ env: { DSH_HOME: home, WORKBUDDY_AUTH_FILE: '  ' } });
    assert.equal(path, join(home, AUTH_FILENAME));
  });
});

describe('writeAuthFile', () => {
  it('writes the own document shape', async () => {
    const path = join(home, AUTH_FILENAME);
    await writeAuthFile(path, { accessToken: 'a', refreshToken: 'r' });
    const document = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(document, { version: 1, credential: { accessToken: 'a', refreshToken: 'r' } });
  });

  it('creates the parent directory', async () => {
    const path = join(home, 'nested', 'deeper', AUTH_FILENAME);
    await writeAuthFile(path, { accessToken: 'a' });
    assert.equal(existsSync(path), true);
  });

  it('reports whether it replaced a file', async () => {
    const path = join(home, AUTH_FILENAME);
    assert.equal((await writeAuthFile(path, { accessToken: 'a' })).replaced, false);
    assert.equal((await writeAuthFile(path, { accessToken: 'b' })).replaced, true);
  });

  it('leaves no temp file behind', async () => {
    const { readdir } = await import('node:fs/promises');
    const path = join(home, AUTH_FILENAME);
    await writeAuthFile(path, { accessToken: 'a' });
    const entries = await readdir(home);
    assert.deepEqual(entries, [AUTH_FILENAME]);
  });

  it('keeps 0600 where permissions mean something', async () => {
    const path = join(home, AUTH_FILENAME);
    await writeAuthFile(path, { accessToken: 'a' });
    const mode = (await stat(path)).mode & 0o777;
    if (process.platform === 'win32') {
      // Windows reports a synthetic mode; asserting 0600 there would be a lie.
      assert.ok(mode > 0);
    } else {
      assert.equal(mode, 0o600);
    }
  });

  it('ends the file with a newline', async () => {
    const path = join(home, AUTH_FILENAME);
    await writeAuthFile(path, { accessToken: 'a' });
    assert.ok((await readFile(path, 'utf8')).endsWith('\n'));
  });
});

describe('readAuthFile', () => {
  it('reports a missing file without throwing', async () => {
    assert.deepEqual(await readAuthFile(join(home, 'nope.json')), { exists: false });
  });

  it('reads back what was written', async () => {
    const path = join(home, AUTH_FILENAME);
    await writeAuthFile(path, { accessToken: 'a' });
    const result = await readAuthFile(path);
    assert.equal(result.exists, true);
    assert.equal(/** @type {any} */ (result.document).credential.accessToken, 'a');
    assert.ok(typeof result.bytes === 'number' && result.bytes > 0);
  });

  it('survives invalid JSON and says the file exists', async () => {
    const path = join(home, AUTH_FILENAME);
    await writeFile(path, 'not json at all');
    const result = await readAuthFile(path);
    assert.equal(result.exists, true);
    assert.equal(result.document, undefined);
  });
});

describe('removeAuthFile', () => {
  it('removes an existing file and reports it', async () => {
    const path = join(home, AUTH_FILENAME);
    await writeAuthFile(path, { accessToken: 'a' });
    assert.equal(await removeAuthFile(path), true);
    assert.equal(existsSync(path), false);
  });

  it('reports false when there was nothing to remove', async () => {
    assert.equal(await removeAuthFile(join(home, 'nope.json')), false);
  });
});
