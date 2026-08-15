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
//
// The self-signed certificate and the template copy both go through
// commandSafe now: no shell feature was ever needed for either, and the
// openssl invocation only needed a shell in the first place to carry the
// `2>&1` redirect command()'s old stderr-on-success defect required — see
// js/dev/index.js and js/tests/command-helpers.test.js. `command` stays
// mocked here only so its non-use can be asserted as a regression guard.

jest.mock('../utils.js', () => ({
  command: jest.fn(),
  commandSafe: jest.fn(),
  configFiles: jest.fn(),
}));

const { command, commandSafe } = require('../utils.js');
const devMode = require('../dev/index.js');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('dev mode — error propagation', () => {
  it('propagates a failure from the self-signed openssl invocation', async () => {
    commandSafe.mockRejectedValueOnce({ error: 'openssl: permission denied' });

    await expect(devMode()).rejects.toBeDefined();
  });

  it('propagates a failure from the template copy too', async () => {
    commandSafe.mockResolvedValueOnce(undefined); // openssl succeeds
    commandSafe.mockRejectedValueOnce({ error: 'cp: permission denied' }); // cp fails

    await expect(devMode()).rejects.toBeDefined();
  });
});

describe('dev mode — openssl and the template copy both use argument vectors', () => {
  it('generates the self-signed certificate with commandSafe, not a shell string', async () => {
    commandSafe.mockResolvedValue(undefined);

    await devMode();

    const [bin, args] = commandSafe.mock.calls[0];
    expect(bin).toBe('openssl');
    expect(args).toEqual([
      'req', '-x509',
      '-newkey', 'rsa:2048',
      '-keyout', '/etc/ssl/certs/priv_dev.key',
      '-out', '/etc/ssl/certs/cert_dev.crt',
      '-days', '365',
      '-nodes',
      '-subj', '/C=UA',
    ]);
  });

  it('copies the dev SSL fragment with commandSafe, not a shell string', async () => {
    commandSafe.mockResolvedValue(undefined);

    await devMode();

    const [bin, args] = commandSafe.mock.calls.find(([b]) => b === 'cp');
    expect(bin).toBe('cp');
    expect(args).toHaveLength(2);
    expect(args[0]).toMatch(/dev[/\\]templates[/\\]ssl-dev-certificate\.conf$/);
    expect(args[1]).toBe('/etc/nginx/conf/dev.conf');
  });

  it('never routes either call through command() / a shell', async () => {
    commandSafe.mockResolvedValue(undefined);

    await devMode();

    expect(command).not.toHaveBeenCalled();
    expect(commandSafe).toHaveBeenCalledTimes(2);
  });
});
