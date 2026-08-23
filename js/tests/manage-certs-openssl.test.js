// createConf() in js/letsencrypt/manage_certs.js — production never generates
// a self-signed certificate.
//
// createConf() used to fall back to an openssl self-signed certificate when a
// Let's Encrypt certificate came back invalid, writing /etc/ssl/certs/<id>_cert.pem,
// overwriting /etc/ssl/certs/<id>_privkey.pem, and rendering a fragment that
// pointed at both. That fallback could never take effect: a fragment under
// /etc/nginx/conf/ is only loaded through the conf.d/443 symlink configFiles()
// creates (js/utils.js), and configFiles() returns early for exactly this
// status — so the site was never linked and nginx never read the fragment.
//
// These tests pin the removal from both sides: nothing is generated or written
// for an invalid certificate, and the valid path still renders and writes
// exactly as before. Self-signed generation now belongs to development mode
// alone (js/dev/index.js, covered by js/tests/dev-propagation.test.js).

jest.mock('../config.json', () => ({
  mysite: { names: ['example.com'], email: 'admin@example.com', mode: 'letsencrypt' },
}), { virtual: true });

jest.mock('fs', () => ({
  readFileSync: jest.fn(() => 'TEMPLATE ${FULLCHAIN} ${PRIVKEY} ${CHAIN}'),
  writeFileSync: jest.fn(),
}));

jest.mock('../utils.js', () => ({
  command: jest.fn(),
  commandSafe: jest.fn(),
}));

const fs = require('fs');
const { command, commandSafe } = require('../utils.js');
const { createConf } = require('../letsencrypt/manage_certs.js');

let warnSpy;

beforeEach(() => {
  jest.clearAllMocks();
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

const warned = (re) => warnSpy.mock.calls.some(([line]) => re.test(String(line)));

const INVALID = { status: 'invalid', cert_path: '', cert_key_path: '' };

describe('createConf — an invalid certificate produces no fallback material', () => {
  it('never invokes openssl', async () => {
    await createConf('mysite', INVALID);

    expect(commandSafe).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalled();
  });

  it('writes no nginx fragment at all', async () => {
    await createConf('mysite', INVALID);

    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('does not read the SSL template, so no fragment can be rendered', async () => {
    await createConf('mysite', INVALID);

    expect(fs.readFileSync).not.toHaveBeenCalled();
  });

  it('reports the site as unserved instead of announcing a fallback', async () => {
    await createConf('mysite', INVALID);

    expect(warned(/Certificate "mysite" is invalid — no SSL configuration written/)).toBe(true);
    expect(warned(/self-signed/i)).toBe(false);
    expect(warned(/fallback/i)).toBe(false);
  });
});

describe('createConf — a usable certificate is configured exactly as before', () => {
  const VALID = {
    status: 'valid',
    cert_path: '/etc/letsencrypt/live/mysite/fullchain.pem',
    cert_key_path: '/etc/letsencrypt/live/mysite/privkey.pem',
  };

  it('renders the fragment from the exported /etc/ssl/certs paths', async () => {
    await createConf('mysite', VALID);

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      '/etc/nginx/conf/mysite.conf',
      'TEMPLATE /etc/ssl/certs/mysite_fullchain.pem /etc/ssl/certs/mysite_privkey.pem /etc/ssl/certs/mysite_chain.pem',
    );
  });

  it('never invokes openssl for a usable certificate either', async () => {
    await createConf('mysite', VALID);

    expect(commandSafe).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalled();
  });

  // A staging certificate is usable for a letsencrypt-staging site, so it takes
  // the same path — only 'invalid' suppresses configuration.
  it('configures a staging certificate the same way', async () => {
    await createConf('mysite', { ...VALID, status: 'staging' });

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      '/etc/nginx/conf/mysite.conf',
      expect.stringContaining('/etc/ssl/certs/mysite_fullchain.pem'),
    );
  });
});
