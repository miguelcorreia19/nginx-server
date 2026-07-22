// Generated-config reconciliation (js/reconcile.js).
//
// Startup owns /etc/nginx/conf.d/80 and /etc/nginx/conf.d/443 in BOTH
// environments: it clears them before any mode handler runs, so a restart of
// the same container rebuilds active nginx state from the current environment
// instead of inheriting the previous startup's writable-layer residue.
//
// The environments differ only in the baseline they leave behind:
//   production  — clears, then restores both default vhosts
//   development — clears, and restores no production defaults (dev()'s own
//                 fragment declares the HTTPS default_server)
//
// Exercised against a real temp filesystem (same approach as
// renewal-migration.test.js) rather than a mocked fs, because the contract
// depends on real filesystem semantics — most importantly that a *dangling*
// symlink is enumerated and removed, which an existsSync-based implementation
// would silently miss.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { reconcileProductionConfig, reconcileDevelopmentConfig } = require('../reconcile.js');

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

describe('shared clearing (via reconcileProductionConfig) — clears both generated directories', () => {
  it('removes every previously generated artifact from conf.d/443 and conf.d/80', () => {
    fs.writeFileSync(path.join(dir443, 'nginx.vh.default.443.conf'), 'stale default');
    fs.symlinkSync(siteFile, path.join(dir443, 'A.conf'));          // SSL site link
    fs.writeFileSync(path.join(dir80, 'A-http-redirect.conf'), '301'); // redirect
    fs.symlinkSync(siteFile, path.join(dir80, 'B.conf'));            // HTTP site link

    reconcileProductionConfig(opts());

    expect(ls(dir443)).toEqual(['nginx.vh.default.443.conf']);
    expect(ls(dir80)).toEqual(['nginx.vh.default.80.conf']);
  });

  it('removes a dangling symlink left by a site whose source file was deleted', () => {
    fs.symlinkSync(path.join(tmp, 'sites', 'deleted.conf'), path.join(dir443, 'gone.conf'));
    // The link exists but its target does not — existsSync() follows symlinks
    // and reports false, which is exactly why the implementation enumerates
    // with readdirSync instead.
    expect(fs.existsSync(path.join(dir443, 'gone.conf'))).toBe(false);

    reconcileProductionConfig(opts());

    expect(ls(dir443)).toEqual(['nginx.vh.default.443.conf']);
    expect(fs.readdirSync(dir443)).not.toContain('gone.conf');
  });

  it('removes a stray directory as well as files', () => {
    fs.mkdirSync(path.join(dir80, 'straydir'));
    fs.writeFileSync(path.join(dir80, 'straydir', 'x.conf'), 'x');

    reconcileProductionConfig(opts());

    expect(ls(dir80)).toEqual(['nginx.vh.default.80.conf']);
  });

  it('never touches the user-owned site file a link pointed at', () => {
    fs.symlinkSync(siteFile, path.join(dir443, 'A.conf'));

    reconcileProductionConfig(opts());

    expect(fs.existsSync(siteFile)).toBe(true);
    expect(fs.readFileSync(siteFile, 'utf8')).toBe('server { }');
  });

  it('reports how many artifacts were removed', () => {
    fs.writeFileSync(path.join(dir443, 'a.conf'), 'a');
    fs.writeFileSync(path.join(dir443, 'b.conf'), 'b');
    fs.writeFileSync(path.join(dir80, 'c.conf'), 'c');

    expect(reconcileProductionConfig(opts())).toEqual({ removed: 3 });
  });
});

describe('reconcileProductionConfig — restores both default vhosts', () => {
  it('restores the default :443 vhost from the canonical image copy', () => {
    reconcileProductionConfig(opts());
    expect(fs.readFileSync(path.join(dir443, 'nginx.vh.default.443.conf'), 'utf8'))
      .toBe('DEFAULT-443-VHOST');
  });

  it('restores the default :80 vhost from the canonical image copy', () => {
    reconcileProductionConfig(opts());
    expect(fs.readFileSync(path.join(dir80, 'nginx.vh.default.80.conf'), 'utf8'))
      .toBe('DEFAULT-80-VHOST');
  });

  it('restores both even when the previous startup had removed them (development residue)', () => {
    // js/dev/index.js deliberately deletes both defaults; a later production
    // startup has to put them back.
    fs.symlinkSync(siteFile, path.join(dir443, 'dev.conf'));
    fs.writeFileSync(path.join(dir80, 'dev-http-redirect.conf'), '301');

    reconcileProductionConfig(opts());

    expect(ls(dir443)).toEqual(['nginx.vh.default.443.conf']);
    expect(ls(dir80)).toEqual(['nginx.vh.default.80.conf']);
  });

  it('overwrites a modified default vhost with the canonical content', () => {
    fs.writeFileSync(path.join(dir443, 'nginx.vh.default.443.conf'), 'tampered');

    reconcileProductionConfig(opts());

    expect(fs.readFileSync(path.join(dir443, 'nginx.vh.default.443.conf'), 'utf8'))
      .toBe('DEFAULT-443-VHOST');
  });

  it('recreates the directories when they are missing entirely', () => {
    fs.rmSync(dir80, { recursive: true, force: true });
    fs.rmSync(dir443, { recursive: true, force: true });

    reconcileProductionConfig(opts());

    expect(ls(dir443)).toEqual(['nginx.vh.default.443.conf']);
    expect(ls(dir80)).toEqual(['nginx.vh.default.80.conf']);
  });
});

