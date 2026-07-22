// Same-container restart reconciliation — the B1..B7 defect classes.
//
// Before centralized reconciliation, generated nginx state survived a restart
// of the same container: the only broad cleanup lived inside the Let's Encrypt
// handler and ran only when it had at least one entry of its own. Removed LE,
// custom and HTTP sites therefore stayed live, obsolete redirects kept
// redirecting, a mode change left the same site linked from both port
// directories, and a deleted site file left a dangling link that aborted
// startup.
//
// Each case below runs TWO startups against one persistent temp filesystem —
// the writable layer a `docker restart` preserves — and asserts the state
// after the second one.
//
// Scope of this harness: it exercises the real reconcileProductionConfig() /
// reconcileDevelopmentConfig()
// (the thing under test) and models the artifacts each handler creates via
// `applyMode` below, which mirrors js/utils.js configFiles()/httpRedirect()
// and js/http/index.js. The handlers write to hardcoded /etc/nginx paths and
// so cannot run here; they are covered end-to-end against the real modules by
// the container-based verification described in the commit, and individually
// by letsencrypt-default-vhost.test.js, custom-propagation.test.js,
// http-site-link.test.js and utils.test.js.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { reconcileProductionConfig, reconcileDevelopmentConfig } = require('../reconcile.js');

let tmp, dir80, dir443, src80, src443, sitesDir;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-recon-'));
  dir80 = path.join(tmp, 'conf.d', '80');
  dir443 = path.join(tmp, 'conf.d', '443');
  src80 = path.join(tmp, 'image', 'nginx.vh.default.80.conf');
  src443 = path.join(tmp, 'image', 'nginx.vh.default.443.conf');
  sitesDir = path.join(tmp, 'sites');

  fs.mkdirSync(dir80, { recursive: true });
  fs.mkdirSync(dir443, { recursive: true });
  fs.mkdirSync(path.dirname(src80), { recursive: true });
  fs.mkdirSync(sitesDir, { recursive: true });
  fs.writeFileSync(src80, 'DEFAULT-80-VHOST');
  fs.writeFileSync(src443, 'DEFAULT-443-VHOST');
  for (const id of ['A', 'B', 'C', 'dev']) fs.writeFileSync(path.join(sitesDir, `${id}.conf`), 'server { }');

  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  jest.restoreAllMocks();
});

const opts = () => ({ dir80, dir443, src80, src443 });
const sitePath = (id) => path.join(sitesDir, `${id}.conf`);
const ls = (dir) => fs.readdirSync(dir).sort();

// Mirrors what each production handler adds for one configured site:
//   letsencrypt / custom -> configFiles(): conf.d/443/<id>.conf symlink,
//                           plus conf.d/80/<id>-http-redirect.conf when
//                           http_redirect !== false
//   http                 -> conf.d/80/<id>.conf symlink (F3: link, not copy)
const applyMode = (id, mode, { http_redirect = true } = {}) => {
  if (mode === 'http') {
    fs.symlinkSync(sitePath(id), path.join(dir80, `${id}.conf`));
    return;
  }
  fs.symlinkSync(sitePath(id), path.join(dir443, `${id}.conf`));
  if (http_redirect !== false) {
    fs.writeFileSync(path.join(dir80, `${id}-http-redirect.conf`), `301 for ${id}`);
  }
};

// One production startup: centralized reset, then handlers add current sites.
const startup = (sites) => {
  reconcileProductionConfig(opts());
  for (const s of sites) applyMode(s.id, s.mode, s);
};

// One development startup: reset with NO production defaults, then dev() links
// its single fixed site and writes its redirect (mirrors js/dev/index.js).
const devStartup = () => {
  reconcileDevelopmentConfig(opts());
  fs.symlinkSync(sitePath('dev'), path.join(dir443, 'dev.conf'));
  fs.writeFileSync(path.join(dir80, 'dev-http-redirect.conf'), '301 for dev');
};

