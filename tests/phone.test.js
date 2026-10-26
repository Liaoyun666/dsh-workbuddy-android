/**
 * The MMKV reader, and the phone-capture flow around it.
 *
 * Every test that pretends to be a phone passes a `runner` instead of a real
 * shell: the interesting logic is "what do we do with this output", not "can
 * execFile spawn something", and a test that needs root access is a test nobody
 * runs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  decodeValue,
  parseMmkv,
  readVarint,
  valueMillis,
  valueText,
  MmkvError,
} from '../lib/mmkv.js';
import {
  PHONE_PACKAGE,
  PhoneError,
  captureFromPhone,
  copyCommand,
  credentialFromEntries,
  describeFailure,
  findMmkvFiles,
  parseListing,
  pullFiles,
  uidFrom,
} from '../lib/phone.js';

/** Encode a base-128 varint. */
function varint(value) {
  const bytes = [];
  let rest = value;
  do {
    let byte = rest % 128;
    rest = Math.floor(rest / 128);
    if (rest > 0) byte |= 0x80;
    bytes.push(byte);
  } while (rest > 0);
  return Buffer.from(bytes);
}

/**
 * Build an MMKV file the way a full write-back lays it out: size header, the
 * random placeholder varint, then the entries.
 * @param {Array<[string, Buffer]>} entries
 * @param {{ placeholder?: number, declaredSize?: number, tail?: Buffer }} [options]
 */
function buildMmkv(entries, options = {}) {
  const parts = [];
  for (const [key, value] of entries) {
    const keyBytes = Buffer.from(key, 'utf8');
    parts.push(varint(keyBytes.length), keyBytes, varint(value.length), value);
  }
  const body = Buffer.concat(parts);
  const placeholder = varint(options.placeholder ?? 0);
  const data = Buffer.concat([placeholder, body, options.tail ?? Buffer.alloc(0)]);
  const header = Buffer.alloc(4);
  header.writeUInt32LE(options.declaredSize ?? data.length, 0);
  return Buffer.concat([header, data]);
}

/** A realistic-ish set of app keys. */
function appEntries(overrides = {}) {
  const now = Date.now();
  const defaults = {
    workbuddy_token: Buffer.from('eyJhbGciOiJIUzI1NiJ9.access', 'utf8'),
    workbuddy_refresh_token: Buffer.from('refresh-value-here', 'utf8'),
    workbuddy_token_expire_at: (() => {
      const buffer = Buffer.alloc(8);
      buffer.writeBigInt64LE(BigInt(now + 7 * 86_400_000), 0);
      return buffer;
    })(),
    // The real key is `workbuddy_user`, and it holds a JSON blob. The uid has to
    // be pulled out of it — there is no `workbuddy_uid` key in the app.
    workbuddy_user: Buffer.from(
      JSON.stringify({ uid: 'uid-1234', nickname: 'tester', avatar: 'https://example.invalid/a.png' }),
      'utf8',
    ),
    workbuddy_current_enterprise_id: Buffer.from('ent-9', 'utf8'),
    unrelated_key: Buffer.from('hello', 'utf8'),
  };
  const merged = { ...defaults, ...overrides };
  return Object.entries(merged).filter(([, value]) => value !== undefined);
}

// ---------------------------------------------------------------- varints ---

test('readVarint reads single and multi byte values', () => {
  assert.deepEqual(readVarint(Buffer.from([0x05]), 0), { value: 5, next: 1 });
  assert.deepEqual(readVarint(Buffer.from([0xac, 0x02]), 0), { value: 300, next: 2 });
  assert.deepEqual(readVarint(Buffer.from([0x00, 0x07]), 1), { value: 7, next: 2 });
});

test('readVarint refuses a run of continuation bytes instead of overflowing', () => {
  // Five continuation bytes is not a 32-bit varint. A naive `<< 28` read would
  // silently produce a negative number and a bogus length.
  assert.equal(readVarint(Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x01]), 0), undefined);
});

