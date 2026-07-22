// Regression test: js/dev/index.js used to swallow errors with a bare
// console.error, leaving the container running with an incomplete config.
// It must now rethrow so entrypoint.js can fail fast.
//
// dev/index.js is now purely additive: it no longer removes the default
// vhosts (development startup clears both conf.d directories before it runs —
// reconcileDevelopmentConfig in js/reconcile.js), and it no longer has its own
// missing-dev.conf check (F5):
// js/entrypoint.js's development preflight (preflightDev() in
// js/preflight.js) now requires /home/nginx/sites/dev.conf before this
// handler ever runs — see js/tests/preflight.test.js and
// js/tests/entrypoint-dev-preflight-order.test.js.

jest.mock('../utils.js', () => ({
  command: jest.fn(),
  configFiles: jest.fn(),
}));

const { command } = require('../utils.js');
const devMode = require('../dev/index.js');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('dev mode — error propagation', () => {
  it('propagates failures instead of swallowing them', async () => {
    command.mockRejectedValueOnce({ error: 'openssl: permission denied' });

    await expect(devMode()).rejects.toBeDefined();
  });
});