// ──────────────────────────────────────────────
//  Removal, partial removal, mode change, redirect change
// ──────────────────────────────────────────────
describe('restart reconciliation — table of transitions', () => {
  const cases = [
    // [label, state 1 sites, state 2 sites, expected conf.d/443, expected conf.d/80]
    ['B1  LE A -> zero LE',
      [{ id: 'A', mode: 'letsencrypt' }], [],
      [], []],
    ['B2  custom A -> zero custom',
      [{ id: 'A', mode: 'custom' }], [],
      [], []],
    ['B3  http A -> zero http',
      [{ id: 'A', mode: 'http' }], [],
      [], []],
    ['B1  LE A+B -> only B',
      [{ id: 'A', mode: 'letsencrypt' }, { id: 'B', mode: 'letsencrypt' }],
      [{ id: 'B', mode: 'letsencrypt' }],
      ['B.conf'], ['B-http-redirect.conf']],
    ['B2  custom A+B -> only B',
      [{ id: 'A', mode: 'custom' }, { id: 'B', mode: 'custom' }],
      [{ id: 'B', mode: 'custom' }],
      ['B.conf'], ['B-http-redirect.conf']],
    ['B3  http A+B -> only B',
      [{ id: 'A', mode: 'http' }, { id: 'B', mode: 'http' }],
      [{ id: 'B', mode: 'http' }],
      [], ['B.conf']],
    ['B5  SSL -> HTTP, same id (no link left in the old port dir)',
      [{ id: 'A', mode: 'letsencrypt' }], [{ id: 'A', mode: 'http' }],
      [], ['A.conf']],
    ['B5  custom -> HTTP, same id',
      [{ id: 'A', mode: 'custom' }], [{ id: 'A', mode: 'http' }],
      [], ['A.conf']],
    ['B5  HTTP -> SSL, same id (no link left in the old port dir)',
      [{ id: 'A', mode: 'http' }], [{ id: 'A', mode: 'custom' }],
      ['A.conf'], ['A-http-redirect.conf']],
    ['B5  HTTP -> LE, same id',
      [{ id: 'A', mode: 'http' }], [{ id: 'A', mode: 'letsencrypt' }],
      ['A.conf'], ['A-http-redirect.conf']],
    ['B4  custom A http_redirect true -> false',
      [{ id: 'A', mode: 'custom', http_redirect: true }],
      [{ id: 'A', mode: 'custom', http_redirect: false }],
      ['A.conf'], []],
    ['B4  LE A http_redirect true -> false',
      [{ id: 'A', mode: 'letsencrypt', http_redirect: true }],
      [{ id: 'A', mode: 'letsencrypt', http_redirect: false }],
      ['A.conf'], []],
    ['B1  mixed LE+custom -> custom only (LE no longer cleans for custom)',
      [{ id: 'A', mode: 'letsencrypt' }, { id: 'B', mode: 'custom' }],
      [{ id: 'B', mode: 'custom' }],
      ['B.conf'], ['B-http-redirect.conf']],
    ['B3  mixed LE+http -> LE only',
      [{ id: 'A', mode: 'letsencrypt' }, { id: 'B', mode: 'http' }],
      [{ id: 'A', mode: 'letsencrypt' }],
      ['A.conf'], ['A-http-redirect.conf']],
  ];

  test.each(cases)('%s', (_label, state1, state2, want443, want80) => {
    startup(state1);
    startup(state2);

    // The defaults are always the baseline; everything else must be exactly
    // what the CURRENT configuration asks for.
    expect(ls(dir443)).toEqual([...want443, 'nginx.vh.default.443.conf'].sort());
    expect(ls(dir80)).toEqual([...want80, 'nginx.vh.default.80.conf'].sort());
  });
});

// ──────────────────────────────────────────────
//  B6 — a removed site whose source file was also deleted
// ──────────────────────────────────────────────
describe('restart reconciliation — removed site with a deleted source file (B6)', () => {
  it('removes the now-dangling link, so nginx never sees an unopenable include', () => {
    startup([{ id: 'A', mode: 'letsencrypt' }]);
    expect(ls(dir443)).toContain('A.conf');

    // The operator removes the site from config.json AND deletes its file.
    fs.rmSync(sitePath('A'));

    startup([]);

    expect(ls(dir443)).toEqual(['nginx.vh.default.443.conf']);
    expect(ls(dir80)).toEqual(['nginx.vh.default.80.conf']);
    // Nothing left in either directory can fail to open.
    for (const dir of [dir443, dir80]) {
      for (const entry of fs.readdirSync(dir)) {
        expect(fs.existsSync(path.join(dir, entry))).toBe(true);
      }
    }
  });
});

