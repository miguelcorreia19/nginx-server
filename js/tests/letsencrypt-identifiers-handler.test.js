// Handler-level regression for the Certbot "Identifiers:" incompatibility.
//
// Every other Let's Encrypt handler test mocks parseCerts() and feeds the
// handler a ready-made certificate object. That is what let this defect ship:
// Certbot 5.6.0 emits "Identifiers:" where the parser looked for "Domains:", so
// cert_domains came back undefined and checkCertFiles() threw
//   TypeError: Cannot read properties of undefined (reading 'filter')
// which the handler turns into a fatal — the container aborted on every startup
// that discovered an existing certificate.
//
// This file therefore deliberately does NOT mock js/letsencrypt/utils.js. Only
// the layer below it (command execution, certificate management, fs) is
// stubbed, so the real parser runs against realistic Certbot output.

jest.mock('../config.json', () => ({
  example: {
    mode: 'letsencrypt',
    names: ['example.com', 'www.example.com'],
    email: 'admin@example.com',
  },
}), { virtual: true });

jest.mock('../utils.js', () => ({
  command: jest.fn(() => Promise.resolve('')),
  commandSafe: jest.fn(() => Promise.resolve()),
  configFiles: jest.fn(() => Promise.resolve()),
}));

jest.mock('../letsencrypt/manage_certs.js', () => ({
  createCert: jest.fn(() => Promise.resolve(true)),
  deleteCert: jest.fn(() => Promise.resolve(true)),
  createConf: jest.fn(() => Promise.resolve()),
}));

jest.mock('fs', () => ({
  existsSync: jest.fn(() => true),
  readdirSync: jest.fn(() => []),
  appendFileSync: jest.fn(),
}));

jest.mock('luxon', () => ({ DateTime: { fromJSDate: jest.fn(() => 'mock-validity') } }));

const { command, commandSafe, configFiles } = require('../utils.js');
const { createCert, deleteCert } = require('../letsencrypt/manage_certs.js');
const letsencryptMode = require('../letsencrypt/index.js');

// Transcribed from `certbot certificates` under Certbot 5.6.0 in this image.
const CERTBOT_5_6_OUTPUT = `
- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
Found the following certs:
  Certificate Name: example
    Serial Number: 3d8b2f29c9fa34921b3037ebdb6d5a1cad080173
    Key Type: RSA
    Identifiers: example.com www.example.com
    Expiry Date: 2026-09-26 23:25:50+00:00 (VALID: 29 days)
    Certificate Path: /etc/letsencrypt/live/example/fullchain.pem
    Private Key Path: /etc/letsencrypt/live/example/privkey.pem
- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
`;

const ENV_KEYS = ['CERTBOT_BACKUP', 'CERTBOT_BACKUP_PATH', 'CERTBOT_RENEW_CRONJOB'];
const savedEnv = {};

beforeEach(() => {
  jest.clearAllMocks();
  command.mockImplementation((cmd) =>
    Promise.resolve(String(cmd) === 'certbot certificates' ? CERTBOT_5_6_OUTPUT : '')
  );
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.CERTBOT_BACKUP_PATH = '/home/letsencrypt';
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  jest.restoreAllMocks();
});

describe("letsencrypt handler — discovering an existing certificate via \"Identifiers:\"", () => {
  it('completes instead of aborting startup', async () => {
    await expect(letsencryptMode()).resolves.not.toThrow();
  });

  it('does not fail on an undefined cert_domains', async () => {
    // The precise regression: the old parser left cert_domains undefined, and
    // checkCertFiles() called .filter() on it.
    let caught;
    await letsencryptMode().catch((err) => { caught = err; });

    expect(caught).toBeUndefined();
  });

  it('passes the parsed identifiers through to the nginx config layer', async () => {
    await letsencryptMode();

    expect(configFiles).toHaveBeenCalledWith(
      'example',
      'valid',
      undefined,
      ['example.com', 'www.example.com'],
    );
  });

  it('treats the discovered certificate as already matching the configured names', async () => {
    // Domains parsed correctly means checkCertFiles() is satisfied, so the
    // certificate is neither deleted nor reissued. A parser that returned the
    // wrong list would show up here as needless churn against the CA.
    await letsencryptMode();

    expect(deleteCert).not.toHaveBeenCalled();
    expect(createCert).not.toHaveBeenCalled();
  });

  it('exports the certificate material', async () => {
    await letsencryptMode();

    expect(commandSafe).toHaveBeenCalledWith(
      'cp',
      ['/etc/letsencrypt/live/example/fullchain.pem', '/etc/ssl/certs/example_fullchain.pem'],
    );
  });
});
