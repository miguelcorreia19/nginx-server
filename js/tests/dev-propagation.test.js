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
  commandSafe: jest.fn(),
  configFiles: jest.fn(),
}));

const { command, commandSafe } = require('../utils.js');
const devMode = require('../dev/index.js');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('dev mode — error propagation', () => {
  it('propagates failures instead of swallowing them', async () => {
    command.mockRejectedValueOnce({ error: 'openssl: permission denied' });

    await expect(devMode()).rejects.toBeDefined();
  });

  it('propagates a failure from the template copy too', async () => {
    command.mockResolvedValue('');
    commandSafe.mockRejectedValueOnce({ error: 'cp: permission denied' });

    await expect(devMode()).rejects.toBeDefined();
  });
});

// The self-signed certificate still comes from the shell helper (its `2>&1`
// redirection is load-bearing — see js/dev/index.js), but the template copy
// takes a __dirname-derived path, so it goes through execFile like the
// equivalent copy in js/http/index.js.
describe('dev mode — template copy uses an argument vector', () => {
  it('copies the dev SSL fragment with commandSafe, not a shell string', async () => {
    command.mockResolvedValue('');
    commandSafe.mockResolvedValue('');

    await devMode();

    const [bin, args] = commandSafe.mock.calls.find(([b]) => b === 'cp');
    expect(bin).toBe('cp');
    expect(args).toHaveLength(2);
    expect(args[0]).toMatch(/dev[/\\]templates[/\\]ssl-dev-certificate\.conf$/);
    expect(args[1]).toBe('/etc/nginx/conf/dev.conf');

    // The only shell command left in this handler is the openssl one.
    const shellCommands = command.mock.calls.map(([cmd]) => String(cmd));
    expect(shellCommands).toHaveLength(1);
    expect(shellCommands[0]).toMatch(/^openssl req -x509/);
  });
});
