// backupCertbotState() — protecting a desired undiscoverable lineage's backup.
//
// A lineage Certbot cannot enumerate but config.json still wants is preserved
// locally rather than deleted. The backup write used to copy that suspect state
// over its own backed-up counterpart, so a single startup replaced the last
// known-good copy — and every restart repeated it, which is what made the
// backup untrustworthy as a recovery source after one restart.
//
// Protected lineages are now skipped by the writer: renewal/<id>.conf,
// live/<id> and archive/<id> are left exactly as the backup already has them,
// present or absent, while everything else continues to update.
//
// Exercised against real temp directories (like renewal-stems.test.js and
// reconcile.test.js) because the contract is about real copy, merge and symlink
// behaviour that a mocked fs cannot show.

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../utils.js', () => {
  const { execFile, exec } = require('child_process');
  return {
    // Real copies against the temp trees — the point of these tests.
    command: jest.fn((cmd) => new Promise((resolve, reject) => {
      exec(cmd, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    })),
    commandSafe: jest.fn((bin, args) => new Promise((resolve, reject) => {
      execFile(bin, args, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    })),
  };
});

const { backupCertbotState } = require('../letsencrypt/utils.js');

let tmp, source, backup;

beforeEach(() => {
  // Call records only — the mock factory's implementations (real exec/execFile
  // against the temp trees) are set with jest.fn(impl) and survive this, which
  // is what the copy assertions below rely on.
  jest.clearAllMocks();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-protect-'));
  source = path.join(tmp, 'letsencrypt');
  backup = path.join(tmp, 'backup');
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(backup, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Build a Certbot-shaped lineage: archive holds the real files, live holds
// relative symlinks into archive.
const lineage = (root, id, marker) => {
  fs.mkdirSync(path.join(root, 'archive', id), { recursive: true });
  fs.mkdirSync(path.join(root, 'live', id), { recursive: true });
  fs.mkdirSync(path.join(root, 'renewal'), { recursive: true });
  for (const name of ['cert', 'privkey', 'chain', 'fullchain']) {
    fs.writeFileSync(path.join(root, 'archive', id, `${name}1.pem`), `${marker}-${name}\n`);
    fs.symlinkSync(`../../archive/${id}/${name}1.pem`, path.join(root, 'live', id, `${name}.pem`));
  }
  fs.writeFileSync(path.join(root, 'renewal', `${id}.conf`), `# ${marker}\n[renewalparams]\n`);
};

const corruptRenewal = (root, id) =>
  fs.writeFileSync(path.join(root, 'renewal', `${id}.conf`), '!!! not remotely valid ini !!!\n');

const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const exists = (...p) => fs.existsSync(path.join(...p));
const run = (protectedLineages = []) =>
  backupCertbotState({ protectedLineages, sourceDir: source, backupPath: backup });

// ──────────────────────────────────────────────
//  A. the protected copy survives
// ──────────────────────────────────────────────
describe('a protected lineage keeps its existing backup', () => {
  beforeEach(() => {
    lineage(backup, 'A', 'known-good');   // healthy copy already in the backup
    lineage(source, 'A', 'suspect');      // local copy, now undiscoverable
    corruptRenewal(source, 'A');
  });

  it('leaves the backed-up renewal config untouched', async () => {
    await run(['A']);

    expect(read(backup, 'renewal', 'A.conf')).toBe('# known-good\n[renewalparams]\n');
  });

  it('leaves the backed-up archive material untouched', async () => {
    await run(['A']);

    expect(read(backup, 'archive', 'A', 'cert1.pem')).toBe('known-good-cert\n');
    expect(read(backup, 'archive', 'A', 'privkey1.pem')).toBe('known-good-privkey\n');
  });

  it('leaves the backed-up live symlinks untouched', async () => {
    await run(['A']);

    const link = path.join(backup, 'live', 'A', 'cert.pem');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(link)).toBe('../../archive/A/cert1.pem');
  });

  // Protection is one recovery unit: a config from one point in time paired
  // with material from another would not be restorable.
  it('protects renewal, live and archive together', async () => {
    await run(['A']);

    expect(read(backup, 'renewal', 'A.conf')).toContain('known-good');
    expect(read(backup, 'archive', 'A', 'cert1.pem')).toContain('known-good');
    expect(read(backup, 'live', 'A', 'cert.pem')).toContain('known-good');
  });

  it('survives repeated writes, so restarts cannot wear it down', async () => {
    await run(['A']);
    await run(['A']);
    await run(['A']);

    expect(read(backup, 'renewal', 'A.conf')).toBe('# known-good\n[renewalparams]\n');
    expect(read(backup, 'archive', 'A', 'cert1.pem')).toBe('known-good-cert\n');
  });

  it('never deletes protected backup material', async () => {
    await run(['A']);

    expect(exists(backup, 'renewal', 'A.conf')).toBe(true);
    expect(exists(backup, 'live', 'A')).toBe(true);
    expect(exists(backup, 'archive', 'A')).toBe(true);
  });
});

// ──────────────────────────────────────────────
//  B. absent stays absent
// ──────────────────────────────────────────────
describe('a protected lineage with no prior backup', () => {
  it('is not created from the suspect local state', async () => {
    lineage(source, 'A', 'suspect');
    corruptRenewal(source, 'A');

    await run(['A']);

    expect(exists(backup, 'renewal', 'A.conf')).toBe(false);
    expect(exists(backup, 'live', 'A')).toBe(false);
    expect(exists(backup, 'archive', 'A')).toBe(false);
  });
});

// ──────────────────────────────────────────────
//  C/D. unprotected state still advances
// ──────────────────────────────────────────────
describe('unprotected lineages keep updating', () => {
  it('updates a healthy lineage while protecting the damaged one', async () => {
    lineage(backup, 'A', 'known-good');
    lineage(backup, 'B', 'older');
    lineage(source, 'A', 'suspect');
    corruptRenewal(source, 'A');
    lineage(source, 'B', 'newer');

    await run(['A']);

    expect(read(backup, 'renewal', 'A.conf')).toBe('# known-good\n[renewalparams]\n');
    expect(read(backup, 'renewal', 'B.conf')).toBe('# newer\n[renewalparams]\n');
    expect(read(backup, 'archive', 'B', 'cert1.pem')).toBe('newer-cert\n');
  });

  it('backs up a healthy lineage the backup did not have yet', async () => {
    lineage(source, 'A', 'suspect');
    corruptRenewal(source, 'A');
    lineage(source, 'B', 'fresh');

    await run(['A']);

    expect(exists(backup, 'renewal', 'A.conf')).toBe(false);
    expect(read(backup, 'renewal', 'B.conf')).toBe('# fresh\n[renewalparams]\n');
    expect(fs.lstatSync(path.join(backup, 'live', 'B', 'cert.pem')).isSymbolicLink()).toBe(true);
  });

  it('supports several protected lineages at once', async () => {
    for (const id of ['A', 'B']) {
      lineage(backup, id, 'known-good');
      lineage(source, id, 'suspect');
      corruptRenewal(source, id);
    }
    lineage(source, 'C', 'healthy');

    await run(['A', 'B']);

    expect(read(backup, 'renewal', 'A.conf')).toContain('known-good');
    expect(read(backup, 'renewal', 'B.conf')).toContain('known-good');
    expect(read(backup, 'renewal', 'C.conf')).toContain('healthy');
  });
});

// ──────────────────────────────────────────────
//  E/F. shape and global state
// ──────────────────────────────────────────────
describe('backup shape is unchanged', () => {
  it('copies live entries as symlinks, not dereferenced files', async () => {
    lineage(source, 'B', 'healthy');

    await run(['A']);

    const link = path.join(backup, 'live', 'B', 'fullchain.pem');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(link)).toBe('../../archive/B/fullchain1.pem');
  });

  it('still copies non-lineage Certbot state', async () => {
    lineage(source, 'B', 'healthy');
    fs.mkdirSync(path.join(source, 'accounts', 'acme-v02'), { recursive: true });
    fs.writeFileSync(path.join(source, 'accounts', 'acme-v02', 'meta.json'), '{}');
    fs.mkdirSync(path.join(source, 'renewal-hooks', 'deploy'), { recursive: true });

    await run(['A']);

    expect(read(backup, 'accounts', 'acme-v02', 'meta.json')).toBe('{}');
    expect(exists(backup, 'renewal-hooks', 'deploy')).toBe(true);
  });

  // The unfiltered command is a shell glob, which never matches dotfiles. The
  // filtered path must agree, or turning protection on would silently start
  // backing up files the bulk copy never included.
  it('skips dotfiles, exactly as the bulk copy does', async () => {
    lineage(source, 'B', 'healthy');
    fs.writeFileSync(path.join(source, '.nginx-server-renewal-schema'), 'webroot-renewal-v1');

    await run(['A']);

    expect(exists(backup, '.nginx-server-renewal-schema')).toBe(false);
  });

  it('leaves an unrelated file the backup already had', async () => {
    fs.mkdirSync(path.join(backup, 'accounts'), { recursive: true });
    fs.writeFileSync(path.join(backup, 'accounts', 'old.json'), 'keep me');
    lineage(source, 'B', 'healthy');

    await run(['A']);

    expect(read(backup, 'accounts', 'old.json')).toBe('keep me');
  });
});

// ──────────────────────────────────────────────
//  G/H. no protection, and orphans
// ──────────────────────────────────────────────
describe('with nothing protected', () => {
  const { command, commandSafe } = require('../utils.js');

  // This path used to be one shell command, `cp -rf ${source}/* ${backup}`,
  // whose glob interpolated CERTBOT_BACKUP_PATH into a shell string. It is now
  // one execFile per top-level entry — same binary, same flags, same sources —
  // with the glob's enumeration done in Node instead.
  it('copies each top-level entry with cp -rf, without a shell', async () => {
    lineage(source, 'A', 'healthy');

    await run([]);

    const copies = commandSafe.mock.calls.map(([bin, args]) => [bin, ...args]);
    expect(copies).toEqual(
      expect.arrayContaining([
        ['cp', '-rf', '--', `${source}/archive`, backup],
        ['cp', '-rf', '--', `${source}/live`, backup],
        ['cp', '-rf', '--', `${source}/renewal`, backup],
      ])
    );
    expect(copies).toHaveLength(3);
    expect(command).not.toHaveBeenCalled();
  });

  // The glob it replaced never matched top-level dotfiles; the enumeration has
  // to agree, or the unprotected path would silently start backing up files the
  // bulk copy never included (migrate_renewal.js's schema marker, above all).
  it('still skips top-level dotfiles, exactly as the glob did', async () => {
    lineage(source, 'A', 'healthy');
    fs.writeFileSync(path.join(source, '.nginx-server-renewal-schema'), 'webroot-renewal-v1');

    await run([]);

    expect(exists(backup, '.nginx-server-renewal-schema')).toBe(false);
  });

  // ...but a dotfile *inside* a copied directory was always included, because
  // the glob only ever filtered its own expansion. `cp -rf <dir>` still copies
  // the whole directory, so that half must not change either.
  it('still copies dotfiles nested inside a copied directory', async () => {
    lineage(source, 'A', 'healthy');
    fs.writeFileSync(path.join(source, 'renewal', '.keep'), 'nested');

    await run([]);

    expect(read(backup, 'renewal', '.keep')).toBe('nested');
  });

  // The reason this call site moved off the shell helper: CERTBOT_BACKUP_PATH
  // is operator-supplied, and a bind-mounted backup directory can contain a
  // space. Under the old shell string this copied into two wrong destinations.
  it('handles a backup path containing spaces', async () => {
    const spaced = path.join(tmp, 'my backup dir');
    fs.mkdirSync(spaced, { recursive: true });
    lineage(source, 'A', 'healthy');

    await backupCertbotState({ protectedLineages: [], sourceDir: source, backupPath: spaced });

    expect(fs.readFileSync(path.join(spaced, 'renewal', 'A.conf'), 'utf8'))
      .toBe('# healthy\n[renewalparams]\n');
    expect(fs.existsSync(path.join(spaced, 'archive', 'A', 'cert1.pem'))).toBe(true);
  });

  it('handles a source path containing spaces', async () => {
    const spacedSource = path.join(tmp, 'my letsencrypt dir');
    fs.mkdirSync(spacedSource, { recursive: true });
    lineage(spacedSource, 'A', 'healthy');

    await backupCertbotState({ protectedLineages: [], sourceDir: spacedSource, backupPath: backup });

    expect(read(backup, 'renewal', 'A.conf')).toBe('# healthy\n[renewalparams]\n');
  });

  it('copies everything, including a lineage that would otherwise be protected', async () => {
    lineage(backup, 'A', 'older');
    lineage(source, 'A', 'newer');

    await run([]);

    expect(read(backup, 'renewal', 'A.conf')).toBe('# newer\n[renewalparams]\n');
  });

  // An undiscoverable lineage that is no longer configured is an orphan: it is
  // deleted locally by the handler and is deliberately NOT in the protected
  // set, so nothing here preserves its backup on its behalf.
  it('does not protect a lineage merely because it is undiscoverable', async () => {
    lineage(backup, 'orphan', 'older');
    lineage(source, 'orphan', 'newer');
    corruptRenewal(source, 'orphan');

    await run([]);

    expect(read(backup, 'renewal', 'orphan.conf')).toBe('!!! not remotely valid ini !!!\n');
  });
});

// ──────────────────────────────────────────────
//  I. a source with nothing visible in it
// ──────────────────────────────────────────────
//
// The unprotected branch used to be `cp -rf ${source}/* ${backup}`. A glob with
// zero matches is passed through literally, so cp could not stat it and the
// write failed; enumerating in Node copies nothing and returns instead.
//
// The no-op is the intended reading, on the repository's own evidence rather
// than as a side effect of dropping the glob: the protected branch has
// enumerated with this same filter since protection was introduced, and has
// always no-opped on an empty source — so failing was never a property of this
// function, only of one of its two spellings. The caller in
// js/letsencrypt/index.js states the same policy directly ("a backup is an
// optimisation — skipping one write is harmless"), and copying nothing
// overwrites nothing.
//
// It is also unreachable in production: both callers reach a backup write only
// after a successful `certbot certificates`, and on the pinned Certbot 5.6.0
// that call creates /etc/letsencrypt with renewal-hooks/ inside it, so the
// listing always has at least one visible entry. Pinned here so the two
// branches cannot drift apart again.
describe('a source with no visible entries', () => {
  const { commandSafe } = require('../utils.js');

  it('copies nothing and succeeds, with nothing protected', async () => {
    await expect(run([])).resolves.toBeUndefined();

    expect(commandSafe).not.toHaveBeenCalled();
    expect(fs.readdirSync(backup)).toEqual([]);
  });

  it('copies nothing and succeeds, with a lineage protected', async () => {
    await expect(run(['A'])).resolves.toBeUndefined();

    expect(commandSafe).not.toHaveBeenCalled();
    expect(fs.readdirSync(backup)).toEqual([]);
  });

  it('treats a source holding only dotfiles the same way', async () => {
    fs.writeFileSync(path.join(source, '.nginx-server-renewal-schema'), 'webroot-renewal-v1');

    await expect(run([])).resolves.toBeUndefined();

    expect(commandSafe).not.toHaveBeenCalled();
  });

  // Distinct from "empty": an absent source is not proof that there is nothing
  // to back up, and it failed before this change too (cp could not stat the
  // literal glob). Unchanged, deliberately.
  it('still fails when the source directory does not exist at all', async () => {
    fs.rmSync(source, { recursive: true, force: true });

    await expect(run([])).rejects.toBeDefined();
  });
});

// ──────────────────────────────────────────────
//  J. a hostile backup path
// ──────────────────────────────────────────────
//
// CERTBOT_BACKUP_PATH is operator-supplied and validated nowhere. execFile
// keeps a shell away from it; `--` keeps cp's own option parser away from it.
// Exercised with a relative path, since that is the only way an operand can
// actually begin with `-` — the pinned runtime's BusyBox 1.37.0 answers
// `cp: unrecognized option: e` for a `-dest` operand without the marker.
describe('a backup path beginning with a hyphen', () => {
  const { commandSafe } = require('../utils.js');
  let cwd;

  beforeEach(() => {
    cwd = process.cwd();
    process.chdir(tmp);
    fs.mkdirSync('-backup', { recursive: true });
  });

  // Runs before the outer afterEach removes tmp, so the working directory is
  // never left pointing at a deleted path.
  afterEach(() => {
    process.chdir(cwd);
  });

  it('is copied into rather than read as cp options', async () => {
    lineage(source, 'A', 'healthy');

    await backupCertbotState({ protectedLineages: [], sourceDir: source, backupPath: '-backup' });

    expect(read(tmp, '-backup', 'renewal', 'A.conf')).toBe('# healthy\n[renewalparams]\n');
    expect(exists(tmp, '-backup', 'archive', 'A', 'cert1.pem')).toBe(true);
    for (const [, args] of commandSafe.mock.calls) {
      expect(args.indexOf('--')).toBeLessThan(args.indexOf('-backup'));
    }
  });

  it('is copied into on the protected path too', async () => {
    lineage(source, 'A', 'healthy');
    lineage(source, 'B', 'healthy');

    await backupCertbotState({ protectedLineages: ['A'], sourceDir: source, backupPath: '-backup' });

    expect(read(tmp, '-backup', 'renewal', 'B.conf')).toBe('# healthy\n[renewalparams]\n');
    expect(exists(tmp, '-backup', 'renewal', 'A.conf')).toBe(false);
    for (const [, args] of commandSafe.mock.calls) {
      expect(args.indexOf('--')).toBeLessThan(args.findIndex((a) => a.startsWith('-backup')));
    }
  });
});

// ──────────────────────────────────────────────
//  The shared "still desired" rule
// ──────────────────────────────────────────────
//
// The renewal process runs in its own container process and cannot see the
// handler's in-memory entry set, so it classifies lineages through this
// predicate instead. The table below is deliberately the same one
// undiscoverable-lineages.test.js asserts against the handler itself, so the
// two cannot drift apart unnoticed.
describe('isDesiredLetsencryptEntry', () => {
  const { isDesiredLetsencryptEntry } = require('../letsencrypt/utils.js');

  it.each([
    ['letsencrypt', { mode: 'letsencrypt', names: ['a'] }],
    ['letsencrypt-staging', { mode: 'letsencrypt-staging', names: ['a'] }],
    // An omitted mode defaults to letsencrypt, matching validateConfigEntry.
    ['omitted mode', { names: ['a'] }],
  ])('treats %s as desired', (_label, entry) => {
    expect(isDesiredLetsencryptEntry(entry)).toBe(true);
  });

  it.each([
    ['http', { mode: 'http', names: ['a'] }],
    ['custom', { mode: 'custom', names: ['a'] }],
  ])('treats %s as not desired', (_label, entry) => {
    expect(isDesiredLetsencryptEntry(entry)).toBe(false);
  });

  it('treats an id absent from config.json as not desired', () => {
    expect(isDesiredLetsencryptEntry(undefined)).toBe(false);
  });
});
