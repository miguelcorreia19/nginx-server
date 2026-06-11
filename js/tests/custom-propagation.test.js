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

const { commandSafe } = require('../utils.js');
const customMode = require('../custom/index.js');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('custom mode — error propagation', () => {
  it('propagates failures instead of swallowing them', async () => {
    commandSafe.mockRejectedValueOnce({ error: 'cp: permission denied' });

    await expect(customMode()).rejects.toBeDefined();
  });
});
