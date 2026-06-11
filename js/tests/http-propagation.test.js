// Regression test: js/http/index.js used to swallow errors with a bare
// console.error, leaving the container running with an incomplete config.
// It must now rethrow so entrypoint.js can fail fast.

jest.mock('../config.json', () => ({
  site1: { mode: 'http', names: ['example.com'] },
}), { virtual: true });

jest.mock('../utils.js', () => ({
  command: jest.fn(),
  commandSafe: jest.fn(),
}));

const { commandSafe } = require('../utils.js');
const httpMode = require('../http/index.js');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('http mode — error propagation', () => {
  it('propagates failures instead of swallowing them', async () => {
    commandSafe.mockRejectedValueOnce({ error: 'cp: cannot stat template' });

    await expect(httpMode()).rejects.toBeDefined();
  });
});