describe('reconcileProductionConfig — failure is fatal (throws, never partial-and-silent)', () => {
  it('throws when the default :80 source is missing', () => {
    fs.rmSync(src80);
    expect(() => reconcileProductionConfig(opts())).toThrow();
  });

  it('throws when the default :443 source is missing', () => {
    fs.rmSync(src443);
    expect(() => reconcileProductionConfig(opts())).toThrow();
  });
});

// ──────────────────────────────────────────────
//  Development baseline
// ──────────────────────────────────────────────
describe('reconcileDevelopmentConfig — clears, but restores no production defaults', () => {
  it('clears both directories and leaves them empty', () => {
    fs.writeFileSync(path.join(dir443, 'nginx.vh.default.443.conf'), 'default');
    fs.writeFileSync(path.join(dir80, 'nginx.vh.default.80.conf'), 'default');
    fs.symlinkSync(siteFile, path.join(dir443, 'A.conf'));
    fs.writeFileSync(path.join(dir80, 'A-http-redirect.conf'), '301');
    fs.symlinkSync(siteFile, path.join(dir80, 'B.conf'));

    reconcileDevelopmentConfig(opts());

    // Nothing at all: dev() installs its own site next, and its fragment
    // declares the HTTPS default_server, so a restored default :443 vhost
    // would be a duplicate default server.
    expect(ls(dir443)).toEqual([]);
    expect(ls(dir80)).toEqual([]);
  });

  it('does not restore the default :443 vhost', () => {
    reconcileDevelopmentConfig(opts());
    expect(fs.existsSync(path.join(dir443, 'nginx.vh.default.443.conf'))).toBe(false);
  });

  it('does not restore the default :80 vhost', () => {
    reconcileDevelopmentConfig(opts());
    expect(fs.existsSync(path.join(dir80, 'nginx.vh.default.80.conf'))).toBe(false);
  });

  it('removes production residue of every mode, including dangling symlinks', () => {
    fs.symlinkSync(siteFile, path.join(dir443, 'le.conf'));                 // LE site
    fs.writeFileSync(path.join(dir80, 'le-http-redirect.conf'), '301');     // LE redirect
    fs.symlinkSync(siteFile, path.join(dir443, 'custom.conf'));             // custom site
    fs.symlinkSync(siteFile, path.join(dir80, 'httpsite.conf'));            // HTTP site
    fs.symlinkSync(path.join(tmp, 'sites', 'deleted.conf'), path.join(dir443, 'gone.conf'));

    reconcileDevelopmentConfig(opts());

    expect(ls(dir443)).toEqual([]);
    expect(ls(dir80)).toEqual([]);
  });

  it('recreates the directories when they are missing entirely', () => {
    fs.rmSync(dir80, { recursive: true, force: true });
    fs.rmSync(dir443, { recursive: true, force: true });

    reconcileDevelopmentConfig(opts());

    expect(fs.existsSync(dir80)).toBe(true);
    expect(fs.existsSync(dir443)).toBe(true);
  });

  it('does not need the default-vhost sources to exist', () => {
    // It never copies them, so a missing source must not make it throw.
    fs.rmSync(src80);
    fs.rmSync(src443);

    expect(() => reconcileDevelopmentConfig(opts())).not.toThrow();
  });

  it('reports how many artifacts were removed', () => {
    fs.writeFileSync(path.join(dir443, 'a.conf'), 'a');
    fs.writeFileSync(path.join(dir80, 'b.conf'), 'b');

    expect(reconcileDevelopmentConfig(opts())).toEqual({ removed: 2 });
  });
});
