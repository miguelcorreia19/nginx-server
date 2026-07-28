// Undiscoverable-lineage reconciliation in the Let's Encrypt handler.
//
// Certbot enumerates lineages from /etc/letsencrypt/renewal/*.conf. A renewal
// config it declines to enumerate is absent from parseCerts(), and every
// existing reconciliation loop iterates that parse result — so such a lineage
// used to be invisible: never deleted when the site was removed, and never
// mentioned when the site was kept.
//
// Detection is the set difference
//   stems(renewal/*.conf) - keys(parseCerts())
// which proves only that Certbot did not enumerate the lineage, not why. The
// policy is therefore deliberately asymmetric: an undiscoverable lineage that
// is no longer configured is an orphan and is deleted through the existing
// deleteCert() path, while one that is still configured is kept and warned
// about, because it may still hold usable certificate material.
//
// Mocking mirrors letsencrypt-lineage-cleanup.test.js.

const mockConfig = {};
jest.mock('../config.json', () => mockConfig, { virtual: true });

jest.mock('../letsencrypt/utils.js', () => ({
  parseCerts: jest.fn(),
  checkCertFiles: jest.fn(),
  hasManagedCertbotState: jest.fn(),
  certbotBackupEnabled: jest.fn(() => false),
  listRenewalStems: jest.fn(() => []),
  renewalConfigPath: jest.fn((stem) => `/etc/letsencrypt/renewal/${stem}.conf`),
}));

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
  appendFileSync: jest.fn(),
  existsSync: jest.fn(() => true),
}));

const fs = require('fs');
const { parseCerts, checkCertFiles, hasManagedCertbotState, listRenewalStems } = require('../letsencrypt/utils.js');
const { command } = require('../utils.js');
const { createCert, deleteCert } = require('../letsencrypt/manage_certs.js');
const letsencryptMode = require('../letsencrypt/index.js');

const lineage = (domains) => ({
  cert_path: '/etc/letsencrypt/live/x/fullchain.pem',
  cert_key_path: '/etc/letsencrypt/live/x/privkey.pem',
  cert_domains: domains,
  status: 'valid',
});

const setConfig = (config) => {
  for (const key of Object.keys(mockConfig)) delete mockConfig[key];
  Object.assign(mockConfig, config);
};

const deletedNames = () => deleteCert.mock.calls.map(([id]) => id);
const logged = (spy, re) => spy.mock.calls.some(([line]) => re.test(String(line)));

let warnSpy, errorSpy, logSpy;

