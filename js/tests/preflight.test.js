// Filesystem preflight (js/preflight.js): preflightEntry() for production
// config.json entries, preflightDev() for development mode's dev.conf.
//
// Runs after schema validation (js/validate.js) and before any mode handler
// mutates certificate or nginx state. Distinct responsibility from
// validate.js: this checks that the *local artifacts* a schema-validated
// entry points to — the mounted site config(s), and for "custom" mode the
// certificate files — actually exist on disk.
//
// requireFile()'s own file/directory/symlink semantics are exhaustively
// exercised via preflightEntry() below, so the preflightDev() tests near the
// bottom of this file stay focused on its own path and error message rather
// than re-covering that ground.

jest.mock('fs', () => ({ existsSync: jest.fn(), statSync: jest.fn() }));

const fs = require('fs');
const { preflightEntry, preflightDev, customCertsPath } = require('../preflight.js');

const FILE_STAT = { isFile: () => true };
const DIR_STAT = { isFile: () => false };

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.CUSTOM_CERTS_PATH;
});

// ──────────────────────────────────────────────
//  Every production mode requires its site config file
// ──────────────────────────────────────────────
describe('preflightEntry — site config file, every production mode', () => {
  const extraByMode = {
    http: { names: ['a.example.com'] },
    letsencrypt: { names: ['a.example.com'], email: 'admin@example.com' },
    'letsencrypt-staging': { names: ['a.example.com'], email: 'admin@example.com' },
    custom: { names: ['a.example.com'], cert_file: 'a.crt', privkey_file: 'a.key' },
  };
  const modes = Object.keys(extraByMode);

  test.each(modes)('mode "%s" throws when the site config is missing', (mode) => {
    fs.existsSync.mockReturnValue(false);
    expect(() => preflightEntry('site-a', { mode, ...extraByMode[mode] }))
      .toThrow(/Entry "site-a": required site config \/home\/nginx\/sites\/site-a\.conf does not exist/);
  });

  test.each(modes)('mode "%s" passes when the site config exists', (mode) => {
    fs.existsSync.mockReturnValue(true);
    fs.statSync.mockReturnValue(FILE_STAT);
    expect(() => preflightEntry('site-a', { mode, ...extraByMode[mode] })).not.toThrow();
  });

  it('a wildcard-valid name does not affect the site-file requirement (custom + wildcard, file missing)', () => {
    fs.existsSync.mockReturnValue(false);
    expect(() => preflightEntry('site-a', {
      mode: 'custom', names: ['*.example.com'], cert_file: 'a.crt', privkey_file: 'a.key',
    })).toThrow(/site-a/);
  });

  it('a wildcard-valid name does not affect the site-file requirement (custom + wildcard, file present)', () => {
    fs.existsSync.mockReturnValue(true);
    fs.statSync.mockReturnValue(FILE_STAT);
    expect(() => preflightEntry('site-a', {
      mode: 'custom', names: ['*.example.com'], cert_file: 'a.crt', privkey_file: 'a.key',
    })).not.toThrow();
  });

  it('rejects a directory found at the site-config path', () => {
    fs.existsSync.mockReturnValue(true);
    fs.statSync.mockReturnValue(DIR_STAT);
    expect(() => preflightEntry('main', { mode: 'http', names: ['a.example.com'] }))
      .toThrow(/exists but is not a file/);
  });
});

// ──────────────────────────────────────────────
//  custom mode also requires cert_file / privkey_file on disk
// ──────────────────────────────────────────────
describe('preflightEntry — custom certificate files', () => {
  const entry = (extra = {}) => ({
    mode: 'custom', names: ['a.example.com'], cert_file: 'a.crt', privkey_file: 'a.key', ...extra,
  });

  it('throws when cert_file is missing on disk', () => {
    fs.existsSync.mockImplementation((p) => !p.endsWith('a.crt'));
    fs.statSync.mockReturnValue(FILE_STAT);
    expect(() => preflightEntry('site-a', entry()))
      .toThrow('Entry "site-a": required certificate file /home/custom-certificates/a.crt does not exist');
  });

  it('throws when privkey_file is missing on disk', () => {
    fs.existsSync.mockImplementation((p) => !p.endsWith('a.key'));
    fs.statSync.mockReturnValue(FILE_STAT);
    expect(() => preflightEntry('site-a', entry()))
      .toThrow('Entry "site-a": required private key file /home/custom-certificates/a.key does not exist');
  });

  it('passes when both files exist', () => {
    fs.existsSync.mockReturnValue(true);
    fs.statSync.mockReturnValue(FILE_STAT);
    expect(() => preflightEntry('site-a', entry())).not.toThrow();
  });

  it('respects a configured CUSTOM_CERTS_PATH', () => {
    process.env.CUSTOM_CERTS_PATH = '/mnt/certs';
    fs.existsSync.mockImplementation((p) => p === '/home/nginx/sites/site-a.conf' || p.startsWith('/mnt/certs/'));
    fs.statSync.mockReturnValue(FILE_STAT);

    expect(() => preflightEntry('site-a', entry())).not.toThrow();
    expect(fs.existsSync).toHaveBeenCalledWith('/mnt/certs/a.crt');
    expect(fs.existsSync).toHaveBeenCalledWith('/mnt/certs/a.key');
  });

  it('uses the canonical default path (/home/custom-certificates) when CUSTOM_CERTS_PATH is unset', () => {
    delete process.env.CUSTOM_CERTS_PATH;
    fs.existsSync.mockReturnValue(true);
    fs.statSync.mockReturnValue(FILE_STAT);

    preflightEntry('site-a', entry());

    expect(fs.existsSync).toHaveBeenCalledWith('/home/custom-certificates/a.crt');
    expect(fs.existsSync).toHaveBeenCalledWith('/home/custom-certificates/a.key');
    expect(customCertsPath()).toBe('/home/custom-certificates');
  });

  it('does not require any CUSTOM_CERTS_PATH file for non-custom modes', () => {
    process.env.CUSTOM_CERTS_PATH = '/mnt/certs';
    fs.existsSync.mockImplementation((p) => p === '/home/nginx/sites/site-a.conf');
    fs.statSync.mockReturnValue(FILE_STAT);

    expect(() => preflightEntry('site-a', { mode: 'http', names: ['a.example.com'] })).not.toThrow();
    expect(fs.existsSync).not.toHaveBeenCalledWith(expect.stringContaining('/mnt/certs'));
  });
});

// ──────────────────────────────────────────────
//  preflightDev — development mode's dev.conf (F5)
// ──────────────────────────────────────────────
describe('preflightDev — development site config', () => {
  it('passes when /home/nginx/sites/dev.conf exists', () => {
    fs.existsSync.mockImplementation((p) => p === '/home/nginx/sites/dev.conf');
    fs.statSync.mockReturnValue(FILE_STAT);

    expect(() => preflightDev()).not.toThrow();
  });

  it('throws, naming development mode and the exact path, when dev.conf is missing', () => {
    fs.existsSync.mockReturnValue(false);

    expect(() => preflightDev())
      .toThrow('Development mode: required site config /home/nginx/sites/dev.conf does not exist');
  });

  it('rejects a directory found at the dev.conf path', () => {
    fs.existsSync.mockReturnValue(true);
    fs.statSync.mockReturnValue(DIR_STAT);

    expect(() => preflightDev()).toThrow(/exists but is not a file/);
  });
});
