// Regression test: js/letsencrypt/index.js used to swallow errors with a bare
// console.error, leaving the container running with an incomplete cert/config
// setup. It must now rethrow so entrypoint.js can fail fast.

jest.mock('../config.json', () => ({
  site1: { mode: 'letsencrypt', names: ['example.com'], email: 'admin@example.com' },
}), { virtual: true });

jest.mock('../letsencrypt/utils.js', () => ({
  parseCerts: jest.fn(),
  checkCertFiles: jest.fn(),
}));

jest.mock('../utils.js', () => ({
  command: jest.fn(() => Promise.resolve()),
  commandSafe: jest.fn(),
  configFiles: jest.fn(),
}));

jest.mock('../validate.js', () => ({
  validateCronExpression: jest.fn(),
}));

jest.mock('../letsencrypt/manage_certs.js', () => ({
  createCert: jest.fn(),
  deleteCert: jest.fn(),
  createConf: jest.fn(),
}));

const { parseCerts } = require('../letsencrypt/utils.js');
const letsencryptMode = require('../letsencrypt/index.js');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('letsencrypt mode — error propagation', () => {
  it('propagates failures instead of swallowing them', async () => {
    parseCerts.mockRejectedValueOnce(new Error('Failed to query certbot certificates: connection refused'));

    await expect(letsencryptMode()).rejects.toBeDefined();
  });
});
