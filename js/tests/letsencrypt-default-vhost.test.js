// Let's Encrypt handler — port-443 default-vhost restoration (F2 regression).
//
// js/letsencrypt/index.js rebuilds /etc/nginx/conf.d/443 on every run that has
// at least one applicable certificate: it wipes the directory (which also
// removes the build-time default vhost, nginx.vh.default.443.conf), then must
// put the default vhost back alongside each site's generated config.
// Restoration used to be guarded by "Object.keys(certs).length === 0" — a
// branch that could never run, because the function already returns earlier
// for that exact condition ("if (Object.keys(certs).length == 0) return;").
// The practical effect: whenever any Let's Encrypt certificate was active, the
// default vhost was wiped and never restored, leaving port 443 with no
// default_server for unmatched SNI/Host traffic.
//
// Mocking mirrors letsencrypt-wildcard.test.js.

const mockConfig = {};
jest.mock('../config.json', () => mockConfig, { virtual: true });

jest.mock('../letsencrypt/utils.js', () => ({
  parseCerts: jest.fn(),
  checkCertFiles: jest.fn(),
}));

jest.mock('../utils.js', () => ({
  command: jest.fn(() => Promise.resolve()),
  commandSafe: jest.fn(() => Promise.resolve()),
  configFiles: jest.fn(() => Promise.resolve()),
}));

jest.mock('../letsencrypt/manage_certs.js', () => ({
  createCert: jest.fn(() => Promise.resolve(true)),
  deleteCert: jest.fn(() => Promise.resolve(true)),
  createConf: jest.fn(() => Promise.resolve()),
}));

// The handler appends the renewal cron line to /etc/crontabs/root; stub fs so
// the suite never touches the host filesystem (same approach as
// letsencrypt-wildcard.test.js / utils.test.js).
jest.mock('fs', () => ({ appendFileSync: jest.fn() }));

const { parseCerts, checkCertFiles } = require('../letsencrypt/utils.js');
const { command, configFiles } = require('../utils.js');
const letsencryptMode = require('../letsencrypt/index.js');

const setConfig = (entries) => {
  for (const key of Object.keys(mockConfig)) delete mockConfig[key];
  Object.assign(mockConfig, entries);
};

const CLEAR_CMD = 'rm -f /etc/nginx/conf.d/443/*';
const RESTORE_CMD = 'cp /home/scripts/nginx/nginx.vh.default.443.conf /etc/nginx/conf.d/443/nginx.vh.default.443.conf';

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('letsencrypt handler — port-443 default vhost restoration', () => {
  const activeCert = {
    main: {
      cert_path: '/etc/letsencrypt/live/main/fullchain.pem',
      cert_key_path: '/etc/letsencrypt/live/main/privkey.pem',
      cert_domains: ['example.com'],
      status: 'valid',
    },
  };

  it('restores the default vhost after clearing conf.d/443, even with an active certificate', async () => {
    parseCerts.mockResolvedValue(activeCert);
    checkCertFiles.mockReturnValue(true);
    setConfig({ main: { mode: 'letsencrypt', names: ['example.com'] } });

    await letsencryptMode();

    const calls = command.mock.calls.map((call) => call[0]);
    const clearIndex = calls.indexOf(CLEAR_CMD);
    const restoreIndex = calls.indexOf(RESTORE_CMD);

    // Cleanup happened...
    expect(clearIndex).toBeGreaterThan(-1);
    // ...and restoration happened, in that order — not skipped merely because
    // "main" has an active, valid certificate.
    expect(restoreIndex).toBeGreaterThan(-1);
    expect(restoreIndex).toBeGreaterThan(clearIndex);
  });

  it('keeps the applicable site linked alongside the restored default vhost', async () => {
    parseCerts.mockResolvedValue(activeCert);
    checkCertFiles.mockReturnValue(true);
    setConfig({ main: { mode: 'letsencrypt', names: ['example.com'] } });

    await letsencryptMode();

    expect(configFiles).toHaveBeenCalledWith('main', 'valid', undefined, ['example.com']);
  });
});
