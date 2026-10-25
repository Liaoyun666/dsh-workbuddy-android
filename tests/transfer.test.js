import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DESKTOP_AUTH_RELATIVE,
  desktopAuthCandidates,
  exportCredential,
  findDesktopAuthFile,
  importCredential,
} from '../lib/transfer.js';
import { deriveKey, encryptField } from '../lib/atrest.js';
import { decodeToken, encodeToken } from '../lib/token.js';
import { AUTH_FILENAME } from '../lib/store.js';

/** @type {string} */
let home;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wb-transfer-'));
});

/** A desktop document with a plaintext credential. */
function plaintextDesktop(overrides = {}) {
  return {
    auth: {
      accessToken: 'desktop-access',
      refreshToken: 'desktop-refresh',
      domain: 'www.workbuddy.cn',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      refreshExpiresAt: Math.floor(Date.now() / 1000) + 86400,
      ...overrides,
    },
    account: { uid: 'uid-desktop', nickname: '小明' },
  };
}

/** Write a desktop auth file under a fake LocalAppData. */
async function seedDesktop(document) {
  const dir = join(home, 'AppData', 'Local', ...DESKTOP_AUTH_RELATIVE.slice(0, -1));
  await mkdir(dir, { recursive: true });
  const path = join(dir, DESKTOP_AUTH_RELATIVE[DESKTOP_AUTH_RELATIVE.length - 1]);
  await writeFile(path, JSON.stringify(document));
  return path;
}

const windowsEnv = () => ({ LOCALAPPDATA: join(home, 'AppData', 'Local'), HOME: home });

describe('desktopAuthCandidates', () => {
  it('looks in both AppData roots on Windows', () => {
    const candidates = desktopAuthCandidates({ platform: 'win32', env: windowsEnv() });
    assert.equal(candidates.length, 2);
    assert.match(candidates[0], /AppData\\Local\\CodeBuddyExtension/);
    assert.match(candidates[1], /AppData\\Roaming\\CodeBuddyExtension/);
  });

  it('uses Application Support on macOS', () => {
    const candidates = desktopAuthCandidates({ platform: 'darwin', env: { HOME: '/Users/me' } });
    assert.deepEqual(candidates, [`/Users/me/Library/Application Support/${DESKTOP_AUTH_RELATIVE.join('/')}`]);
  });

  it('falls back to XDG paths on Linux', () => {
    const candidates = desktopAuthCandidates({ platform: 'linux', env: { HOME: '/home/me' } });
    assert.equal(candidates[0], `/home/me/.config/${DESKTOP_AUTH_RELATIVE.join('/')}`);
    assert.equal(candidates[1], `/home/me/.local/share/${DESKTOP_AUTH_RELATIVE.join('/')}`);
  });

  it('ignores a relative XDG override, because that is not a path', () => {
    const candidates = desktopAuthCandidates({ platform: 'linux', env: { HOME: '/home/me', XDG_CONFIG_HOME: 'relative' } });
    assert.ok(candidates[0].startsWith('/home/me/.config/'));
  });
});

describe('findDesktopAuthFile', () => {
  it('finds the file the desktop app wrote', async () => {
    const path = await seedDesktop(plaintextDesktop());
    const found = await findDesktopAuthFile({ env: windowsEnv(), platform: 'win32' });
    assert.equal(found.path, path);
  });

  it('explains what to do when there is no desktop app', async () => {
    await assert.rejects(() => findDesktopAuthFile({ env: windowsEnv(), platform: 'win32' }), (error) => {
      assert.equal(error.code, 'DESKTOP_NOT_FOUND');
      assert.match(error.message, /登录/);
      return true;
    });
  });

  it('honours an explicit path', async () => {
    const path = await seedDesktop(plaintextDesktop());
    const found = await findDesktopAuthFile({ desktopPath: path, env: windowsEnv(), platform: 'win32' });
    assert.equal(found.path, path);
  });
});

