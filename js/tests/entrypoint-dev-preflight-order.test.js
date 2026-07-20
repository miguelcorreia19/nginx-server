// F5 regression: development-mode startup must preflight dev.conf BEFORE
// dev() runs. A missing dev.conf must abort startup fatally — never the old
// "successful" process.exit(0) — before dev() or any production handler
// executes. A present dev.conf must still reach the same common post-switch
// startup steps (nginx config override mapping, nginx -t, Fail2ban, renewal
// migration) as before this fix.
//
// js/entrypoint.js has no exports and calls its own start() at module load
// (a self-executing script) — full mocking of its dependencies, mirroring
// entrypoint-preflight-order.test.js's convention, lets this test observe
// the real handlers and common steps directly rather than reimplementing
// entrypoint.js's logic.

jest.mock('../config.json', () => ({}), { virtual: true });

jest.mock('../letsencrypt', () => jest.fn(() => Promise.resolve()));
jest.mock('../dev', () => jest.fn(() => Promise.resolve()));
jest.mock('../custom', () => jest.fn(() => Promise.resolve()));
jest.mock('../http', () => jest.fn(() => Promise.resolve()));
jest.mock('../fail2ban', () => jest.fn(() => Promise.resolve()));
jest.mock('../letsencrypt/migrate_renewal', () => jest.fn());

jest.mock('../utils.js', () => ({
  command: jest.fn(() => Promise.resolve()),
  mapCustomNginxConf: jest.fn(() => Promise.resolve()),
  validateNginxConfig: jest.fn(() => Promise.resolve()),
}));

jest.mock('fs', () => ({ existsSync: jest.fn(), statSync: jest.fn() }));

const fs = require('fs');

const FILE_STAT = { isFile: () => true };

// Flushes the entire microtask chain of a sequence of already-resolved
// awaits (dev() -> mapCustomNginxConf() -> validateNginxConfig() ->
// fail2ban()) — Node drains the microtask queue to empty, however deep the
// chain, before a scheduled setImmediate callback runs.
const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

const freshMocks = () => ({
  dev: require('../dev'),
  letsencrypt: require('../letsencrypt'),
  custom: require('../custom'),
  http: require('../http'),
  fail2ban: require('../fail2ban'),
  migrateRenewalConfigs: require('../letsencrypt/migrate_renewal'),
  mapCustomNginxConf: require('../utils.js').mapCustomNginxConf,
  validateNginxConfig: require('../utils.js').validateNginxConfig,
});

describe('entrypoint — development preflight', () => {
  let exitSpy;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.ENVIRONMENT = 'development';

    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('aborts before dev() or any handler runs when dev.conf is missing (never a successful exit(0))', () => {
    fs.existsSync.mockReturnValue(false);
    const mocks = freshMocks();

    require('../entrypoint.js');

    // Fatal, non-zero exit — the old code path exited 0 here and let
    // entrypoint.sh continue on to start nginx anyway.
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(exitSpy).not.toHaveBeenCalledWith(0);

    expect(mocks.dev).not.toHaveBeenCalled();
    expect(mocks.letsencrypt).not.toHaveBeenCalled();
    expect(mocks.custom).not.toHaveBeenCalled();
    expect(mocks.http).not.toHaveBeenCalled();

    // The common post-switch startup steps must not run either — the old
    // process.exit(0) path skipped these too, which was itself part of F5.
    expect(mocks.mapCustomNginxConf).not.toHaveBeenCalled();
    expect(mocks.validateNginxConfig).not.toHaveBeenCalled();
    expect(mocks.fail2ban).not.toHaveBeenCalled();
    expect(mocks.migrateRenewalConfigs).not.toHaveBeenCalled();
  });

  it('runs dev() and still reaches the common post-switch startup steps when dev.conf exists', async () => {
    fs.existsSync.mockImplementation((p) => p === '/home/nginx/sites/dev.conf');
    fs.statSync.mockReturnValue(FILE_STAT);
    const mocks = freshMocks();

    require('../entrypoint.js');
    await flushMicrotasks();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(mocks.dev).toHaveBeenCalledTimes(1);
    expect(mocks.letsencrypt).not.toHaveBeenCalled();
    expect(mocks.custom).not.toHaveBeenCalled();
    expect(mocks.http).not.toHaveBeenCalled();

    expect(mocks.mapCustomNginxConf).toHaveBeenCalled();
    expect(mocks.validateNginxConfig).toHaveBeenCalled();
    expect(mocks.fail2ban).toHaveBeenCalled();
    expect(mocks.migrateRenewalConfigs).toHaveBeenCalled();
  });
});