test('readVarint returns undefined when the buffer ends mid-varint', () => {
  assert.equal(readVarint(Buffer.from([0x80]), 0), undefined);
  assert.equal(readVarint(Buffer.alloc(0), 0), undefined);
});

// ----------------------------------------------------------------- values ---

test('decodeValue distinguishes the shapes MMKV can store', () => {
  assert.deepEqual(decodeValue(Buffer.alloc(0)), { kind: 'empty' });
  assert.deepEqual(decodeValue(Buffer.from([1])), { kind: 'bool', boolean: true });
  assert.deepEqual(decodeValue(Buffer.from([0])), { kind: 'bool', boolean: false });

  const int32 = Buffer.alloc(4);
  int32.writeInt32LE(4_242, 0);
  assert.deepEqual(decodeValue(int32), { kind: 'int32', number: 4242 });

  const int64 = Buffer.alloc(8);
  int64.writeBigInt64LE(1_700_000_000_000n, 0);
  const decoded = decodeValue(int64);
  assert.equal(decoded.kind, 'int64');
  assert.equal(decoded.number, 1_700_000_000_000);
});

test('valueText renders every kind without inventing one', () => {
  assert.equal(valueText({ kind: 'string', text: 'abc' }), 'abc');
  assert.equal(valueText({ kind: 'empty' }), '');
  assert.equal(valueText({ kind: 'bool', boolean: true }), 'true');
  assert.equal(valueText({ kind: 'int32', number: 7 }), '7');
  assert.equal(valueText(undefined), undefined);
});

test('valueMillis scales seconds and leaves milliseconds alone', () => {
  // 1.7e9 is a seconds timestamp (2023); it must become milliseconds.
  assert.equal(valueMillis({ kind: 'int32', number: 1_700_000_000 }), 1_700_000_000_000);
  // 1.7e12 is already milliseconds.
  assert.equal(valueMillis({ kind: 'int32', number: 1_700_000_000_000 }), 1_700_000_000_000);
  // A duration in seconds (a week) is also a count of seconds.
  assert.equal(valueMillis({ kind: 'int32', number: 604_800 }), 604_800_000);
  // Strings work too, because some builds store the number as text.
  assert.equal(valueMillis({ kind: 'string', text: '1700000000' }), 1_700_000_000_000);
  assert.equal(valueMillis({ kind: 'string', text: 'not a number' }), undefined);
  assert.equal(valueMillis({ kind: 'int32', number: 0 }), undefined);
  assert.equal(valueMillis(undefined), undefined);
});

test('valueMillis prefers the int64 reading that lands near the present', () => {
  // A double holding a date and an int64 holding a tiny number are both 8
  // bytes; only one of them looks like a plausible timestamp.
  const buffer = Buffer.alloc(8);
  buffer.writeDoubleLE(1_800_000_000_000, 0);
  const decoded = decodeValue(buffer);
  const millis = valueMillis(decoded);
  assert.ok(millis > 1_700_000_000_000 && millis < 2_000_000_000_000, `got ${millis}`);
});

// ------------------------------------------------------------------ parse ---

test('parseMmkv reads the placeholder layout', () => {
  const file = buildMmkv(appEntries());
  const parsed = parseMmkv(file);
  assert.equal(parsed.layout, 'placeholder');
  assert.equal(parsed.complete, true);
  assert.equal(valueText(parsed.entries.get('workbuddy_token')), 'eyJhbGciOiJIUzI1NiJ9.access');
  assert.equal(valueText(parsed.entries.get('unrelated_key')), 'hello');
});

test('parseMmkv also reads a file with no placeholder', () => {
  // An older write path has no fake-size field; the parser tries both offsets
  // and keeps whichever yields more entries.
  const entries = appEntries();
  const parts = [];
  for (const [key, value] of entries) {
    const keyBytes = Buffer.from(key, 'utf8');
    parts.push(varint(keyBytes.length), keyBytes, varint(value.length), value);
  }
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  const parsed = parseMmkv(Buffer.concat([header, body]));
  assert.equal(parsed.layout, 'plain');
  assert.equal(parsed.entries.size, entries.length);
});

