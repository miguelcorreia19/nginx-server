// validateBackupLineage() — is a backed-up lineage usable recovery material?
//
// The validator is a reporting primitive: it decides nothing, and the Let's
// Encrypt handler gates both recovery paths on its verdict (the orchestration
// itself is covered by restore-integration.test.js and
// bootstrap-integration.test.js). It answers "could this backup be restored for
// this site?" without touching live state,
// by copying only that lineage into a throwaway Certbot tree, repointing the
// copied renewal config at that tree, and asking Certbot to enumerate it there.
//
// The rewrite step is the whole reason isolation works. A backup is a bulk copy
// of /etc/letsencrypt, so its renewal configs still carry absolute
// /etc/letsencrypt paths; without rewriting them Certbot reads the live files
// and reports on those instead — verified against Certbot 5.6.
//
// Filesystem work is real (temp dirs, real `cp`, real symlinks) so the copy and
// rewrite are genuinely exercised; only the Certbot invocation is stubbed, so
// the enumeration outcomes can be driven.

const fs = require('fs');
const os = require('os');
const path = require('path');

const mockConfig = {};
jest.mock('../config.json', () => mockConfig, { virtual: true });

jest.mock('../utils.js', () => {
  const { execFile } = require('child_process');
  return {
    command: jest.fn(() => Promise.resolve('')),
    // `cp` runs for real; `certbot` is driven by the test.
    commandSafe: jest.fn((bin, args) => {
      if (bin === 'certbot') return global.__certbotOutput();
      return new Promise((resolve, reject) =>
        execFile(bin, args, (err, stdout) => (err ? reject(err) : resolve(stdout))));
    }),
  };
});

const { commandSafe } = require('../utils.js');
const { validateBackupLineage, rewriteRenewalPaths } = require('../letsencrypt/validate_backup.js');

let tmp, backup;

const setConfig = (config) => {
  for (const key of Object.keys(mockConfig)) delete mockConfig[key];
  Object.assign(mockConfig, config);
};

// Certbot output shaped like the pinned 5.6 emits, with paths inside whatever
// sandbox the validator created — mirroring what a real run reports back.
const certbotOutput = (entries) => {
  global.__certbotOutput = () => {
    const dir = fs.readdirSync(tmp).find((n) => n.startsWith('certbot-validate-'));
    const configDir = path.join(tmp, dir, 'config');
    if (entries.length === 0) return Promise.resolve('No certificates found.');
    return Promise.resolve(`
- - - - - - - - - - - - - - - - - - - - - - - - - -
Found the following certs:
${entries.map(({ name, identifiers, expiry }) => `  Certificate Name: ${name}
    Serial Number: 3d8b2f29c9fa
    Key Type: RSA
    Identifiers: ${identifiers}
    Expiry Date: 2026-09-26 23:25:50+00:00 (${expiry || 'VALID: 29 days'})
    Certificate Path: ${configDir}/live/${name}/fullchain.pem
    Private Key Path: ${configDir}/live/${name}/privkey.pem`).join('\n')}
- - - - - - - - - - - - - - - - - - - - - - - - - -
`);
  };
};

// A Certbot-shaped lineage: archive holds real files, live holds relative
// symlinks into archive, renewal carries absolute /etc/letsencrypt paths just
// as a real bulk-copied backup does.
const lineage = (root, id, server = 'https://acme-v02.api.letsencrypt.org/directory') => {
  fs.mkdirSync(path.join(root, 'archive', id), { recursive: true });
  fs.mkdirSync(path.join(root, 'live', id), { recursive: true });
  fs.mkdirSync(path.join(root, 'renewal'), { recursive: true });
  for (const name of ['cert', 'privkey', 'chain', 'fullchain']) {
    fs.writeFileSync(path.join(root, 'archive', id, `${name}1.pem`), `${id}-${name}\n`);
    fs.symlinkSync(`../../archive/${id}/${name}1.pem`, path.join(root, 'live', id, `${name}.pem`));
  }
  fs.writeFileSync(path.join(root, 'renewal', `${id}.conf`), [
    'version = 5.6.0',
    `archive_dir = /etc/letsencrypt/archive/${id}`,
    `cert = /etc/letsencrypt/live/${id}/cert.pem`,
    `privkey = /etc/letsencrypt/live/${id}/privkey.pem`,
    `chain = /etc/letsencrypt/live/${id}/chain.pem`,
    `fullchain = /etc/letsencrypt/live/${id}/fullchain.pem`,
    '',
    '# a comment that must survive',
    '[renewalparams]',
    'authenticator = webroot',
    'webroot_path = /var/www/certbot,',
    `server = ${server}`,
    '',
  ].join('\n'));
};

