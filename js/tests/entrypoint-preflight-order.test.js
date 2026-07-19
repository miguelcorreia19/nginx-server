// Ordering guarantee: filesystem preflight must complete for every
// production entry BEFORE any mode handler runs. A later site's missing
// file must abort startup even though an earlier site is completely valid
// — and no handler may have been invoked by the time that happens.
//
// js/entrypoint.js has no exports and calls its own start() at module load
// (a self-executing script) — full mocking of its dependencies, mirroring
// the existing *-propagation.test.js convention, lets this test observe the
// real handlers directly rather than reimplementing entrypoint.js's logic.
// Everything up to and including the preflight failure runs synchronously
// (no `await` is reached before it), so requiring the module is enough —
// no need to await or flush microtasks before asserting.

jest.mock('../config.json', () => ({
  'site-ok': { mode: 'http', names: ['ok.example.com'] },
  'site-missing': { mode: 'http', names: ['missing.example.com'] },
}), { virtual: true });

jest.mock('../letsencrypt', () => jest.fn(() => Promise.resolve()));
jest.mock('../dev', () => jest.fn(() => Promise.resolve()));
jest.mock('../custom', () => jest.fn(() => Promise.resolve()));
jest.mock('../http', () => jest.fn(() => Promise.resolve()));

jest.mock('fs', () => ({ existsSync: jest.fn(), statSync: jest.fn() }));

const fs = require('fs');

const FILE_STAT = { isFile: () => true };

describe('entrypoint — preflight completes for all entries before any handler runs', () => {
  let exitSpy;

  beforeEach(() => {
    jest.resetModules();
    process.env.ENVIRONMENT = 'production';
    delete process.env.CUSTOM_CERTS_PATH;

    // Only "site-ok"'s site config exists; "site-missing"'s does not.
    fs.existsSync.mockImplementation((p) => p === '/home/nginx/sites/site-ok.conf');
    fs.statSync.mockReturnValue(FILE_STAT);

    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('aborts startup before any handler runs, even though the first site is valid', () => {
    const letsencrypt = require('../letsencrypt');
    const dev = require('../dev');
    const custom = require('../custom');
    const http = require('../http');

    require('../entrypoint.js');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(letsencrypt).not.toHaveBeenCalled();
    expect(dev).not.toHaveBeenCalled();
    expect(custom).not.toHaveBeenCalled();
    expect(http).not.toHaveBeenCalled();

    // "site-ok" was checked (and passed) before "site-missing" was found broken —
    // proving preflight ran across the whole config, in order, not just the
    // first entry it happened to fail on.
    const existsCalls = fs.existsSync.mock.calls.map(([p]) => p);
    expect(existsCalls.indexOf('/home/nginx/sites/site-ok.conf'))
      .toBeLessThan(existsCalls.indexOf('/home/nginx/sites/site-missing.conf'));
  });
});
