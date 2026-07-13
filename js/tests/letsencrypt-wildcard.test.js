// Let's Encrypt wildcard-capability tests.
//
// Wildcard names are syntactically valid (validateDomain accepts "*.example.com")
// and usable by the http/custom modes, but this image's Let's Encrypt flow proves
// domain control over http-01 (--standalone at issuance, webroot at renewal),
// which cannot satisfy a wildcard. js/letsencrypt/index.js therefore drops those
// entries immediately after the mode filter/default stage — before parseCerts and
// before any certificate deletion or creation — and warns per site.
//
// Mocking mirrors letsencrypt-propagation.test.js. ../validate.js is deliberately
// NOT mocked so the real isWildcardDomain predicate is exercised end to end.

// Mutated per test. The factory must return a stable reference: the handler's
// require("../config.json") result is cached after the first call.
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

// The handler appends the renewal cron line to /etc/crontabs/root; stub fs so the
// suite never touches the host filesystem (same approach as utils.test.js).
jest.mock('fs', () => ({ appendFileSync: jest.fn() }));

const { parseCerts, checkCertFiles } = require('../letsencrypt/utils.js');
const { createCert, deleteCert } = require('../letsencrypt/manage_certs.js');
const letsencryptMode = require('../letsencrypt/index.js');

const setConfig = (entries) => {
  for (const key of Object.keys(mockConfig)) delete mockConfig[key];
  Object.assign(mockConfig, entries);
};

let warnSpy;
const warnings = () => warnSpy.mock.calls.map((call) => call[0]).join('\n');

beforeEach(() => {
  jest.clearAllMocks();
  parseCerts.mockResolvedValue({});
  checkCertFiles.mockReturnValue(true);
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ──────────────────────────────────────────────
//  Wildcard entries are warned about and skipped
// ──────────────────────────────────────────────
describe('letsencrypt handler — wildcard names are skipped', () => {
  const modes = [
    ['letsencrypt', { mode: 'letsencrypt' }],
    ['letsencrypt-staging', { mode: 'letsencrypt-staging' }],
    ['omitted mode (defaults to letsencrypt)', {}],
  ];

  test.each(modes)('%s + "*.example.com" is skipped', async (_label, modeFields) => {
    setConfig({ wild: Object.assign({ names: ['*.example.com'], email: 'admin@example.com' }, modeFields) });

    await letsencryptMode();

    expect(createCert).not.toHaveBeenCalled();
    expect(deleteCert).not.toHaveBeenCalled();
  });

  test.each(modes)('%s + "*.example.com" warns with an actionable message', async (_label, modeFields) => {
    setConfig({ wild: Object.assign({ names: ['*.example.com'], email: 'admin@example.com' }, modeFields) });

    await letsencryptMode();

    const text = warnings();
    expect(text).toContain('"wild"');            // names the offending site id
    expect(text).toContain('*.example.com');     // names the offending domain
    expect(text).toContain('DNS-01');            // says why it cannot work
    expect(text).toContain('skipping wild');     // says what was done
  });

  test.each(modes)('%s + "*.example.com" is dropped before parseCerts runs', async (_label, modeFields) => {
    setConfig({ wild: Object.assign({ names: ['*.example.com'] }, modeFields) });

    await letsencryptMode();

    // The only entry was unprocessable, so the handler returns before any
    // certbot reconciliation work begins.
    expect(parseCerts).not.toHaveBeenCalled();
  });

  it('detects a wildcard in any position of the names array', async () => {
    setConfig({ wild: { mode: 'letsencrypt', names: ['example.com', '*.example.com'] } });

    await letsencryptMode();

    expect(warnings()).toContain('skipping wild');
    expect(createCert).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────
//  Ordinary entries are unaffected
// ──────────────────────────────────────────────
describe('letsencrypt handler — ordinary domains are unchanged', () => {
  it('processes a non-wildcard entry normally and warns about nothing', async () => {
    setConfig({ main: { mode: 'letsencrypt', names: ['example.com', 'www.example.com'], email: 'admin@example.com' } });

    await letsencryptMode();

    expect(parseCerts).toHaveBeenCalled();
    expect(createCert).toHaveBeenCalledWith('main');
    expect(warnings()).not.toMatch(/wildcard/i);
  });

  it('skips only the wildcard entry in a mixed configuration', async () => {
    setConfig({
      wild: { mode: 'letsencrypt', names: ['*.example.com'] },
      main: { mode: 'letsencrypt', names: ['example.com'] },
    });

    await letsencryptMode();

    expect(createCert).toHaveBeenCalledWith('main');
    expect(createCert).not.toHaveBeenCalledWith('wild');
    expect(createCert).toHaveBeenCalledTimes(1);
    expect(warnings()).toContain('skipping wild');
  });
});

// ──────────────────────────────────────────────
//  Safety: no certificate lineage may be destroyed
// ──────────────────────────────────────────────
describe('letsencrypt handler — a skipped wildcard entry never deletes a certificate', () => {
  const existingLineage = {
    wild: {
      cert_path: '/etc/letsencrypt/live/wild/fullchain.pem',
      cert_key_path: '/etc/letsencrypt/live/wild/privkey.pem',
      cert_domains: ['example.com'],
      status: 'valid',
    },
  };

  it('does not delete + recreate when an existing lineage would fail checkCertFiles', async () => {
    // The id already has a certificate (e.g. the entry previously used ordinary
    // names). A domain mismatch would normally drive delete -> recreate; the
    // entry must be gone before that reconciliation runs.
    parseCerts.mockResolvedValue(existingLineage);
    checkCertFiles.mockReturnValue(false);
    setConfig({
      wild: { mode: 'letsencrypt', names: ['*.example.com'] },
      main: { mode: 'letsencrypt', names: ['example.com'] },
    });

    await letsencryptMode();

    expect(deleteCert).not.toHaveBeenCalled();
    expect(createCert).not.toHaveBeenCalledWith('wild');
    expect(checkCertFiles).not.toHaveBeenCalledWith('wild', expect.anything());
  });

  it('does not treat the skipped entry as an orphan certificate', async () => {
    // The entry is still present in config.json — it is only unprocessable here
    // — so the "no longer in config.json" cleanup must leave it alone.
    parseCerts.mockResolvedValue(existingLineage);
    setConfig({
      wild: { mode: 'letsencrypt', names: ['*.example.com'] },
      main: { mode: 'letsencrypt', names: ['example.com'] },
    });

    await letsencryptMode();

    expect(deleteCert).not.toHaveBeenCalledWith('wild');
    expect(deleteCert).not.toHaveBeenCalled();
  });
});