beforeEach(() => {
  jest.clearAllMocks();
  checkCertFiles.mockReturnValue(true);
  hasManagedCertbotState.mockReturnValue(true);
  listRenewalStems.mockReturnValue([]);
  fs.existsSync.mockReturnValue(true);
  delete process.env.CERTBOT_BACKUP;
  process.env.CERTBOT_BACKUP_PATH = '/home/letsencrypt';
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ──────────────────────────────────────────────
//  The primary case
// ──────────────────────────────────────────────
describe('mixed healthy + undiscoverable orphan', () => {
  beforeEach(() => {
    setConfig({ good: { mode: 'letsencrypt', names: ['good.example.com'] } });
    parseCerts.mockResolvedValue({ good: lineage(['good.example.com']) });
    listRenewalStems.mockReturnValue(['good', 'broken']);
  });

  it('deletes only the undiscoverable lineage', async () => {
    await letsencryptMode();

    expect(deletedNames()).toEqual(['broken']);
  });

  it('leaves the healthy configured lineage alone', async () => {
    await letsencryptMode();

    expect(deletedNames()).not.toContain('good');
    expect(createCert).not.toHaveBeenCalled();
  });

  it('still completes the normal workflow', async () => {
    await letsencryptMode();

    expect(logged(logSpy, /Let's Encrypt startup completed/)).toBe(true);
  });
});

// ──────────────────────────────────────────────
//  Detection mechanics
// ──────────────────────────────────────────────
describe('detection', () => {
  it('enumerates renewal stems only after parseCerts has resolved', async () => {
    // parseCerts(true) can restore a certificate backup, which changes the
    // renewal directory — a snapshot taken first would miss what it restored.
    const order = [];
    parseCerts.mockImplementation(async () => { order.push('parseCerts'); return {}; });
    listRenewalStems.mockImplementation(() => { order.push('listRenewalStems'); return []; });
    setConfig({});

    await letsencryptMode();

    expect(order).toEqual(['parseCerts', 'listRenewalStems']);
  });

  it('treats a lineage present in the parse result as discoverable', async () => {
    setConfig({ good: { mode: 'letsencrypt', names: ['good.example.com'] } });
    parseCerts.mockResolvedValue({ good: lineage(['good.example.com']) });
    listRenewalStems.mockReturnValue(['good']);

    await letsencryptMode();

    expect(deleteCert).not.toHaveBeenCalled();
    expect(logged(warnSpy, /did not enumerate/)).toBe(false);
  });

  it('does not delete anything when the renewal directory cannot be enumerated', async () => {
    // Absence was not proven, so no deletion may rest on this evidence.
    setConfig({});
    parseCerts.mockResolvedValue({});
    listRenewalStems.mockImplementation(() => { throw new Error('EACCES: permission denied'); });

    await letsencryptMode();

    expect(deleteCert).not.toHaveBeenCalled();
    expect(logged(warnSpy, /Could not enumerate renewal configs/)).toBe(true);
  });

  it('does not turn an enumeration failure into a fatal startup', async () => {
    setConfig({});
    parseCerts.mockResolvedValue({});
    listRenewalStems.mockImplementation(() => { throw new Error('EIO'); });

    await expect(letsencryptMode()).resolves.not.toThrow();
  });
});

// ──────────────────────────────────────────────
//  Orphans — no longer desired
// ──────────────────────────────────────────────
describe('undiscoverable orphans are cleaned up', () => {
  beforeEach(() => {
    parseCerts.mockResolvedValue({});
    listRenewalStems.mockReturnValue(['broken']);
  });

  it('deletes a lineage absent from config.json', async () => {
    setConfig({});

    await letsencryptMode();

    expect(deletedNames()).toEqual(['broken']);
  });

  it('deletes a lineage whose site switched to mode http', async () => {
    setConfig({ broken: { mode: 'http', names: ['b.example.com'] } });

    await letsencryptMode();

    expect(deletedNames()).toEqual(['broken']);
  });

  it('deletes a lineage whose site switched to mode custom', async () => {
    setConfig({
      broken: { mode: 'custom', names: ['b.example.com'], cert: 'c.pem', cert_key: 'k.pem' },
    });

    await letsencryptMode();

    expect(deletedNames()).toEqual(['broken']);
  });

  it('uses the existing deleteCert path rather than touching the filesystem', async () => {
    setConfig({});

    await letsencryptMode();

    expect(deleteCert).toHaveBeenCalledWith('broken');
    expect(command).not.toHaveBeenCalledWith(expect.stringMatching(/\brm\b/));
  });
});

// ──────────────────────────────────────────────
//  Desired — must never be deleted
// ──────────────────────────────────────────────
describe('undiscoverable lineages that are still desired are preserved', () => {
  beforeEach(() => {
    parseCerts.mockResolvedValue({});
    listRenewalStems.mockReturnValue(['broken']);
  });

  it.each([
    ['letsencrypt', { mode: 'letsencrypt', names: ['b.example.com'] }],
    ['letsencrypt-staging', { mode: 'letsencrypt-staging', names: ['b.example.com'] }],
    // An omitted mode defaults to letsencrypt, so it is just as desired — this
    // is what makes comparing against raw config.json keys wrong.
    ['omitted mode', { names: ['b.example.com'] }],
  ])('never deletes a lineage configured as %s', async (_label, entry) => {
    setConfig({ broken: entry });

    await letsencryptMode();

    expect(deleteCert).not.toHaveBeenCalledWith('broken');
  });

  it('warns, naming the certificate and its renewal config path', async () => {
    setConfig({ broken: { mode: 'letsencrypt', names: ['b.example.com'] } });

    await letsencryptMode();

    expect(logged(warnSpy, /"broken"/)).toBe(true);
    expect(logged(warnSpy, /\/etc\/letsencrypt\/renewal\/broken\.conf/)).toBe(true);
    expect(logged(warnSpy, /did not enumerate/)).toBe(true);
  });

  it('says it was left in place because the site is still configured', async () => {
    setConfig({ broken: { mode: 'letsencrypt', names: ['b.example.com'] } });

    await letsencryptMode();

    expect(logged(warnSpy, /Left in place/)).toBe(true);
  });

  it('leaves the existing downstream flow for that site reachable', async () => {
    // This task only makes the condition visible; the existing issuance
    // behaviour for a desired-but-unparsed site is deliberately unchanged.
    setConfig({ broken: { mode: 'letsencrypt', names: ['b.example.com'] } });

    await letsencryptMode();

    expect(createCert).toHaveBeenCalledWith('broken');
  });
});

// ──────────────────────────────────────────────
//  Class A: Certbot fails but removes the config anyway
// ──────────────────────────────────────────────
describe('partial cleanup is reported honestly', () => {
  beforeEach(() => {
    setConfig({});
    parseCerts.mockResolvedValue({});
    listRenewalStems.mockReturnValue(['broken']);
    deleteCert.mockResolvedValue(false);
  });

  it('reports partial cleanup when the renewal config was removed despite the failure', async () => {
    fs.existsSync.mockReturnValue(false);

    await letsencryptMode();

    expect(logged(warnSpy, /renewal config was removed/)).toBe(true);
    expect(logged(warnSpy, /inert files may remain/)).toBe(true);
  });

  it('does not claim the certificate was deleted', async () => {
    fs.existsSync.mockReturnValue(false);

    await letsencryptMode();

    expect(logged(logSpy, /Certificate broken deleted/)).toBe(false);
  });

  it('reports a retryable failure when the renewal config survived', async () => {
    fs.existsSync.mockReturnValue(true);

    await letsencryptMode();

    expect(logged(errorSpy, /deletion failed and its renewal config remains/)).toBe(true);
    expect(logged(errorSpy, /retried on the next startup/)).toBe(true);
  });

  it('never removes live/archive residue by hand', async () => {
    fs.existsSync.mockReturnValue(false);

    await letsencryptMode();

    expect(command).not.toHaveBeenCalledWith(expect.stringMatching(/\brm\b/));
    expect(command).not.toHaveBeenCalledWith(expect.stringContaining('/etc/letsencrypt/archive'));
  });

  it('stays non-fatal either way', async () => {
    fs.existsSync.mockReturnValue(false);
    await expect(letsencryptMode()).resolves.not.toThrow();

    fs.existsSync.mockReturnValue(true);
    await expect(letsencryptMode()).resolves.not.toThrow();
  });
});

// ──────────────────────────────────────────────
//  Zero configured Let's Encrypt sites
// ──────────────────────────────────────────────
describe('zero desired sites with an undiscoverable orphan', () => {
  beforeEach(() => {
    setConfig({});
    parseCerts.mockResolvedValue({});
    listRenewalStems.mockReturnValue(['broken']);
  });

  it('takes the slow path, because managed state exists', async () => {
    await letsencryptMode();

    expect(parseCerts).toHaveBeenCalled();
  });

  it('cleans up the orphan and then returns', async () => {
    await letsencryptMode();

    expect(deletedNames()).toEqual(['broken']);
    expect(createCert).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalledWith(expect.stringContaining('crond'));
  });

  it('reports cleanup as complete when the orphan was removed', async () => {
    await letsencryptMode();

    expect(logged(logSpy, /certificate cleanup completed$/)).toBe(true);
  });

  it('qualifies the summary after a partial cleanup rather than reading as a clean success', async () => {
    // Nothing managed is left to reconcile, so this is not "incomplete" — but
    // the line should not contradict the partial-cleanup warning above it.
    deleteCert.mockResolvedValue(false);
    fs.existsSync.mockReturnValue(false);

    await letsencryptMode();

    expect(logged(logSpy, /certificate cleanup completed with warnings/)).toBe(true);
  });

  it('does not claim cleanup completed when the orphan survived', async () => {
    // The old message asserted completion unconditionally, even with a
    // renewal config left untouched.
    deleteCert.mockResolvedValue(false);
    fs.existsSync.mockReturnValue(true);

    await letsencryptMode();

    expect(logged(logSpy, /certificate cleanup completed/)).toBe(false);
    expect(logged(warnSpy, /certificate cleanup incomplete/)).toBe(true);
  });

  it('still skips Certbot entirely when there is no managed state at all', async () => {
    hasManagedCertbotState.mockReturnValue(false);

    await letsencryptMode();

    expect(parseCerts).not.toHaveBeenCalled();
    expect(listRenewalStems).not.toHaveBeenCalled();
    expect(deleteCert).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────
//  The pre-existing discovered-lineage cleanup
// ──────────────────────────────────────────────
describe('discovered-lineage orphan cleanup is unchanged', () => {
  it('still deletes a healthy lineage that is no longer configured', async () => {
    setConfig({});
    parseCerts.mockResolvedValue({ old: lineage(['old.example.com']) });
    listRenewalStems.mockReturnValue(['old']);

    await letsencryptMode();

    expect(deletedNames()).toEqual(['old']);
  });

  it('does not delete it twice — a name belongs to exactly one category', async () => {
    setConfig({});
    parseCerts.mockResolvedValue({ old: lineage(['old.example.com']) });
    listRenewalStems.mockReturnValue(['old']);

    await letsencryptMode();

    expect(deleteCert).toHaveBeenCalledTimes(1);
  });

  it('separates the two categories when both are present', async () => {
    setConfig({});
    parseCerts.mockResolvedValue({ old: lineage(['old.example.com']) });
    listRenewalStems.mockReturnValue(['old', 'broken']);

    await letsencryptMode();

    expect(deletedNames().sort()).toEqual(['broken', 'old']);
    expect(deleteCert).toHaveBeenCalledTimes(2);
  });
});
