// createConf()'s self-signed-fallback openssl invocation in
// js/letsencrypt/manage_certs.js — no existing suite exercises it directly;
// every other test that touches createConf mocks the whole export away
// (js/tests/letsencrypt-*.test.js, restore/bootstrap-integration.test.js).
//
// command() now decides success/failure from exit status alone, so the
// `2>&1` this call used to need (to make openssl's stderr-only progress
// output count as success) has been removed. These pin the resulting shell
// string and the propagation behaviour that removal must not change.

jest.mock('../config.json', () => ({
  mysite: { names: ['example.com'], email: 'admin@example.com', mode: 'letsencrypt' },
}), { virtual: true });

jest.mock('fs', () => ({
  readFileSync: jest.fn(() => 'TEMPLATE ${SSL} ${FULLCHAIN} ${PRIVKEY} ${CHAIN}'),
  writeFileSync: jest.fn(),
}));

jest.mock('../utils.js', () => ({
  command: jest.fn(),
  commandSafe: jest.fn(),
}));

const { command } = require('../utils.js');
const { createConf } = require('../letsencrypt/manage_certs.js');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('createConf — self-signed fallback openssl invocation', () => {
  it('runs openssl req for an invalid certificate, without a 2>&1 redirect', async () => {
    command.mockResolvedValue(undefined);

    await createConf('mysite', { status: 'invalid', cert_path: '', cert_key_path: '' });

    expect(command).toHaveBeenCalledTimes(1);
    const [cmd] = command.mock.calls[0];
    expect(cmd).toMatch(/^openssl req -x509/);
    expect(cmd).not.toContain('2>&1');
    expect(cmd).toContain('-keyout /etc/ssl/certs/mysite_privkey.pem');
    expect(cmd).toContain('-out /etc/ssl/certs/mysite_cert.pem');
    expect(cmd).toContain('-newkey rsa:2048');
    expect(cmd).toContain('-days 365');
    expect(cmd).toContain('-nodes');
    expect(cmd).toContain('-subj "/C=UA"');
  });

  it('propagates an openssl failure — createConf has no local recovery', async () => {
    command.mockRejectedValueOnce({ error: 'openssl: permission denied' });

    await expect(
      createConf('mysite', { status: 'invalid', cert_path: '', cert_key_path: '' })
    ).rejects.toBeDefined();
  });

  it('does not run openssl when FORCE_INVALID_ON_FAIL suppresses the fallback', async () => {
    const prev = process.env.FORCE_INVALID_ON_FAIL;
    process.env.FORCE_INVALID_ON_FAIL = 'true';
    try {
      await createConf('mysite', { status: 'invalid', cert_path: '', cert_key_path: '' });
      expect(command).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.FORCE_INVALID_ON_FAIL;
      else process.env.FORCE_INVALID_ON_FAIL = prev;
    }
  });

  it('does not run openssl for a valid certificate', async () => {
    await createConf('mysite', {
      status: 'valid',
      cert_path: '/etc/letsencrypt/live/mysite/fullchain.pem',
      cert_key_path: '/etc/letsencrypt/live/mysite/privkey.pem',
    });

    expect(command).not.toHaveBeenCalled();
  });
});