const sandboxes = () => fs.readdirSync(tmp).filter((n) => n.startsWith('certbot-validate-'));
const run = (id) => validateBackupLineage(id, { backupPath: backup, tmpRoot: tmp });

beforeEach(() => {
  jest.clearAllMocks();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-backup-'));
  backup = path.join(tmp, 'backup');
  fs.mkdirSync(backup, { recursive: true });
  certbotOutput([{ name: 'A', identifiers: 'a.example.com' }]);
  setConfig({ A: { mode: 'letsencrypt', names: ['a.example.com'] } });
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  jest.restoreAllMocks();
});

// ──────────────────────────────────────────────
//  Accepting good material
// ──────────────────────────────────────────────
describe('a healthy backup validates', () => {
  it('accepts a production backup for a production site', async () => {
    lineage(backup, 'A');

    await expect(run('A')).resolves.toEqual(
      expect.objectContaining({ valid: true, status: 'valid', cert_domains: ['a.example.com'] })
    );
  });

  it('accepts a staging backup for a staging site', async () => {
    lineage(backup, 'A', 'https://acme-staging-v02.api.letsencrypt.org/directory');
    setConfig({ A: { mode: 'letsencrypt-staging', names: ['a.example.com'] } });
    certbotOutput([{ name: 'A', identifiers: 'a.example.com', expiry: 'INVALID: TEST_CERT' }]);

    await expect(run('A')).resolves.toEqual(expect.objectContaining({ valid: true, status: 'staging' }));
  });

  it('accepts a site whose mode is omitted, since that defaults to letsencrypt', async () => {
    lineage(backup, 'A');
    setConfig({ A: { names: ['a.example.com'] } });

    await expect(run('A')).resolves.toEqual(expect.objectContaining({ valid: true }));
  });

  it('validates every configured name', async () => {
    lineage(backup, 'A');
    setConfig({ A: { mode: 'letsencrypt', names: ['a.example.com', 'www.a.example.com'] } });
    certbotOutput([{ name: 'A', identifiers: 'a.example.com www.a.example.com' }]);

    await expect(run('A')).resolves.toEqual(expect.objectContaining({ valid: true }));
  });
});

// ──────────────────────────────────────────────
//  Isolation — the point of the whole design
// ──────────────────────────────────────────────
describe('validation depends on the backup, not on live state', () => {
  it('validates with no live Certbot tree at all', async () => {
    lineage(backup, 'A');

    // The backup's renewal config points at /etc/letsencrypt, which holds
    // nothing here. Only the sandbox rewrite makes this resolvable.
    await expect(run('A')).resolves.toEqual(expect.objectContaining({ valid: true }));
  });

  it('rejects a backup missing its renewal config even when live is healthy', async () => {
    lineage(backup, 'A');
    fs.rmSync(path.join(backup, 'renewal', 'A.conf'));

    await expect(run('A')).resolves.toEqual({ valid: false, reason: 'backup-renewal-missing' });
  });

  it('copies only the requested lineage into the sandbox', async () => {
    lineage(backup, 'A');
    lineage(backup, 'other');

    await run('A');

    const copied = commandSafe.mock.calls
      .filter(([bin]) => bin === 'cp')
      .map(([, args]) => args[args.length - 2]);
    expect(copied.every((src) => src.endsWith('/A'))).toBe(true);
    expect(copied.some((src) => src.includes('other'))).toBe(false);
  });

  it('points Certbot at isolated config, work and log directories', async () => {
    lineage(backup, 'A');

    await run('A');

    const [, args] = commandSafe.mock.calls.find(([bin]) => bin === 'certbot');
    expect(args[0]).toBe('certificates');
    for (const flag of ['--config-dir', '--work-dir', '--logs-dir']) {
      expect(args).toContain(flag);
      expect(args[args.indexOf(flag) + 1].startsWith(tmp)).toBe(true);
    }
    // Enumeration is the only Certbot operation validation may perform.
    expect(args).not.toContain('renew');
    expect(args).not.toContain('certonly');
    expect(args).not.toContain('delete');
  });
});

