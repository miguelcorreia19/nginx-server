// createConf()'s self-signed-fallback openssl invocation in
// js/letsencrypt/manage_certs.js — no existing suite exercises it directly;
// every other test that touches createConf mocks the whole export away
// (js/tests/letsencrypt-*.test.js, restore/bootstrap-integration.test.js).
//
// No shell feature (piping, redirection, globbing) was ever needed for this
// invocation — the only interpolated value is the certificate id, which
// validateCertId() (js/validate.js) has already restricted to an alphanumeric
// start plus letters/digits/dots/hyphens/underscores for every config.json
// entry before any handler runs. It moved to commandSafe (execFile) once
// command()'s stderr-on-success defect — the reason it needed a shell-string
// `2>&1` redirect at all — was fixed. These pin the resulting argument
// vector and the propagation behaviour the migration must not change.

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

const { command, commandSafe } = require('../utils.js');
const { createConf } = require('../letsencrypt/manage_certs.js');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('createConf — self-signed fallback openssl invocation', () => {
  it('runs openssl through commandSafe, with the certificate id only in the two output paths', async () => {
    commandSafe.mockResolvedValue(undefined);

    await createConf('mysite', { status: 'invalid', cert_path: '', cert_key_path: '' });

    expect(commandSafe).toHaveBeenCalledTimes(1);
    const [bin, args] = commandSafe.mock.calls[0];
    expect(bin).toBe('openssl');
    expect(args).toEqual([
      'req', '-x509',
      '-newkey', 'rsa:2048',
      '-keyout', '/etc/ssl/certs/mysite_privkey.pem',
      '-out', '/etc/ssl/certs/mysite_cert.pem',
      '-days', '365',
      '-nodes',
      '-subj', '/C=UA',
    ]);

    // The interpolated id appears only inside the two output-path operands —
    // never as a bare argv element, where it could be read as an option or
    // an unrelated positional argument.
    const idBearing = args.filter((a) => a.includes('mysite'));
    expect(idBearing).toEqual([
      '/etc/ssl/certs/mysite_privkey.pem',
      '/etc/ssl/certs/mysite_cert.pem',
    ]);

    expect(command).not.toHaveBeenCalled();
  });

  it('propagates an openssl failure — createConf has no local recovery', async () => {
    commandSafe.mockRejectedValueOnce({ error: 'openssl: permission denied' });

    await expect(
      createConf('mysite', { status: 'invalid', cert_path: '', cert_key_path: '' })
    ).rejects.toEqual({ error: 'openssl: permission denied' });
  });

  it('does not run openssl when FORCE_INVALID_ON_FAIL suppresses the fallback', async () => {
    const prev = process.env.FORCE_INVALID_ON_FAIL;
    process.env.FORCE_INVALID_ON_FAIL = 'true';
    try {
      await createConf('mysite', { status: 'invalid', cert_path: '', cert_key_path: '' });
      expect(commandSafe).not.toHaveBeenCalled();
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

    expect(commandSafe).not.toHaveBeenCalled();
  });
});
