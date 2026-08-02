// CERTBOT_BACKUP enablement, end to end through the Let's Encrypt handler.
//
// Environment values are strings, so a bare truthiness test treats the
// documented CERTBOT_BACKUP=false as enabled. The restore path in parseCerts()
// used to do exactly that while the two write paths tested `!== 'false'`, so
// `false` disabled writing the backup but still permitted restoring it.
//
// All the gates now share certbotBackupEnabled() (js/letsencrypt/utils.js).
// This file pins the *write* side of that contract on the real handler; the
// restore side is covered in letsencrypt-utils.test.js, the fast-path side in
// certbot-state.test.js, and the predicate itself in both.
//
// Mocking mirrors letsencrypt-lineage-cleanup.test.js.

const mockConfig = {};
jest.mock('../config.json', () => mockConfig, { virtual: true });

jest.mock('../letsencrypt/utils.js', () => {
  // certbotBackupEnabled is the real implementation — it is the thing under
  // test here. Only its collaborators are stubbed.
  const actual = jest.requireActual('../letsencrypt/utils.js');
  return {
    parseCerts: jest.fn(),
    checkCertFiles: jest.fn(),
    hasManagedCertbotState: jest.fn(),
    certbotBackupEnabled: actual.certbotBackupEnabled,
    // The real writer, so these assertions still check the command actually
    // issued. Its `command` dependency resolves to the mock below.
    backupCertbotState: actual.backupCertbotState,
    listRenewalStems: jest.fn(() => []),
    renewalConfigPath: actual.renewalConfigPath,
  };
});

jest.mock('../letsencrypt/restore_lineage.js', () => ({
  recoverInterruptedRestores: jest.fn(() => []),
  restoreLineageFromBackup: jest.fn(),
}));

jest.mock('../letsencrypt/validate_backup.js', () => ({
  validateBackupLineage: jest.fn(),
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

jest.mock('fs', () => ({ appendFileSync: jest.fn() }));

const { parseCerts, checkCertFiles, hasManagedCertbotState } = require('../letsencrypt/utils.js');
const { command } = require('../utils.js');
const letsencryptMode = require('../letsencrypt/index.js');

const ENV_KEYS = ['CERTBOT_BACKUP', 'CERTBOT_BACKUP_PATH'];
const savedEnv = {};

const backupWritten = () =>
  command.mock.calls
    .map(([cmd]) => String(cmd))
    .some((cmd) => cmd.startsWith('cp -rf /etc/letsencrypt/*'));

// One configured site with a matching lineage, so the handler runs its full
// workflow and reaches the backup step.
const withConfiguredSite = () => {
  parseCerts.mockResolvedValue({
    A: {
      cert_path: '/etc/letsencrypt/live/A/fullchain.pem',
      cert_key_path: '/etc/letsencrypt/live/A/privkey.pem',
      cert_domains: ['a.example.com'],
      status: 'valid',
    },
  });
  for (const key of Object.keys(mockConfig)) delete mockConfig[key];
  Object.assign(mockConfig, { A: { mode: 'letsencrypt', names: ['a.example.com'] } });
};

beforeEach(() => {
  jest.clearAllMocks();
  checkCertFiles.mockReturnValue(true);
  hasManagedCertbotState.mockReturnValue(true);
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

describe('backup write gate — honours the shared enablement predicate', () => {
  it('writes the backup when CERTBOT_BACKUP=true', async () => {
    process.env.CERTBOT_BACKUP = 'true';
    withConfiguredSite();

    await letsencryptMode();

    expect(backupWritten()).toBe(true);
  });

  it('does not write the backup when CERTBOT_BACKUP is the string "false"', async () => {
    process.env.CERTBOT_BACKUP = 'false';
    withConfiguredSite();

    await letsencryptMode();

    expect(backupWritten()).toBe(false);
  });

  it('does not write the backup when CERTBOT_BACKUP is unset', async () => {
    delete process.env.CERTBOT_BACKUP;
    withConfiguredSite();

    await letsencryptMode();

    expect(backupWritten()).toBe(false);
  });

  it('does not write the backup for the empty string', async () => {
    process.env.CERTBOT_BACKUP = '';
    withConfiguredSite();

    await letsencryptMode();

    expect(backupWritten()).toBe(false);
  });

  it('writes the backup for any other non-empty value', async () => {
    process.env.CERTBOT_BACKUP = '1';
    withConfiguredSite();

    await letsencryptMode();

    expect(backupWritten()).toBe(true);
  });

  it('leaves the destination path untouched — only enablement changed', async () => {
    process.env.CERTBOT_BACKUP = 'true';
    process.env.CERTBOT_BACKUP_PATH = '/mnt/backup';
    withConfiguredSite();

    await letsencryptMode();

    expect(command).toHaveBeenCalledWith('cp -rf /etc/letsencrypt/* /mnt/backup');
  });
});