// ──────────────────────────────────────────────
//  Environment transitions (both directions)
// ──────────────────────────────────────────────
describe('restart reconciliation — development -> production (B7)', () => {
  it('clears dev artifacts and restores BOTH production defaults', () => {
    devStartup();
    expect(ls(dir443)).toEqual(['dev.conf']);
    expect(ls(dir80)).toEqual(['dev-http-redirect.conf']);

    startup([{ id: 'A', mode: 'http' }]);

    expect(ls(dir443)).toEqual(['nginx.vh.default.443.conf']);
    expect(ls(dir80)).toEqual(['A.conf', 'nginx.vh.default.80.conf']);
    expect(fs.readFileSync(path.join(dir443, 'nginx.vh.default.443.conf'), 'utf8'))
      .toBe('DEFAULT-443-VHOST');
  });
});

describe('restart reconciliation — production -> development', () => {
  // A development startup must leave exactly the dev site and its redirect,
  // and no production default vhost (dev()'s fragment is the HTTPS default).
  const DEV_443 = ['dev.conf'];
  const DEV_80 = ['dev-http-redirect.conf'];

  const cases = [
    ['previous LE site',     [{ id: 'A', mode: 'letsencrypt' }]],
    ['previous custom site', [{ id: 'A', mode: 'custom' }]],
    ['previous HTTP site',   [{ id: 'A', mode: 'http' }]],
    ['mixed production state', [
      { id: 'A', mode: 'letsencrypt' },
      { id: 'B', mode: 'custom' },
      { id: 'C', mode: 'http' },
    ]],
  ];

  test.each(cases)('%s is fully removed', (_label, productionSites) => {
    startup(productionSites);
    devStartup();

    expect(ls(dir443)).toEqual(DEV_443);
    expect(ls(dir80)).toEqual(DEV_80);
  });

  it('leaves no production default vhost behind for dev to collide with', () => {
    startup([{ id: 'A', mode: 'letsencrypt' }]);
    devStartup();

    expect(fs.existsSync(path.join(dir443, 'nginx.vh.default.443.conf'))).toBe(false);
    expect(fs.existsSync(path.join(dir80, 'nginx.vh.default.80.conf'))).toBe(false);
  });

  it('produces the same state as a development startup on a fresh container', () => {
    devStartup();                       // fresh
    const fresh = { d443: ls(dir443), d80: ls(dir80) };

    fs.rmSync(dir443, { recursive: true, force: true });
    fs.rmSync(dir80, { recursive: true, force: true });
    fs.mkdirSync(dir443, { recursive: true });
    fs.mkdirSync(dir80, { recursive: true });

    startup([{ id: 'A', mode: 'letsencrypt' }, { id: 'C', mode: 'http' }]);
    devStartup();                       // after production residue

    expect({ d443: ls(dir443), d80: ls(dir80) }).toEqual(fresh);
  });
});

describe('restart reconciliation — development -> development is idempotent', () => {
  it('does not accumulate artifacts across repeated development startups', () => {
    devStartup();
    const after1 = { d443: ls(dir443), d80: ls(dir80) };

    devStartup();
    devStartup();

    expect({ d443: ls(dir443), d80: ls(dir80) }).toEqual(after1);
    expect(ls(dir443)).toEqual(['dev.conf']);
    expect(ls(dir80)).toEqual(['dev-http-redirect.conf']);
  });
});

// ──────────────────────────────────────────────
//  Reconciliation is unconditional
// ──────────────────────────────────────────────
describe('restart reconciliation — runs regardless of which modes have entries', () => {
  it('an entirely empty configuration still converges on the bare defaults', () => {
    startup([
      { id: 'A', mode: 'letsencrypt' },
      { id: 'B', mode: 'http' },
    ]);

    startup([]);

    expect(ls(dir443)).toEqual(['nginx.vh.default.443.conf']);
    expect(ls(dir80)).toEqual(['nginx.vh.default.80.conf']);
  });

  it('repeated identical startups are idempotent', () => {
    const sites = [{ id: 'A', mode: 'letsencrypt' }, { id: 'B', mode: 'http' }];
    startup(sites);
    const after1 = { d443: ls(dir443), d80: ls(dir80) };
    startup(sites);

    expect({ d443: ls(dir443), d80: ls(dir80) }).toEqual(after1);
  });
});