test('parseMmkv treats a zero length value as a deletion', () => {
  const file = buildMmkv([
    ['workbuddy_token', Buffer.from('first', 'utf8')],
    ['workbuddy_token', Buffer.alloc(0)],
  ]);
  const parsed = parseMmkv(file);
  assert.equal(parsed.entries.has('workbuddy_token'), false);
});

test('parseMmkv keeps what it read when the tail is garbage', () => {
  const file = buildMmkv(appEntries(), { tail: Buffer.from([0x01, 0xff, 0xfe, 0xfd]) });
  const parsed = parseMmkv(file);
  assert.ok(parsed.entries.size >= 5);
  assert.equal(parsed.complete, false);
});

test('parseMmkv stops at zero padding instead of inventing keys', () => {
  const file = buildMmkv(appEntries(), { tail: Buffer.alloc(64) });
  const parsed = parseMmkv(file);
  assert.equal(parsed.complete, true);
  assert.equal(parsed.entries.size, 6);
});

test('parseMmkv refuses something too small to be a file', () => {
  assert.throws(() => parseMmkv(Buffer.from([1, 2])), (error) => error instanceof MmkvError && error.code === 'TOO_SMALL');
});

test('parseMmkv refuses a non-buffer', () => {
  assert.throws(() => parseMmkv('nope'), (error) => error.code === 'NOT_BUFFER');
});

test('parseMmkv copes with a header that overshoots the file', () => {
  // A file truncated mid-append claims more bytes than it has; parse what is there.
  const file = buildMmkv(appEntries(), { declaredSize: 1_000_000 });
  const parsed = parseMmkv(file);
  assert.ok(parsed.entries.size >= 5, `got ${parsed.entries.size}`);
});

test('parseMmkv finds nothing in random bytes without throwing', () => {
  const noise = Buffer.alloc(256);
  for (let index = 0; index < noise.length; index += 1) noise[index] = (index * 37 + 11) % 256;
  const parsed = parseMmkv(noise);
  assert.ok(parsed.entries.size <= 3);
});

// ------------------------------------------------------------- credential ---

test('uidFrom opens the JSON blob the app really stores', () => {
  // This is the shape `workbuddy_user` holds: an account object, not an id.
  assert.equal(uidFrom('{"uid":"abc-1","nickname":"someone"}'), 'abc-1');
  assert.equal(uidFrom('{"data":{"user":{"userId":"deep"}}}'), 'deep');
  assert.equal(uidFrom('{"userId":42}'), '42');
  // A bare id is what an older build may have written.
  assert.equal(uidFrom('abc-1'), 'abc-1');
  // Nothing usable degrades to empty rather than throwing.
  assert.equal(uidFrom(undefined), '');
  assert.equal(uidFrom(''), '');
  assert.equal(uidFrom('{not json'), '');
  assert.equal(uidFrom('{}'), '');
  assert.equal(uidFrom('{"uid":"0"}'), '');
  assert.equal(uidFrom('null'), 'null');
});

test('credentialFromEntries takes the uid out of the user blob', () => {
  const credential = credentialFromEntries(
    new Map([
      ['workbuddy_token', { kind: 'string', text: 'at' }],
      ['workbuddy_user', { kind: 'string', text: '{"uid":"from-blob"}' }],
    ]),
  );
  assert.equal(credential.uid, 'from-blob');
});

test('credentialFromEntries drops the uid when the blob is unreadable', () => {
  const credential = credentialFromEntries(
    new Map([
      ['workbuddy_token', { kind: 'string', text: 'at' }],
      ['workbuddy_user', { kind: 'string', text: '{not json' }],
    ]),
  );
  assert.equal(credential.uid, undefined);
  assert.equal(credential.accessToken, 'at');
});

