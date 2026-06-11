// Tests validateNginxConfig() in js/utils.js.
//
// Phase 3C fix: the function now uses spawn() with stdio mapped to a real temp
// file instead of execFile() with anonymous pipes. The repository's nginx.conf
// contains `error_log /dev/stderr warn;`. nginx resolves that to
// /proc/self/fd/2 and reopens it via open(2) during `-t` initialisation;
// open(2) on an anonymous pipe (which execFile/exec use for captured stdio)
// fails with ENXIO, falsely reporting any valid config as broken. A regular
// file is always re-openable by path, so the fix is reliable across all Docker
// log-driver / stdio configurations.

const { EventEmitter } = require('events');
const fs = require('fs');

jest.mock('child_process', () => ({ spawn: jest.fn(), exec: jest.fn(), execFile: jest.fn() }));

const { spawn, execFile } = require('child_process');
const { validateNginxConfig } = require('../utils.js');

beforeEach(() => {
  jest.clearAllMocks();
});

// Helper: mock spawn to write `output` to the fd passed in opts.stdio, then
// emit 'close' with `exitCode`. Writing through the real fd means the
// implementation's readFileSync picks up the mocked output exactly as it
// would from a real nginx process.
const mockSpawn = (output, exitCode) => {
  spawn.mockImplementation((bin, args, opts) => {
    const em = new EventEmitter();
    const outFd = Array.isArray(opts && opts.stdio) ? opts.stdio[1] : null;
    setImmediate(() => {
      if (outFd != null && Number.isInteger(outFd) && outFd > 2) {
        try { fs.writeSync(outFd, output); } catch (_) {}
      }
      em.emit('close', exitCode);
    });
    return em;
  });
};

// Helper: mock a spawn-level error (e.g. binary not found) followed by close.
const mockSpawnError = (message) => {
  spawn.mockImplementation(() => {
    const em = new EventEmitter();
    setImmediate(() => {
      em.emit('error', new Error(message));
      em.emit('close', 127);
    });
    return em;
  });
};

describe('validateNginxConfig — nginx -t wrapper (Phase 3C: spawn + temp file)', () => {
  it('uses spawn (not execFile) to avoid anonymous-pipe /dev/stderr false failures', async () => {
    mockSpawn('nginx: configuration file /etc/nginx/nginx.conf test is successful\n', 0);

    await validateNginxConfig();

    expect(spawn).toHaveBeenCalledWith('nginx', ['-t'], expect.any(Object));
    expect(execFile).not.toHaveBeenCalled();
  });

  it('passes stdio as an array with integer fd values so nginx can reopen /proc/self/fd/2', async () => {
    mockSpawn('', 0);

    await validateNginxConfig();

    const opts = spawn.mock.calls[0][2];
    expect(Array.isArray(opts.stdio)).toBe(true);
    expect(typeof opts.stdio[1]).toBe('number');
    expect(typeof opts.stdio[2]).toBe('number');
    expect(opts.stdio[1]).not.toBe('pipe');
    expect(opts.stdio[2]).not.toBe('pipe');
  });

  it('resolves on success even when nginx writes its message to stderr', async () => {
    const msg = 'nginx: configuration file /etc/nginx/nginx.conf test is successful\n';
    mockSpawn(msg, 0);

    await expect(validateNginxConfig()).resolves.toEqual(
      expect.stringContaining('test is successful')
    );
  });

  it('rejects with the nginx diagnostic text when the config is invalid', async () => {
    const diagnostic =
      'nginx: [emerg] unknown directive "boguss" in /etc/nginx/conf.d/443/site.conf:5\n' +
      'nginx: configuration file /etc/nginx/nginx.conf test failed\n';
    mockSpawn(diagnostic, 1);

    await expect(validateNginxConfig()).rejects.toEqual({
      error: expect.stringContaining('unknown directive "boguss"'),
    });
  });

  it('falls back to an exit-code message when nginx produces no output', async () => {
    mockSpawn('', 1);

    await expect(validateNginxConfig()).rejects.toEqual({
      error: expect.stringContaining('exited with code'),
    });
  });

  it('rejects with the spawn error message when nginx is not found (ENOENT)', async () => {
    mockSpawnError('spawn nginx ENOENT');

    await expect(validateNginxConfig()).rejects.toEqual({ error: 'spawn nginx ENOENT' });
  });

  it('resolves cleanly even if nginx emits nothing on success', async () => {
    mockSpawn('', 0);

    await expect(validateNginxConfig()).resolves.toBeDefined();
  });
});