// ──────────────────────────────────────────────
//  Rejecting bad material
// ──────────────────────────────────────────────
describe('a backup that is not recovery material is rejected', () => {
  beforeEach(() => lineage(backup, 'A'));

  it.each([
    ['live', () => fs.rmSync(path.join(backup, 'live', 'A'), { recursive: true }), 'backup-live-missing'],
    ['archive', () => fs.rmSync(path.join(backup, 'archive', 'A'), { recursive: true }), 'backup-archive-missing'],
  ])('rejects a backup with %s missing', async (_label, breakIt, reason) => {
    breakIt();

    await expect(run('A')).resolves.toEqual({ valid: false, reason });
  });

  it('rejects a lineage Certbot declines to enumerate', async () => {
    // What a structurally unparseable renewal config produces.
    certbotOutput([]);

    await expect(run('A')).resolves.toEqual({ valid: false, reason: 'not-enumerated' });
  });

  // The identity invariant is site id == cert-name, so a lineage under any
  // other name cannot stand in for this one.
  it('rejects a sandbox that enumerates a different cert-name', async () => {
    certbotOutput([{ name: 'A-0001', identifiers: 'a.example.com' }]);

    await expect(run('A')).resolves.toEqual(
      expect.objectContaining({ valid: false, reason: 'wrong-cert-name' })
    );
  });

  it('rejects an expired or otherwise invalid certificate', async () => {
    certbotOutput([{ name: 'A', identifiers: 'a.example.com', expiry: 'INVALID: EXPIRED' }]);

    await expect(run('A')).resolves.toEqual({ valid: false, reason: 'certificate-invalid' });
  });

  // Exact set equality, matching checkCertFiles() — the application does not
  // accept a certificate carrying names the site no longer configures.
  it('rejects a certificate missing a configured name', async () => {
    setConfig({ A: { mode: 'letsencrypt', names: ['a.example.com', 'www.a.example.com'] } });

    await expect(run('A')).resolves.toEqual(
      expect.objectContaining({ valid: false, reason: 'identifier-mismatch' })
    );
  });

  it('rejects a certificate carrying an extra identifier', async () => {
    certbotOutput([{ name: 'A', identifiers: 'a.example.com extra.example.com' }]);

    await expect(run('A')).resolves.toEqual(
      expect.objectContaining({ valid: false, reason: 'identifier-mismatch' })
    );
  });

  it('rejects a site that is not a managed Let\'s Encrypt site', async () => {
    setConfig({ A: { mode: 'http', names: ['a.example.com'] } });

    await expect(run('A')).resolves.toEqual({ valid: false, reason: 'not-desired' });
  });
});

// ──────────────────────────────────────────────
//  Environment, both directions
// ──────────────────────────────────────────────
describe('environment must match the configured mode', () => {
  beforeEach(() => lineage(backup, 'A'));

  it('rejects staging material for a production site', async () => {
    certbotOutput([{ name: 'A', identifiers: 'a.example.com', expiry: 'INVALID: TEST_CERT' }]);

    await expect(run('A')).resolves.toEqual(
      expect.objectContaining({ valid: false, reason: 'environment-mismatch' })
    );
  });

  it('rejects production material for a staging site', async () => {
    setConfig({ A: { mode: 'letsencrypt-staging', names: ['a.example.com'] } });

    await expect(run('A')).resolves.toEqual(
      expect.objectContaining({ valid: false, reason: 'environment-mismatch' })
    );
  });
});