test('credentialFromEntries maps the app keys onto a credential', () => {
  const file = buildMmkv(appEntries());
  const parsed = parseMmkv(file);
  const credential = credentialFromEntries(parsed.entries);
  assert.equal(credential.accessToken, 'eyJhbGciOiJIUzI1NiJ9.access');
  assert.equal(credential.refreshToken, 'refresh-value-here');
  assert.equal(credential.uid, 'uid-1234');
  assert.equal(credential.enterpriseId, 'ent-9');
  assert.equal(typeof credential.expiresAtMs, 'number');
  assert.ok(credential.expiresAtMs > Date.now());
});

test('credentialFromEntries falls back to the codebuddy_* keys', () => {
  const credential = credentialFromEntries(
    new Map([
      ['codebuddy_token', { kind: 'string', text: 'cb-access' }],
      ['codebuddy_refresh_token', { kind: 'string', text: 'cb-refresh' }],
    ]),
  );
  assert.equal(credential.accessToken, 'cb-access');
  assert.equal(credential.refreshToken, 'cb-refresh');
});

test('credentialFromEntries strips a Bearer prefix', () => {
  const credential = credentialFromEntries(
    new Map([['workbuddy_token', { kind: 'string', text: 'Bearer abc.def' }]]),
  );
  assert.equal(credential.accessToken, 'abc.def');
});

test('credentialFromEntries omits an enterprise id of 0', () => {
  const credential = credentialFromEntries(
    new Map([
      ['workbuddy_token', { kind: 'string', text: 'a' }],
      ['workbuddy_current_enterprise_id', { kind: 'string', text: '0' }],
    ]),
  );
  assert.equal('enterpriseId' in credential, false);
});

test('credentialFromEntries says why when there is no token', () => {
  assert.throws(
    () => credentialFromEntries(new Map([['something_else', { kind: 'string', text: 'x' }]])),
    (error) => error instanceof PhoneError && error.code === 'NO_TOKEN_IN_STORE',
  );
});

// ------------------------------------------------------------------ shell ---

test('copyCommand quotes both paths', () => {
  assert.equal(
    copyCommand('/data/data/x/files/mmkv/default', '/storage/emulated/0/Download/DSHA/a.bin'),
    "cp '/data/data/x/files/mmkv/default' '/storage/emulated/0/Download/DSHA/a.bin'",
  );
});

test('copyCommand rejects a relative path and a newline', () => {
  assert.throws(() => copyCommand('relative/path', '/tmp/x'), (error) => error.code === 'BAD_PATH');
  assert.throws(() => copyCommand('/a\nb', '/tmp/x'), (error) => error.code === 'BAD_PATH');
});

test('copyCommand escapes a single quote in the path', () => {
  const command = copyCommand("/data/data/it's here", '/tmp/x');
  assert.ok(command.includes("'\\''"), command);
});

test('describeFailure turns policy blocks into advice, not a retry', () => {
  const blocked = describeFailure({ code: 126, stdout: '[POLICY_BLOCKED] 受保护目录只读\n[EXIT=126]', stderr: '' });
  assert.equal(blocked.code, 'POLICY_BLOCKED');
  assert.match(blocked.message, /重试无效/);
});

test('describeFailure marks an unknown execution as do-not-replay', () => {
  const unknown = describeFailure({ code: 125, stdout: 'EXECUTION_UNKNOWN: ...', stderr: '' });
  assert.equal(unknown.code, 'EXECUTION_UNKNOWN');
  assert.match(unknown.message, /不要直接重放/);
});

test('describeFailure separates a missing shell from a permission problem', () => {
  assert.equal(describeFailure({ code: 127, stdout: '', stderr: 'ENOENT: no such file' }).code, 'SHELL_MISSING');
  assert.equal(describeFailure({ code: 1, stdout: 'cat: /x: Permission denied', stderr: '' }).code, 'READ_DENIED');
  assert.equal(describeFailure({ code: 124, stdout: 'CONNECT_FAIL', stderr: '' }).code, 'ADB_UNAVAILABLE');
  assert.equal(describeFailure({ code: 9, stdout: 'weird', stderr: '' }).code, 'SHELL_FAILED');
  assert.equal(describeFailure({ code: 0, stdout: '', stderr: '' }), undefined);
});