describe('exportCredential', () => {
  it('exports a plaintext desktop file without starting the app', async () => {
    const path = await seedDesktop(plaintextDesktop());
    let probed = false;
    const result = await exportCredential({
      env: windowsEnv(),
      platform: 'win32',
      electronPath: process.execPath,
      runProbe: async () => {
        probed = true;
        throw new Error('a plaintext file must never start the desktop app');
      },
    });
    assert.equal(probed, false);
    assert.equal(result.source, path);
    assert.equal(result.credential.accessToken, 'desktop-access');
    assert.equal(result.credential.uid, 'uid-desktop');
    assert.equal(result.credential.nickname, '小明');
    assert.equal(result.expired, false);
  });

  it('hands back a token that decodes to the same credential', async () => {
    await seedDesktop(plaintextDesktop());
    const result = await exportCredential({ env: windowsEnv(), platform: 'win32' });
    assert.ok(result.token.startsWith('wb1.'));
    const decoded = decodeToken(result.token);
    assert.deepEqual(decoded, result.credential);
  });

  it('skips the token when the caller only wants JSON', async () => {
    await seedDesktop(plaintextDesktop());
    const result = await exportCredential({ env: windowsEnv(), platform: 'win32', withToken: false });
    assert.equal(result.token, undefined);
  });

  it('decrypts an encrypted desktop file with the app key', async () => {
    const secret = Buffer.alloc(32, 7).toString('base64');
    const derived = deriveKey(secret);
    const document = {
      auth: {
        accessToken: encryptField('desktop-access', derived),
        refreshToken: encryptField('desktop-refresh', derived),
        domain: 'www.workbuddy.cn',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
      account: { uid: 'uid-desktop' },
    };
    const path = await seedDesktop(document);

    /** @type {string[]} */
    const probes = [];
    const result = await exportCredential({
      desktopPath: path,
      env: windowsEnv(),
      platform: 'win32',
      // Stands in for the Electron binary. The point of the test is that an
      // encrypted file triggers the probe at all and that what comes back is
      // enough to open the envelope.
      electronPath: process.execPath,
      runProbe: async ({ binary, env }) => {
        probes.push(binary);
        assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
        return JSON.stringify({ version: 1, atRestSecretKey: secret });
      },
    });
    assert.equal(probes.length, 1);
    assert.equal(result.credential.accessToken, 'desktop-access');
    assert.equal(result.credential.refreshToken, 'desktop-refresh');
  });

  it('refuses a credential whose tokens have both expired', async () => {
    await seedDesktop(
      plaintextDesktop({
        expiresAt: Math.floor(Date.now() / 1000) - 100,
        refreshExpiresAt: Math.floor(Date.now() / 1000) - 50,
      }),
    );
    await assert.rejects(() => exportCredential({ env: windowsEnv(), platform: 'win32' }), (error) => {
      assert.equal(error.code, 'UNUSABLE');
      assert.match(error.message, /重新登录/);
      return true;
    });
  });
});

describe('importCredential', () => {
  const target = () => join(home, '.dsh', AUTH_FILENAME);

  it('writes the canonical own document', async () => {
    const token = encodeToken({ accessToken: 'a', refreshToken: 'r', expiresAtMs: Date.now() + 3600_000 });
    const result = await importCredential({ input: token, env: { DSH_HOME: join(home, '.dsh') } });
    assert.equal(result.path, target());
    const document = JSON.parse(await readFile(target(), 'utf8'));
    assert.equal(document.version, 1);
    assert.equal(document.credential.accessToken, 'a');
  });

  it('accepts a whole desktop document, so users can paste the file', async () => {
    await importCredential({
      input: JSON.stringify(plaintextDesktop()),
      env: { DSH_HOME: join(home, '.dsh') },
    });
    const document = JSON.parse(await readFile(target(), 'utf8'));
    assert.equal(document.credential.accessToken, 'desktop-access');
    assert.equal(document.credential.nickname, '小明');
  });

  it('accepts an own document, so a phone can move to another phone', async () => {
    await importCredential({
      input: JSON.stringify({ version: 1, credential: { accessToken: 'own-token', expiresAtMs: Date.now() + 1000 } }),
      env: { DSH_HOME: join(home, '.dsh') },
    });
    const document = JSON.parse(await readFile(target(), 'utf8'));
    assert.equal(document.credential.accessToken, 'own-token');
  });

  it('says so when there is nothing to import', async () => {
    await assert.rejects(() => importCredential({ env: { DSH_HOME: join(home, '.dsh') } }), (error) => {
      assert.equal(error.code, 'NO_INPUT');
      return true;
    });
  });

  it('refuses an unusable credential instead of writing a dead file', async () => {
    await assert.rejects(
      () =>
        importCredential({
          input: JSON.stringify({ accessToken: 'a', expiresAtMs: Date.now() - 1000 }),
          env: { DSH_HOME: join(home, '.dsh') },
        }),
      (error) => {
        assert.equal(error.code, 'UNUSABLE');
        return true;
      },
    );
    assert.equal(existsSync(target()), false);
  });
});
