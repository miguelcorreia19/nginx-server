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
}));

jest.mock('../custom/utils.js', () => ({
  createConf: jest.fn(),
  checkCertFiles: jest.fn(() => true),
}));

const { commandSafe, configFiles } = require('../utils.js');
const { checkCertFiles } = require('../custom/utils.js');
const customMode = require('../custom/index.js');

beforeEach(() => {
  jest.clearAllMocks();
  checkCertFiles.mockReturnValue(true);
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
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