test('parseListing ignores .crc sidecars and directory noise', () => {
  const names = parseListing('default\ndefault.crc\nmmkv.default\nmmkv.default.crc\n');
  assert.deepEqual(names, ['default', 'mmkv.default']);
});

test('parseListing survives an ls -la style output', () => {
  const names = parseListing(
    ['total 8', 'drwx------ 2 root root 4096 default', '-rw------- 1 root root 128 mmkv.default'].join('\n'),
  );
  assert.ok(names.includes('default'), names.join(','));
  assert.ok(names.includes('mmkv.default'), names.join(','));
});

test('findMmkvFiles moves on when the first layout does not exist', async () => {
  const calls = [];
  const runner = async (command) => {
    calls.push(command);
    if (command.includes('/data/data/')) {
      return { code: 1, stdout: '', stderr: 'ls: /data/data/x: No such file or directory' };
    }
    return { code: 0, stdout: 'mmkv.default\nmmkv.default.crc\n', stderr: '' };
  };
  const found = await findMmkvFiles({ runner, dirs: ['/data/data/x/files/mmkv', '/data/user/0/x/files/mmkv'] });
  assert.equal(found.dir, '/data/user/0/x/files/mmkv');
  assert.deepEqual(found.files, ['/data/user/0/x/files/mmkv/mmkv.default']);
  assert.equal(calls.length, 2);
});

test('findMmkvFiles reports every directory it tried', async () => {
  const runner = async () => ({ code: 1, stdout: '', stderr: 'No such file or directory' });
  const found = await findMmkvFiles({ runner, dirs: ['/a/mmkv', '/b/mmkv'] });
  assert.deepEqual(found.files, []);
  assert.deepEqual(found.tried, ['/a/mmkv', '/b/mmkv']);
});

test('findMmkvFiles rethrows a real policy block', async () => {
  const runner = async () => ({ code: 126, stdout: '[POLICY_BLOCKED] 受保护目录只读', stderr: '' });
  await assert.rejects(
    () => findMmkvFiles({ runner, dirs: ['/data/data/x/files/mmkv'] }),
    (error) => error.code === 'POLICY_BLOCKED',
  );
});

