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

// mapCustomNginxConf links operator-supplied paths (CUSTOM_NGINX_CONFIG_FILES_PATH)
// into /etc/nginx, so it uses commandSafe/execFile rather than a shell string:
// a directory containing a space or a shell metacharacter must reach ln(1) as
// one literal argument, not be re-parsed by a shell.
//
// The vector also carries `--`. Dropping the shell does not stop ln from
// parsing its own argv, and nothing validates that path, so a value beginning
// with `-` would otherwise be read as flags.
describe('mapCustomNginxConf — async sequencing', () => {
  it('awaits every symlink before the function resolves', async () => {
    const completed = [];

    execFile.mockImplementation((bin, args, opts, cb) => {
      // Resolve on next tick so the test can detect premature resolution.
      setImmediate(() => {
        completed.push(args);
        cb(null, 'ok', '');
      });
    });
    existsSync.mockReturnValue(true);

    await mapCustomNginxConf(['nginx.conf', 'proxy.conf', 'http-common.conf'], '/custom/configs');

    // All three commands must have completed by the time await returns.
    expect(completed).toHaveLength(3);
    expect(execFile).toHaveBeenCalledTimes(3);
  });

  it('skips files that do not exist at the given path', async () => {
    execFile.mockImplementation((bin, args, opts, cb) => cb(null, 'ok', ''));
    existsSync.mockReturnValue(false);

    await mapCustomNginxConf(['nginx.conf'], '/custom/configs');

    expect(execFile).not.toHaveBeenCalled();
  });

  it('creates a symlink for each existing file with the correct argument vector', async () => {
    execFile.mockImplementation((bin, args, opts, cb) => cb(null, 'ok', ''));
    existsSync.mockReturnValue(true);

    await mapCustomNginxConf(['nginx.conf', 'proxy.conf'], '/custom/configs');

    expect(execFile).toHaveBeenCalledWith(
      'ln',
      ['-sf', '--', '/custom/configs/nginx.conf', '/etc/nginx/nginx.conf'],
      expect.any(Object),
      expect.any(Function)
    );
    expect(execFile).toHaveBeenCalledWith(
      'ln',
      ['-sf', '--', '/custom/configs/proxy.conf', '/etc/nginx/proxy.conf'],
      expect.any(Object),
      expect.any(Function)
    );
  });

  it('never routes the link through a shell', async () => {
    execFile.mockImplementation((bin, args, opts, cb) => cb(null, 'ok', ''));
    existsSync.mockReturnValue(true);

    await mapCustomNginxConf(['nginx.conf'], '/custom/configs');

    expect(exec).not.toHaveBeenCalled();
  });

  it('handles an empty file list without running anything', async () => {
    execFile.mockImplementation((bin, args, opts, cb) => cb(null, 'ok', ''));
    existsSync.mockReturnValue(true);

    await mapCustomNginxConf([], '/custom/configs');

    expect(execFile).not.toHaveBeenCalled();
  });

  it('only symlinks files whose path exists', async () => {
    execFile.mockImplementation((bin, args, opts, cb) => cb(null, 'ok', ''));
    existsSync.mockImplementation((p) => p.includes('nginx.conf'));

    await mapCustomNginxConf(['nginx.conf', 'proxy.conf'], '/custom/configs');

    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile).toHaveBeenCalledWith(
      'ln',
      ['-sf', '--', '/custom/configs/nginx.conf', '/etc/nginx/nginx.conf'],
      expect.any(Object),
      expect.any(Function)
    );
  });

  // The reason this call site moved off the shell helper: an operator-supplied
  // override directory is a plain path, and paths legitimately contain spaces.
  it('passes a path containing spaces as one literal argument', async () => {
    execFile.mockImplementation((bin, args, opts, cb) => cb(null, 'ok', ''));
    existsSync.mockReturnValue(true);

    await mapCustomNginxConf(['nginx.conf'], '/mnt/My Nginx Overrides');

    expect(execFile).toHaveBeenCalledWith(
      'ln',
      ['-sf', '--', '/mnt/My Nginx Overrides/nginx.conf', '/etc/nginx/nginx.conf'],
      expect.any(Object),
      expect.any(Function)
    );
  });

  it('passes shell metacharacters in the path through literally', async () => {
    execFile.mockImplementation((bin, args, opts, cb) => cb(null, 'ok', ''));
    existsSync.mockReturnValue(true);

    await mapCustomNginxConf(['nginx.conf'], '/mnt/a b;$(id)&`x`');

    const [, args] = execFile.mock.calls[0];
    expect(args).toEqual(['-sf', '--', '/mnt/a b;$(id)&`x`/nginx.conf', '/etc/nginx/nginx.conf']);
    expect(exec).not.toHaveBeenCalled();
  });

  // The half execFile does not cover: ln parses its own argv, so a relative
  // override directory beginning with `-` would be read as flags. The BusyBox
  // 1.37.0 this image ships answers `ln: unrecognized option: t` for
  // `-target/nginx.conf`; `--` ahead of it makes it an operand again.
  it('keeps a path beginning with a hyphen behind the end-of-options marker', async () => {
    execFile.mockImplementation((bin, args, opts, cb) => cb(null, 'ok', ''));
    existsSync.mockReturnValue(true);

    await mapCustomNginxConf(['nginx.conf'], '-target');

    const [, args] = execFile.mock.calls[0];
    expect(args).toEqual(['-sf', '--', '-target/nginx.conf', '/etc/nginx/nginx.conf']);
    // Every operand comes after the marker, so none of them can be parsed as
    // an option however it starts.
    expect(args.indexOf('--')).toBeLessThan(args.indexOf('-target/nginx.conf'));
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
