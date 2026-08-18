// Regression for the chain-path derivation in both certificate export paths.
//
// Both exports copy three files out of the Certbot lineage into /etc/ssl/certs,
// where nginx reads them. Two of the three sources come straight from what
// `certbot certificates` reported; the chain had no reported path and was
// derived from the private key's with
//
//     cert_key_path.replace('privkey', 'chain')
//
// String.replace() with a string pattern rewrites the FIRST occurrence, which
// is only the basename when nothing earlier in the path contains "privkey".
// validateCertId() (js/validate.js) accepts "privkey", "privkeys",
// "site-privkey" and "myprivkey-site" alike, and for every one of those the
// substitution corrupted the *directory* instead:
//
//     /etc/letsencrypt/live/site-privkey/privkey.pem
//  -> /etc/letsencrypt/live/site-chain/privkey.pem      (does not exist)
//
// `cp` then failed, which aborts startup on one path and fails the renewal
// script on the other. The fix derives the chain as a sibling of the reported
// key file, so only the basename can ever change.
//
// Both suites below pin the actual `cp` invocation rather than a standalone
// path expression: the startup handler through its mocked commandSafe, the
// renewal script through a real `cp` stub on PATH that records its argv.

// The startup suite below mocks 'fs' for the handler under test, which would
// otherwise leave this file without a working one for its own temp dirs, stub
// binaries and source reads. requireActual keeps the two separate: the handler
// still resolves the mock through the module registry.
const fs = jest.requireActual('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// The ids that matter. "main" is the control: it contains no "privkey", so the
// old and new derivations agree on it and it pins that nothing regressed.
const IDS = ['main', 'privkey', 'privkeys', 'site-privkey', 'myprivkey-site'];

// `certbot certificates` output for one lineage, in the pinned Certbot 5.6.0
// format the real parser expects (transcribed from the runtime image).
const certbotOutput = (id) => `
- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
Found the following certs:
  Certificate Name: ${id}
    Serial Number: 3d8b2f29c9fa34921b3037ebdb6d5a1cad080173
    Key Type: RSA
    Identifiers: ${id}.example.com
    Expiry Date: 2026-09-26 23:25:50+00:00 (VALID: 29 days)
    Certificate Path: /etc/letsencrypt/live/${id}/fullchain.pem
    Private Key Path: /etc/letsencrypt/live/${id}/privkey.pem
- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
`;

// ---------------------------------------------------------------------------
// Startup export — js/letsencrypt/index.js
// ---------------------------------------------------------------------------
// Mocked the same way js/tests/letsencrypt-identifiers-handler.test.js mocks
// this handler: only the layer below js/letsencrypt/utils.js is stubbed, so the
// real parser produces the cert_key_path the derivation actually consumes.

const mockConfig = {};
jest.mock('../config.json', () => mockConfig, { virtual: true });

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
  existsSync: jest.fn(() => true),
  readdirSync: jest.fn(() => []),
  appendFileSync: jest.fn(),
}));

jest.mock('luxon', () => ({ DateTime: { fromJSDate: jest.fn(() => 'mock-validity') } }));

const { command, commandSafe } = require('../utils.js');
const { createCert, deleteCert } = require('../letsencrypt/manage_certs.js');
const letsencryptMode = require('../letsencrypt/index.js');

const ENV_KEYS = ['CERTBOT_BACKUP', 'CERTBOT_BACKUP_PATH', 'CERTBOT_RENEW_CRONJOB'];
const savedEnv = {};