// ──────────────────────────────────────────────
//  Side effects
// ──────────────────────────────────────────────
describe('validation leaves nothing behind', () => {
  const snapshot = () => ({
    renewal: fs.readFileSync(path.join(backup, 'renewal', 'A.conf'), 'utf8'),
    cert: fs.readFileSync(path.join(backup, 'archive', 'A', 'cert1.pem'), 'utf8'),
    link: fs.readlinkSync(path.join(backup, 'live', 'A', 'cert.pem')),
  });

  it('does not modify the backup', async () => {
    lineage(backup, 'A');
    const before = snapshot();

    await run('A');

    expect(snapshot()).toEqual(before);
  });

  it('leaves the backup renewal config carrying its original absolute paths', async () => {
    // The rewrite must happen on the sandbox copy only.
    lineage(backup, 'A');

    await run('A');

    expect(fs.readFileSync(path.join(backup, 'renewal', 'A.conf'), 'utf8'))
      .toContain('/etc/letsencrypt/archive/A');
  });

  it.each([
    ['a valid result', () => certbotOutput([{ name: 'A', identifiers: 'a.example.com' }])],
    ['an invalid result', () => certbotOutput([])],
  ])('removes the sandbox after %s', async (_label, arrange) => {
    lineage(backup, 'A');
    arrange();

    await run('A');

    expect(sandboxes()).toEqual([]);
  });

  it('removes the sandbox even when Certbot cannot be run', async () => {
    lineage(backup, 'A');
    global.__certbotOutput = () => Promise.reject(new Error('certbot: not found'));

    await expect(run('A')).rejects.toThrow(/Could not run certbot/);
    expect(sandboxes()).toEqual([]);
  });

  // Being unable to validate is an operational failure, not a verdict on the
  // backup — it must never be reported as "this backup is unusable".
  it('throws rather than reporting invalid when Certbot cannot be run', async () => {
    lineage(backup, 'A');
    global.__certbotOutput = () => Promise.reject(new Error('certbot: not found'));

    await expect(run('A')).rejects.toThrow();
  });
});

// ──────────────────────────────────────────────
//  The sandbox copy
// ──────────────────────────────────────────────
describe('sandbox construction', () => {
  it('keeps live entries as symlinks into archive', async () => {
    lineage(backup, 'A');
    let seen;
    global.__certbotOutput = () => {
      const dir = fs.readdirSync(tmp).find((n) => n.startsWith('certbot-validate-'));
      const live = path.join(tmp, dir, 'config', 'live', 'A', 'cert.pem');
      seen = { isLink: fs.lstatSync(live).isSymbolicLink(), target: fs.readlinkSync(live) };
      return Promise.resolve('No certificates found.');
    };

    await run('A');

    // Certbot rejects a lineage whose live entries are regular files, so this
    // is load-bearing rather than cosmetic.
    expect(seen).toEqual({ isLink: true, target: '../../archive/A/cert1.pem' });
  });

  it('repoints the sandbox renewal config at the sandbox', async () => {
    lineage(backup, 'A');
    let content;
    global.__certbotOutput = () => {
      const dir = fs.readdirSync(tmp).find((n) => n.startsWith('certbot-validate-'));
      content = fs.readFileSync(path.join(tmp, dir, 'config', 'renewal', 'A.conf'), 'utf8');
      return Promise.resolve('No certificates found.');
    };

    await run('A');

    expect(content).not.toContain('/etc/letsencrypt');
    expect(content).toMatch(/archive_dir = .*certbot-validate-.*\/config\/archive\/A/);
  });
});

// ──────────────────────────────────────────────
//  The path rewrite in isolation
// ──────────────────────────────────────────────
describe('rewriteRenewalPaths', () => {
  const conf = [
    'version = 5.6.0',
    'archive_dir = /etc/letsencrypt/archive/A',
    'cert = /etc/letsencrypt/live/A/cert.pem',
    '',
    '# keep me',
    '[renewalparams]',
    'authenticator = webroot',
    'webroot_path = /var/www/certbot,',
    'server = https://acme-v02.api.letsencrypt.org/directory',
  ].join('\n');

  it('repoints every lineage path at the sandbox', () => {
    const out = rewriteRenewalPaths(conf, '/sbx');

    expect(out).toContain('archive_dir = /sbx/archive/A');
    expect(out).toContain('cert = /sbx/live/A/cert.pem');
  });

  it('leaves every other line untouched', () => {
    const out = rewriteRenewalPaths(conf, '/sbx').split('\n');

    expect(out).toContain('# keep me');
    expect(out).toContain('[renewalparams]');
    expect(out).toContain('authenticator = webroot');
    expect(out).toContain('webroot_path = /var/www/certbot,');
    expect(out).toContain('server = https://acme-v02.api.letsencrypt.org/directory');
    expect(out).toContain('version = 5.6.0');
  });

  it('rewrites a backup-rooted path as readily as a live-rooted one', () => {
    const out = rewriteRenewalPaths('archive_dir = /home/letsencrypt/archive/A', '/sbx');

    expect(out).toBe('archive_dir = /sbx/archive/A');
  });
});
