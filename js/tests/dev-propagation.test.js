// Regression test: js/dev/index.js used to swallow errors with a bare
// console.error, leaving the container running with an incomplete config.
// It must now rethrow so entrypoint.js can fail fast. The intentional
// process.exit(0) when /home/nginx/sites/dev.conf is missing is untouched
// and is not exercised by this test.

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
    command.mockRejectedValueOnce({ error: 'rm: permission denied' });

    await expect(devMode()).rejects.toBeDefined();
  });
});