describe('startup export — chain path is a sibling of the reported private key', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of Object.keys(mockConfig)) delete mockConfig[key];
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

  const runHandlerFor = async (id) => {
    mockConfig[id] = { mode: 'letsencrypt', names: [`${id}.example.com`], email: 'admin@example.com' };
    command.mockImplementation((cmd) =>
      Promise.resolve(String(cmd) === 'certbot certificates' ? certbotOutput(id) : '')
    );
    // `cp` is modelled on the real thing rather than always resolving: a
    // missing source makes BusyBox cp exit non-zero, which commandSafe turns
    // into a rejection and the handler into a fatal. Only the three files
    // Certbot actually creates for this lineage exist, so a derivation that
    // points anywhere else fails here exactly as it does in production.
    const present = new Set(
      ['fullchain.pem', 'privkey.pem', 'chain.pem'].map((f) => `/etc/letsencrypt/live/${id}/${f}`)
    );
    commandSafe.mockImplementation((bin, args) => {
      if (bin === 'cp' && !present.has(args[0])) {
        return Promise.reject({ error: `cp: can't stat '${args[0]}': No such file or directory` });
      }
      return Promise.resolve();
    });
    await letsencryptMode();
  };

  // The copies the handler makes, as [source, destination] pairs.
  const copies = () =>
    commandSafe.mock.calls
      .filter(([bin, args]) => bin === 'cp' && Array.isArray(args) && args.length === 2)
      .map(([, args]) => args);

  it.each(IDS)('exports %s\'s chain from its own lineage directory', async (id) => {
    await runHandlerFor(id);

    expect(commandSafe).toHaveBeenCalledWith(
      'cp',
      [`/etc/letsencrypt/live/${id}/chain.pem`, `/etc/ssl/certs/${id}_chain.pem`],
    );
  });

  it.each(IDS)('never rewrites the lineage directory when exporting %s', async (id) => {
    await runHandlerFor(id);

    // Every source must sit under this lineage's own directory. The old
    // substitution produced live/site-chain/... for id "site-privkey", which
    // this catches regardless of which file it claimed to be.
    for (const [source] of copies()) {
      expect(source.startsWith(`/etc/letsencrypt/live/${id}/`)).toBe(true);
    }
  });

  it.each(IDS)('exports all three files for %s, each from the canonical filename', async (id) => {
    await runHandlerFor(id);

    expect(copies()).toEqual([
      [`/etc/letsencrypt/live/${id}/fullchain.pem`, `/etc/ssl/certs/${id}_fullchain.pem`],
      [`/etc/letsencrypt/live/${id}/privkey.pem`,   `/etc/ssl/certs/${id}_privkey.pem`],
      [`/etc/letsencrypt/live/${id}/chain.pem`,     `/etc/ssl/certs/${id}_chain.pem`],
    ]);
  });

  it.each(IDS)('completes startup for %s instead of aborting on a missing chain file', async (id) => {
    // The user-visible failure: the derived path did not exist, `cp` exited
    // non-zero, commandSafe rejected, and the handler turned that into a fatal.
    await expect(runHandlerFor(id)).resolves.not.toThrow();
    // And it did so without deciding the certificate needed reissuing.
    expect(deleteCert).not.toHaveBeenCalled();
    expect(createCert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Renewal export — js/letsencrypt/certbot_renew.js
// ---------------------------------------------------------------------------
// start() is not exported (the module self-invokes only under
// `require.main === module`), so this drives the real script as a child
// process with `certbot` and `cp` replaced by stubs on PATH — the same
// real-process approach js/tests/certbot-renew.test.js uses for the shell
// driver. The `cp` stub records its argv, so the assertion is against the copy
// the renewal actually performed.

describe('renewal export — chain path is a sibling of the reported private key', () => {
  const SCRIPT = path.join(__dirname, '..', 'letsencrypt', 'certbot_renew.js');
  let tmp;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-path-renewal-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const runRenewalFor = (id) => {
    const binDir = path.join(tmp, 'bin');
    const cpCalls = path.join(tmp, 'cp-calls');
    // Empty renewal dir so the defensive migration step is a no-op.
    const renewalDir = path.join(tmp, 'renewal');
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(renewalDir, { recursive: true });

    // `certbot certificates` runs through a shell (command()), `certbot renew`
    // through execFile (commandSafe); both resolve the binary via PATH.
    fs.writeFileSync(
      path.join(binDir, 'certbot'),
      `#!/bin/bash\nif [ "$1" = "certificates" ]; then cat <<'OUT'\n${certbotOutput(id)}\nOUT\nfi\nexit 0\n`,
      { mode: 0o755 },
    );
    // Records the argv of every copy, then succeeds without touching anything.
    fs.writeFileSync(
      path.join(binDir, 'cp'),
      `#!/bin/bash\nprintf '%s\\n' "$*" >> "${cpCalls}"\nexit 0\n`,
      { mode: 0o755 },
    );

    const r = spawnSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      env: {
        PATH: `${binDir}:/usr/bin:/bin`,
        // Keeps migrateRenewalConfigs() away from a real /etc/letsencrypt.
        CERTBOT_RENEWAL_DIR: renewalDir,
        CERTBOT_RENEWAL_BACKUP_DIR: path.join(tmp, 'renewal-backup'),
        CERTBOT_RENEWAL_MARKER: path.join(tmp, 'marker'),
        CERTBOT_RENEWED_FLAG: path.join(tmp, 'renewed.flag'),
        // CERTBOT_BACKUP unset: the backup branch is the only code path in this
        // script that reads config.json, which does not exist outside a
        // running container.
      },
    });

    const calls = fs.existsSync(cpCalls)
      ? fs.readFileSync(cpCalls, 'utf8').trim().split('\n').filter(Boolean)
      : [];
    return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '', calls };
  };

  it.each(IDS)('copies %s\'s chain from its own lineage directory', (id) => {
    const r = runRenewalFor(id);

    expect(r.code).toBe(0);
    expect(r.calls).toContain(
      `/etc/letsencrypt/live/${id}/chain.pem /etc/ssl/certs/${id}_chain.pem`,
    );
  });

  it.each(IDS)('never rewrites the lineage directory when renewing %s', (id) => {
    const r = runRenewalFor(id);

    expect(r.code).toBe(0);
    expect(r.calls.length).toBe(3);
    for (const call of r.calls) {
      expect(call.startsWith(`/etc/letsencrypt/live/${id}/`)).toBe(true);
    }
  });

  it.each(IDS)('exports all three files for %s', (id) => {
    const r = runRenewalFor(id);

    expect(r.calls).toEqual([
      `/etc/letsencrypt/live/${id}/fullchain.pem /etc/ssl/certs/${id}_fullchain.pem`,
      `/etc/letsencrypt/live/${id}/privkey.pem /etc/ssl/certs/${id}_privkey.pem`,
      `/etc/letsencrypt/live/${id}/chain.pem /etc/ssl/certs/${id}_chain.pem`,
    ]);
  });
});

// Neither production call site may go back to substring substitution — a
// source pin, because the behavioural suites above would also pass against a
// substitution that happened to be correct for the ids they cover.
describe('neither export derives the chain path by substring replacement', () => {
  it.each([
    ['startup', path.join(__dirname, '..', 'letsencrypt', 'index.js')],
    ['renewal', path.join(__dirname, '..', 'letsencrypt', 'certbot_renew.js')],
  ])('%s export uses path.dirname(), not .replace()', (_label, file) => {
    const src = fs.readFileSync(file, 'utf8');
    // Comments explain the old form by name, so only executable uses count:
    // an `await commandSafe(...)` line carrying the substitution.
    const executableReplace = src
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .filter((line) => /\.replace\(\s*['"]privkey['"]/.test(line));
    expect(executableReplace).toEqual([]);

    expect(src).toMatch(/path\.join\(path\.dirname\(cert_key_path\), 'chain\.pem'\)/);
    expect(src).toMatch(/require\("path"\)/);
  });
});
