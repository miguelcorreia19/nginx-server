// Let's Encrypt handler — conf.d ownership (carries the F2 regression forward).
//
// F2 originally fixed an unreachable default-443 restoration *inside* this
// handler. That responsibility has since moved: production startup owns
// /etc/nginx/conf.d/80 and /etc/nginx/conf.d/443 and restores both default
// vhosts before any handler runs (js/reconcile.js), because this handler only
// ever cleaned those shared directories when it had at least one entry of its
// own — which left removed custom/http/LE sites live after a restart.
//
// So the F2 guarantee itself now lives in reconcile.test.js ("restores the
// default :443 vhost") and restart-reconciliation.test.js. What this file
// pins is the other half of that move: the handler must no longer wipe the
// shared directories or restore the default vhost, and must still create its
// own sites' artifacts.
//
// Mocking mirrors letsencrypt-wildcard.test.js.

const mockConfig = {};
jest.mock('../config.json', () => mockConfig, { virtual: true });

jest.mock('../letsencrypt/utils.js', () => ({
  parseCerts: jest.fn(),
  checkCertFiles: jest.fn(),
  hasManagedCertbotState: jest.fn(() => true),
  certbotBackupEnabled: jest.fn(() => false),
  listRenewalStems: jest.fn(() => []),
  renewalConfigPath: jest.fn((stem) => `/etc/letsencrypt/renewal/${stem}.conf`),
  backupCertbotState: jest.fn(() => Promise.resolve()),
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

// Commands this handler used to own and must no longer issue.
const CLEAR_443_CMD = 'rm -f /etc/nginx/conf.d/443/*';
const CLEAR_REDIRECTS_CMD = 'rm -f /etc/nginx/conf.d/80/*-http-redirect.conf';
const RESTORE_443_CMD = 'cp /home/scripts/nginx/nginx.vh.default.443.conf /etc/nginx/conf.d/443/nginx.vh.default.443.conf';

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('letsencrypt handler — no longer owns shared conf.d lifecycle', () => {
  const activeCert = {
    main: {
      cert_path: '/etc/letsencrypt/live/main/fullchain.pem',
      cert_key_path: '/etc/letsencrypt/live/main/privkey.pem',
      cert_domains: ['example.com'],
      status: 'valid',
    },
  };

  const withActiveCert = () => {
    parseCerts.mockResolvedValue(activeCert);
    checkCertFiles.mockReturnValue(true);
    setConfig({ main: { mode: 'letsencrypt', names: ['example.com'] } });
  };

  const shellCommands = () => command.mock.calls.map((call) => call[0]);

  it('does not wipe conf.d/443 (production startup owns that directory now)', async () => {
    withActiveCert();

    await letsencryptMode();

    expect(shellCommands()).not.toContain(CLEAR_443_CMD);
  });

  it('does not wipe other modes\' redirect files', async () => {
    withActiveCert();

    await letsencryptMode();

    expect(shellCommands()).not.toContain(CLEAR_REDIRECTS_CMD);
  });

  it('does not restore the default :443 vhost', async () => {
    withActiveCert();

    await letsencryptMode();

    expect(shellCommands()).not.toContain(RESTORE_443_CMD);
  });

  it('still links its own site after the centralized reset', async () => {
    withActiveCert();

    await letsencryptMode();

    expect(configFiles).toHaveBeenCalledWith('main', 'valid', undefined, ['example.com']);
  });
});
