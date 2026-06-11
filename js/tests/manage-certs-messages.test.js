// Regression test: manage_certs.js error logs used to be generic
// ("manage_certs creation error!", err) with no indication of which
// certificate/domain failed. They must now name the cert id (and, for
// creation, the domains) so operators can act on the message directly.

jest.mock('../config.json', () => ({
  mysite: { names: ['example.com', 'www.example.com'], email: 'admin@example.com', mode: 'letsencrypt' },
}), { virtual: true });

jest.mock('../utils.js', () => ({
  command: jest.fn(),
  commandSafe: jest.fn(),
}));

const { commandSafe } = require('../utils.js');
const { createCert, deleteCert } = require('../letsencrypt/manage_certs.js');

let consoleErrorSpy;

beforeEach(() => {
  jest.clearAllMocks();
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
});

describe('manage_certs — actionable error messages', () => {
  it('createCert failure message identifies the cert id and its domains', async () => {
    commandSafe.mockRejectedValueOnce({ error: 'certbot: connection refused' });

    const result = await createCert('mysite');

    expect(result).toBe(false);
    const [message] = consoleErrorSpy.mock.calls[0];
    expect(message).toEqual(expect.stringContaining('mysite'));
    expect(message).toEqual(expect.stringContaining('example.com'));
  });

  it('deleteCert failure message identifies the cert id', async () => {
    commandSafe.mockRejectedValueOnce({ error: 'certbot: no such certificate' });

    const result = await deleteCert('mysite');

    expect(result).toBe(false);
    const [message] = consoleErrorSpy.mock.calls[0];
    expect(message).toEqual(expect.stringContaining('mysite'));
  });
});
