// Production generated-config reconciliation (js/reconcile.js).
//
// Production startup owns /etc/nginx/conf.d/80 and /etc/nginx/conf.d/443: it
// clears both and restores the two default vhosts before any mode handler
// runs, so a restart of the same container rebuilds active nginx state from
// the current config.json instead of inheriting the previous startup's
// writable-layer residue.
//
// Exercised against a real temp filesystem (same approach as
// renewal-migration.test.js) rather than a mocked fs, because the contract
// depends on real filesystem semantics — most importantly that a *dangling*
// symlink is enumerated and removed, which an existsSync-based implementation
// would silently miss.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { reconcileGeneratedConfig } = require('../reconcile.js');

let tmp, dir80, dir443, src80, src443, siteFile;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-'));
  dir80 = path.join(tmp, 'conf.d', '80');
  dir443 = path.join(tmp, 'conf.d', '443');
  src80 = path.join(tmp, 'image', 'nginx.vh.default.80.conf');
  src443 = path.join(tmp, 'image', 'nginx.vh.default.443.conf');
  siteFile = path.join(tmp, 'sites', 'A.conf');

  fs.mkdirSync(dir80, { recursive: true });
  fs.mkdirSync(dir443, { recursive: true });
  fs.mkdirSync(path.dirname(src80), { recursive: true });
  fs.mkdirSync(path.dirname(siteFile), { recursive: true });
  fs.writeFileSync(src80, 'DEFAULT-80-VHOST');
  fs.writeFileSync(src443, 'DEFAULT-443-VHOST');
  fs.writeFileSync(siteFile, 'server { }');

  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  jest.restoreAllMocks();
});

const opts = () => ({ dir80, dir443, src80, src443 });
const ls = (dir) => fs.readdirSync(dir).sort();

describe('reconcileGeneratedConfig — clears both generated directories', () => {
  it('removes every previously generated artifact from conf.d/443 and conf.d/80', () => {
    fs.writeFileSync(path.join(dir443, 'nginx.vh.default.443.conf'), 'stale default');
    fs.symlinkSync(siteFile, path.join(dir443, 'A.conf'));          // SSL site link
    fs.writeFileSync(path.join(dir80, 'A-http-redirect.conf'), '301'); // redirect
    fs.symlinkSync(siteFile, path.join(dir80, 'B.conf'));            // HTTP site link

    reconcileGeneratedConfig(opts());

    expect(ls(dir443)).toEqual(['nginx.vh.default.443.conf']);
    expect(ls(dir80)).toEqual(['nginx.vh.default.80.conf']);
  });

  it('removes a dangling symlink left by a site whose source file was deleted', () => {
    fs.symlinkSync(path.join(tmp, 'sites', 'deleted.conf'), path.join(dir443, 'gone.conf'));
    // The link exists but its target does not — existsSync() follows symlinks
    // and reports false, which is exactly why the implementation enumerates
    // with readdirSync instead.
    expect(fs.existsSync(path.join(dir443, 'gone.conf'))).toBe(false);

    reconcileGeneratedConfig(opts());

    expect(ls(dir443)).toEqual(['nginx.vh.default.443.conf']);
    expect(fs.readdirSync(dir443)).not.toContain('gone.conf');
  });

  it('removes a stray directory as well as files', () => {
    fs.mkdirSync(path.join(dir80, 'straydir'));
    fs.writeFileSync(path.join(dir80, 'straydir', 'x.conf'), 'x');

    reconcileGeneratedConfig(opts());

    expect(ls(dir80)).toEqual(['nginx.vh.default.80.conf']);
  });

  it('never touches the user-owned site file a link pointed at', () => {
    fs.symlinkSync(siteFile, path.join(dir443, 'A.conf'));

    reconcileGeneratedConfig(opts());

    expect(fs.existsSync(siteFile)).toBe(true);
    expect(fs.readFileSync(siteFile, 'utf8')).toBe('server { }');
  });

  it('reports how many artifacts were removed', () => {
    fs.writeFileSync(path.join(dir443, 'a.conf'), 'a');
    fs.writeFileSync(path.join(dir443, 'b.conf'), 'b');
    fs.writeFileSync(path.join(dir80, 'c.conf'), 'c');

    expect(reconcileGeneratedConfig(opts())).toEqual({ removed: 3 });
  });
});

describe('reconcileGeneratedConfig — restores both default vhosts', () => {
  it('restores the default :443 vhost from the canonical image copy', () => {
    reconcileGeneratedConfig(opts());
    expect(fs.readFileSync(path.join(dir443, 'nginx.vh.default.443.conf'), 'utf8'))
      .toBe('DEFAULT-443-VHOST');
  });

  it('restores the default :80 vhost from the canonical image copy', () => {
    reconcileGeneratedConfig(opts());
    expect(fs.readFileSync(path.join(dir80, 'nginx.vh.default.80.conf'), 'utf8'))
      .toBe('DEFAULT-80-VHOST');
  });

  it('restores both even when the previous startup had removed them (development residue)', () => {
    // js/dev/index.js deliberately deletes both defaults; a later production
    // startup has to put them back.
    fs.symlinkSync(siteFile, path.join(dir443, 'dev.conf'));
    fs.writeFileSync(path.join(dir80, 'dev-http-redirect.conf'), '301');

    reconcileGeneratedConfig(opts());

    expect(ls(dir443)).toEqual(['nginx.vh.default.443.conf']);
    expect(ls(dir80)).toEqual(['nginx.vh.default.80.conf']);
  });

  it('overwrites a modified default vhost with the canonical content', () => {
    fs.writeFileSync(path.join(dir443, 'nginx.vh.default.443.conf'), 'tampered');

    reconcileGeneratedConfig(opts());

    expect(fs.readFileSync(path.join(dir443, 'nginx.vh.default.443.conf'), 'utf8'))
      .toBe('DEFAULT-443-VHOST');
  });

  it('recreates the directories when they are missing entirely', () => {
    fs.rmSync(dir80, { recursive: true, force: true });
    fs.rmSync(dir443, { recursive: true, force: true });

    reconcileGeneratedConfig(opts());

    expect(ls(dir443)).toEqual(['nginx.vh.default.443.conf']);
    expect(ls(dir80)).toEqual(['nginx.vh.default.80.conf']);
  });
});

describe('reconcileGeneratedConfig — failure is fatal (throws, never partial-and-silent)', () => {
  it('throws when the default :80 source is missing', () => {
    fs.rmSync(src80);
    expect(() => reconcileGeneratedConfig(opts())).toThrow();
  });

  it('throws when the default :443 source is missing', () => {
    fs.rmSync(src443);
    expect(() => reconcileGeneratedConfig(opts())).toThrow();
  });
});
