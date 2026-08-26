// Regression test: js/custom/index.js used to swallow errors with a bare
// console.error, leaving the container running with an incomplete config.
// It must now rethrow so entrypoint.js can fail fast.

jest.mock('../config.json', () => ({
  site1: {
    mode: 'custom',
    names: ['example.com'],
    cert_file: 'site.pem',
    privkey_file: 'site.key',
  },
}), { virtual: true });

jest.mock('../utils.js', () => ({
  configFiles: jest.fn(),
  commandSafe: jest.fn(),
  // Not used by js/custom/index.js, and mocked here so the guarding tests below
  // can assert it stays that way — command() runs a shell string and must never
  // be handed an operator-supplied path.
  command: jest.fn(),
}));

jest.mock('../custom/utils.js', () => ({
  createConf: jest.fn(),
  checkCertFiles: jest.fn(() => true),
}));

const { commandSafe, command, configFiles } = require('../utils.js');
const { checkCertFiles } = require('../custom/utils.js');
const customMode = require('../custom/index.js');

const ORIGINAL_CUSTOM_CERTS_PATH = process.env.CUSTOM_CERTS_PATH;

beforeEach(() => {
  jest.clearAllMocks();
  checkCertFiles.mockReturnValue(true);
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  if (ORIGINAL_CUSTOM_CERTS_PATH === undefined) delete process.env.CUSTOM_CERTS_PATH;
  else process.env.CUSTOM_CERTS_PATH = ORIGINAL_CUSTOM_CERTS_PATH;
});

describe('custom mode — error propagation', () => {
  it('propagates failures instead of swallowing them', async () => {
    commandSafe.mockRejectedValueOnce({ error: 'cp: permission denied' });

    await expect(customMode()).rejects.toBeDefined();
  });
});

// js/preflight.js already guarantees cert_file/privkey_file exist under
// CUSTOM_CERTS_PATH before any production handler runs — this used to be a
// non-fatal warn-and-skip ("Certificate ... is missing required file(s) ...
// skipping"). It is now a defensive check only, for either file
// disappearing between preflight and this call, and must be fatal.
describe('custom mode — missing certificate files are fatal, not a silent skip', () => {
  it('rejects instead of skipping when checkCertFiles reports the files missing', async () => {
    checkCertFiles.mockReturnValue(false);

    await expect(customMode()).rejects.toBeDefined();
  });

  it('never attempts to copy or link when the certificate files are missing', async () => {
    checkCertFiles.mockReturnValue(false);

    await expect(customMode()).rejects.toBeDefined();

    expect(commandSafe).not.toHaveBeenCalled();
    expect(configFiles).not.toHaveBeenCalled();
  });
});

// CUSTOM_CERTS_PATH is operator-supplied and nothing validates it, so it reaches
// cp(1) beginning with whatever the operator set. execFile removes the *shell*,
// not cp's own option parser: observed against this image's BusyBox 1.37.0, a
// `-badcerts/site.pem` source answers `cp: unrecognized option: b` and dumps
// cp's usage — which is what the operator then saw as the fatal startup error,
// with nothing naming the certificate or the path. `--` makes it an operand
// again, matching the guard already carried by the backup copies in
// js/letsencrypt/utils.js and the symlink in mapCustomNginxConf.
describe('custom mode — end-of-options guarding for CUSTOM_CERTS_PATH', () => {
  const copies = () =>
    commandSafe.mock.calls.filter(([bin]) => bin === 'cp').map(([bin, args]) => [bin, args]);

  it('passes -- before the operands of both copies', async () => {
    process.env.CUSTOM_CERTS_PATH = '/home/custom-certificates';

    await customMode();

    expect(copies()).toEqual([
      ['cp', ['--', '/home/custom-certificates/site.pem', '/etc/ssl/certs/site.pem']],
      ['cp', ['--', '/home/custom-certificates/site.key', '/etc/ssl/certs/site.key']],
    ]);
  });

  it('keeps a path beginning with a hyphen behind the separator', async () => {
    process.env.CUSTOM_CERTS_PATH = '-badcerts';

    await customMode();

    expect(copies()).toEqual([
      ['cp', ['--', '-badcerts/site.pem', '/etc/ssl/certs/site.pem']],
      ['cp', ['--', '-badcerts/site.key', '/etc/ssl/certs/site.key']],
    ]);
    // Both the certificate and the private key, not just whichever is copied
    // first — the second copy is as reachable as the first.
    expect(copies()).toHaveLength(2);
    for (const [, args] of copies()) {
      expect(args.indexOf('--')).toBeLessThan(args.findIndex((a) => a.startsWith('-badcerts')));
    }
  });

  it('passes spaces and shell metacharacters through as one literal argument', async () => {
    process.env.CUSTOM_CERTS_PATH = '/mnt/a b;$(id)&&`x`';

    await customMode();

    expect(copies()).toEqual([
      ['cp', ['--', '/mnt/a b;$(id)&&`x`/site.pem', '/etc/ssl/certs/site.pem']],
      ['cp', ['--', '/mnt/a b;$(id)&&`x`/site.key', '/etc/ssl/certs/site.key']],
    ]);
  });

  it('still copies through the argument-vector helper, never a shell string', async () => {
    process.env.CUSTOM_CERTS_PATH = '/home/custom-certificates';

    await customMode();

    expect(commandSafe).toHaveBeenCalled();
    expect(command).not.toHaveBeenCalled();
  });
});