test('pullFiles copies through the shell and reads the staged file', async () => {
  const staged = new Map();
  const runner = async (command) => {
    if (command.startsWith('cp ')) {
      staged.set('/storage/emulated/0/Download/DSHA/workbuddy-mmkv-1.bin', buildMmkv(appEntries()));
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };
  const result = await pullFiles({
    files: ['/data/data/x/files/mmkv/mmkv.default'],
    runner,
    fs: {
      readFile: async (path) => {
        if (!staged.has(path)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return staged.get(path);
      },
    },
  });
  assert.equal(result.pulled.length, 1);
  assert.equal(parseMmkv(result.pulled[0].bytes).entries.size, 6);
});

test('pullFiles reuses a copy left behind by an interrupted run', async () => {
  let copies = 0;
  const runner = async () => {
    copies += 1;
    return { code: 0, stdout: '', stderr: '' };
  };
  const result = await pullFiles({
    files: ['/data/data/x/files/mmkv/mmkv.default'],
    runner,
    fs: { readFile: async () => buildMmkv(appEntries()) },
  });
  assert.equal(copies, 0);
  assert.equal(result.pulled.length, 1);
});

test('pullFiles complains when the copy cannot be read back', async () => {
  const runner = async () => ({ code: 0, stdout: '', stderr: '' });
  await assert.rejects(
    () => pullFiles({ files: ['/a'], runner, fs: { readFile: async () => { throw new Error('nope'); } } }),
    (error) => error.code === 'COPY_MISSING',
  );
});

// ---------------------------------------------------------------- capture ---

/** A fake phone whose shell answers from a table. */
function fakePhone({ listing = 'mmkv.default\n', payload = buildMmkv(appEntries()), failListing, failCopy } = {}) {
  /** @type {string[]} */
  const commands = [];
  const staged = new Map();
  const runner = async (command) => {
    commands.push(command);
    if (command.startsWith('ls ')) {
      if (failListing !== undefined) return failListing;
      return { code: 0, stdout: listing, stderr: '' };
    }
    if (command.startsWith('cp ')) {
      if (failCopy !== undefined) return failCopy;
      const destination = command.split("'")[3];
      staged.set(destination, payload);
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };
  const fs = {
    readFile: async (path) => {
      if (!staged.has(path)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return staged.get(path);
    },
  };
  return { runner, fs, commands, staged };
}

test('captureFromPhone walks find → copy → parse → extract', async () => {
  const phone = fakePhone();
  const result = await captureFromPhone({ runner: phone.runner, fs: phone.fs });

  assert.equal(result.packageName, PHONE_PACKAGE);
  assert.equal(result.credential.accessToken, 'eyJhbGciOiJIUzI1NiJ9.access');
  assert.equal(result.files.length, 1);
  assert.ok(result.keys.includes('workbuddy_token'));
  assert.ok(phone.commands[0].startsWith('ls '));
  assert.ok(phone.commands[1].startsWith('cp '));
});

test('captureFromPhone hands the staged paths to the caller for cleanup', async () => {
  const phone = fakePhone();
  /** @type {string[]} */
  const claimed = [];
  await captureFromPhone({ runner: phone.runner, fs: phone.fs, claim: (paths) => claimed.push(...paths) });
  assert.equal(claimed.length, 1);
  assert.match(claimed[0], /Download\/DSHA/);
});

test('captureFromPhone only looks at the newest three files', async () => {
  const phone = fakePhone({ listing: 'a\nb\nc\nd\ne\n' });
  await captureFromPhone({ runner: phone.runner, fs: phone.fs });
  const copies = phone.commands.filter((command) => command.startsWith('cp '));
  assert.equal(copies.length, 3);
  assert.ok(copies[2].includes('/e' + "'"), copies[2]);
});

test('captureFromPhone explains an empty store instead of returning nothing', async () => {
  const phone = fakePhone({ payload: buildMmkv([]) });
  await assert.rejects(
    () => captureFromPhone({ runner: phone.runner, fs: phone.fs }),
    (error) => error.code === 'MMKV_EMPTY',
  );
});

test('captureFromPhone explains a missing directory', async () => {
  const phone = fakePhone({
    failListing: { code: 1, stdout: '', stderr: 'No such file or directory' },
  });
  await assert.rejects(
    () => captureFromPhone({ runner: phone.runner, fs: phone.fs }),
    (error) => error.code === 'MMKV_NOT_FOUND',
  );
});

test('captureFromPhone surfaces a policy block as a policy block', async () => {
  const phone = fakePhone({
    failListing: { code: 126, stdout: '[POLICY_BLOCKED] 受保护目录只读', stderr: '' },
  });
  await assert.rejects(
    () => captureFromPhone({ runner: phone.runner, fs: phone.fs }),
    (error) => error.code === 'POLICY_BLOCKED',
  );
});

test('captureFromPhone merges entries across files, newest wins', async () => {
  const older = buildMmkv([['workbuddy_token', Buffer.from('old', 'utf8')]]);
  const newer = buildMmkv(appEntries());
  const staged = new Map();
  let copyIndex = 0;
  const runner = async (command) => {
    if (command.startsWith('ls ')) return { code: 0, stdout: 'a\nb\n', stderr: '' };
    copyIndex += 1;
    const destination = command.split("'")[3];
    staged.set(destination, copyIndex === 1 ? older : newer);
    return { code: 0, stdout: '', stderr: '' };
  };
  const fs = {
    readFile: async (path) => {
      if (!staged.has(path)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return staged.get(path);
    },
  };
  const result = await captureFromPhone({ runner, fs });
  assert.equal(result.credential.accessToken, 'eyJhbGciOiJIUzI1NiJ9.access');
});

// --------------------------------------------------------------------- e2e ---

test('a captured credential is written where the bridge reads it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wb-capture-'));
  try {
    const phone = fakePhone();
    const result = await captureFromPhone({ runner: phone.runner, fs: phone.fs });

    const { buildTools } = await import('../lib/tools.js');
    const tools = buildTools({
      env: { ...process.env, DSH_HOME: home },
      phone: { runner: phone.runner, fs: phone.fs },
    });
    const capture = tools.find((tool) => tool.name === 'workbuddy_capture_from_phone');
    assert.ok(capture !== undefined, 'capture tool must exist');

    const outcome = await capture.execute({});
    assert.equal(outcome.ok, true, JSON.stringify(outcome));

    const document = JSON.parse(await readFile(join(home, '.workbuddy-auth.json'), 'utf8'));
    assert.equal(document.version, 1);
    assert.equal(document.credential.accessToken, result.credential.accessToken);
    assert.equal(document.credential.refreshToken, 'refresh-value-here');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('the capture tool does not write when asked not to', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wb-capture-dry-'));
  try {
    const phone = fakePhone();
    const { buildTools } = await import('../lib/tools.js');
    const tools = buildTools({
      env: { ...process.env, DSH_HOME: home },
      phone: { runner: phone.runner, fs: phone.fs },
    });
    const capture = tools.find((tool) => tool.name === 'workbuddy_capture_from_phone');
    const outcome = await capture.execute({ write: false });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.written, undefined);
    await assert.rejects(() => readFile(join(home, '.workbuddy-auth.json')));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('the capture tool returns a code and a hint instead of throwing', async () => {
  const phone = fakePhone({
    failListing: { code: 126, stdout: '[POLICY_BLOCKED] 受保护目录只读', stderr: '' },
  });
  const { buildTools } = await import('../lib/tools.js');
  const tools = buildTools({ phone: { runner: phone.runner, fs: phone.fs } });
  const capture = tools.find((tool) => tool.name === 'workbuddy_capture_from_phone');
  const outcome = await capture.execute({});
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'POLICY_BLOCKED');
  assert.match(outcome.hint, /重试无效/);
});

test('the capture tool deletes the staged copy by default', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wb-capture-clean-'));
  try {
    const phone = fakePhone();
    /** @type {string[]} */
    const deleted = [];
    const { buildTools } = await import('../lib/tools.js');
    const tools = buildTools({
      env: { ...process.env, DSH_HOME: home },
      phone: {
        runner: phone.runner,
        fs: phone.fs,
        unlink: async (path) => deleted.push(path),
      },
    });
    const capture = tools.find((tool) => tool.name === 'workbuddy_capture_from_phone');
    await capture.execute({});
    // A live token left in shared storage is the whole risk of this design.
    assert.equal(deleted.length, 1);
    assert.match(deleted[0], /Download\/DSHA\/workbuddy-mmkv-1\.bin$/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('the capture tool keeps the staged copy when asked to', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wb-capture-keep-'));
  try {
    const phone = fakePhone();
    /** @type {string[]} */
    const deleted = [];
    const { buildTools } = await import('../lib/tools.js');
    const tools = buildTools({
      env: { ...process.env, DSH_HOME: home },
      phone: {
        runner: phone.runner,
        fs: phone.fs,
        unlink: async (path) => deleted.push(path),
      },
    });
    const capture = tools.find((tool) => tool.name === 'workbuddy_capture_from_phone');
    await capture.execute({ keepCopy: true });
    assert.deepEqual(deleted, []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('a real file on disk round-trips through parseMmkv', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wb-mmkv-'));
  try {
    const path = join(directory, 'mmkv.default');
    await writeFile(path, buildMmkv(appEntries()));
    const parsed = parseMmkv(await readFile(path));
    assert.equal(parsed.entries.size, 6);
    assert.equal(uidFrom(valueText(parsed.entries.get('workbuddy_user'))), 'uid-1234');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
