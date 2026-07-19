// Mocks must be declared before any require of the module under test.
jest.mock('child_process', () => ({ exec: jest.fn(), execFile: jest.fn() }));
jest.mock('fs', () => ({ existsSync: jest.fn() }));

const { exec, execFile } = require('child_process');
const { existsSync } = require('fs');

// Fresh module reference after mocks are wired.
const { mapCustomNginxConf, configFiles } = require('../utils.js');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('mapCustomNginxConf — async sequencing', () => {
  it('awaits every symlink before the function resolves', async () => {
    const completed = [];

    exec.mockImplementation((cmd, cb) => {
      // Resolve on next tick so the test can detect premature resolution.
      setImmediate(() => {
        completed.push(cmd);
        cb(null, 'ok', '');
      });
    });
    existsSync.mockReturnValue(true);

    await mapCustomNginxConf(['nginx.conf', 'proxy.conf', 'http-common.conf'], '/custom/configs');

    // All three commands must have completed by the time await returns.
    expect(completed).toHaveLength(3);
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it('skips files that do not exist at the given path', async () => {
    exec.mockImplementation((cmd, cb) => cb(null, 'ok', ''));
    existsSync.mockReturnValue(false);

    await mapCustomNginxConf(['nginx.conf'], '/custom/configs');

    expect(exec).not.toHaveBeenCalled();
  });

  it('creates a symlink for each existing file with the correct command', async () => {
    exec.mockImplementation((cmd, cb) => cb(null, 'ok', ''));
    existsSync.mockReturnValue(true);

    await mapCustomNginxConf(['nginx.conf', 'proxy.conf'], '/custom/configs');

    expect(exec).toHaveBeenCalledWith(
      'ln -sf /custom/configs/nginx.conf /etc/nginx/nginx.conf',
      expect.any(Function)
    );
    expect(exec).toHaveBeenCalledWith(
      'ln -sf /custom/configs/proxy.conf /etc/nginx/proxy.conf',
      expect.any(Function)
    );
  });

  it('handles an empty file list without calling exec', async () => {
    exec.mockImplementation((cmd, cb) => cb(null, 'ok', ''));
    existsSync.mockReturnValue(true);

    await mapCustomNginxConf([], '/custom/configs');

    expect(exec).not.toHaveBeenCalled();
  });

  it('only symlinks files whose path exists', async () => {
    exec.mockImplementation((cmd, cb) => cb(null, 'ok', ''));
    existsSync.mockImplementation((p) => p.includes('nginx.conf'));

    await mapCustomNginxConf(['nginx.conf', 'proxy.conf'], '/custom/configs');

    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith(
      'ln -sf /custom/configs/nginx.conf /etc/nginx/nginx.conf',
      expect.any(Function)
    );
  });
});

// configFiles() is shared by the letsencrypt, custom, and dev handlers. A
// missing site config used to be a silent, non-fatal skip; after the
// filesystem-preflight step (js/preflight.js) that already guarantees the
// file exists before any production handler runs, this is now a defensive
// check only — and it must be fatal, not a silent skip, if it ever fires
// (e.g. the file disappearing between preflight and this call).
//
// http_redirect is passed as `false` throughout so these cases never reach
// httpRedirect()'s own template read/write — that behavior is covered by
// acme-webroot.test.js / templates.test.js.
describe('configFiles — site linking is fatal on a missing file, unlike an invalid certificate', () => {
  beforeEach(() => {
    execFile.mockImplementation((bin, args, opts, cb) => cb(null, '', ''));
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('links the site config when the certificate is valid and the file exists', async () => {
    existsSync.mockReturnValue(true);

    await configFiles('main', 'valid', false, ['example.com']);

    expect(execFile).toHaveBeenCalledWith(
      'ln',
      ['-sf', '/home/nginx/sites/main.conf', '/etc/nginx/conf.d/443/main.conf'],
      expect.any(Object),
      expect.any(Function)
    );
  });

  it('throws instead of silently skipping when the site config is missing', async () => {
    existsSync.mockReturnValue(false);

    await expect(configFiles('main', 'valid', false, ['example.com']))
      .rejects.toThrow(/missing site config \/home\/nginx\/sites\/main\.conf/);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('still skips (non-fatal) an invalid certificate — an external Certbot outcome, unrelated to local files', async () => {
    await expect(configFiles('main', 'invalid', false, ['example.com'])).resolves.toBeUndefined();

    expect(execFile).not.toHaveBeenCalled();
    // The site file's presence is irrelevant to an invalid-certificate skip
    // — it must not even be checked for this (external) failure class.
    expect(existsSync).not.toHaveBeenCalled();
  });
});
