// Mocks must be declared before any require of the module under test.
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readdirSync: jest.fn(),
}));
jest.mock('../utils.js', () => ({
  command: jest.fn(),
}));
jest.mock('luxon', () => ({ DateTime: { fromJSDate: jest.fn(() => 'mock-validity') } }));

const fs = require('fs');
const { command } = require('../utils.js');
const { parseCerts } = require('../letsencrypt/utils.js');

const NO_CERTS_OUTPUT = 'No certificates found.';

const ENV_KEYS = ['CERTBOT_BACKUP', 'CERTBOT_BACKUP_PATH'];
const savedEnv = {};

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('parseCerts — certbot query failure propagation', () => {
  it('throws (does not return a {error, msg} sentinel) when "certbot certificates" fails', async () => {
    command.mockRejectedValueOnce({ error: 'certbot: command not found' });

    await expect(parseCerts()).rejects.toThrow(/Failed to query certbot certificates/);
  });

  it('includes the underlying command error in the thrown message', async () => {
    command.mockRejectedValueOnce({ error: 'connection refused' });

    await expect(parseCerts()).rejects.toThrow(/connection refused/);
  });
});

describe('parseCerts — backup restore logic (live dir contents)', () => {
  const setupBackupEnv = () => {
    process.env.CERTBOT_BACKUP = 'true';
    process.env.CERTBOT_BACKUP_PATH = '/backup';
  };

  it('does not inspect backups when CERTBOT_BACKUP is not set', async () => {
    command.mockResolvedValueOnce(NO_CERTS_OUTPUT);

    const result = await parseCerts(true);

    expect(fs.readdirSync).not.toHaveBeenCalled();
    expect(result).toEqual({});
  });

  // Environment values are strings, so the restore gate used to treat the
  // documented CERTBOT_BACKUP=false as enabled while the write paths treated it
  // as disabled — `false` disabled writing but still permitted restoring. All
  // the gates now share certbotBackupEnabled(), so "false" disables restore too.
  it('does not restore when CERTBOT_BACKUP is the string "false", even with a populated backup', async () => {
    process.env.CERTBOT_BACKUP = 'false';
    process.env.CERTBOT_BACKUP_PATH = '/backup';
    fs.existsSync.mockReturnValue(true);
    fs.readdirSync.mockReturnValue(['README', 'example.com']);
    command.mockResolvedValueOnce(NO_CERTS_OUTPUT);

    const result = await parseCerts(true);

    expect(fs.readdirSync).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalledWith(expect.stringContaining('cp -rf'));
    // Discovery ran exactly once — no recursive re-parse after a restore.
    expect(command).toHaveBeenCalledTimes(1);
    expect(result).toEqual({});
  });

  it('discards the backup when the live directory contains only README', async () => {
    setupBackupEnv();
    fs.existsSync.mockReturnValue(true);
    fs.readdirSync.mockReturnValue(['README']);
    command.mockResolvedValueOnce(NO_CERTS_OUTPUT);

    const result = await parseCerts(true);

    expect(command).not.toHaveBeenCalledWith(expect.stringContaining('cp -rf'));
    expect(result).toEqual({});
  });

  it('restores the backup when it contains exactly one certificate lineage alongside README (regression for dir.length > 1 bug)', async () => {
    setupBackupEnv();
    fs.existsSync.mockReturnValue(true);
    fs.readdirSync.mockReturnValue(['README', 'example.com']);
    command.mockImplementation((cmd) => {
      if (cmd === 'certbot certificates') return Promise.resolve(NO_CERTS_OUTPUT);
      return Promise.resolve();
    });

    const result = await parseCerts(true);

    expect(command).toHaveBeenCalledWith(expect.stringContaining('cp -rf /backup/* /etc/letsencrypt'));
    expect(result).toEqual({});
  });

  it('restores the backup when it contains multiple certificate lineages', async () => {
    setupBackupEnv();
    fs.existsSync.mockReturnValue(true);
    fs.readdirSync.mockReturnValue(['README', 'example.com', 'other.com']);
    command.mockImplementation((cmd) => {
      if (cmd === 'certbot certificates') return Promise.resolve(NO_CERTS_OUTPUT);
      return Promise.resolve();
    });

    const result = await parseCerts(true);

    expect(command).toHaveBeenCalledWith(expect.stringContaining('cp -rf /backup/* /etc/letsencrypt'));
    expect(result).toEqual({});
  });

  it('restores the backup even when README is absent and exactly one lineage dir exists', async () => {
    setupBackupEnv();
    fs.existsSync.mockReturnValue(true);
    fs.readdirSync.mockReturnValue(['example.com']);
    command.mockImplementation((cmd) => {
      if (cmd === 'certbot certificates') return Promise.resolve(NO_CERTS_OUTPUT);
      return Promise.resolve();
    });

    const result = await parseCerts(true);

    expect(command).toHaveBeenCalledWith(expect.stringContaining('cp -rf /backup/* /etc/letsencrypt'));
    expect(result).toEqual({});
  });

  it('discards the backup when the live directory is completely empty', async () => {
    setupBackupEnv();
    fs.existsSync.mockReturnValue(true);
    fs.readdirSync.mockReturnValue([]);
    command.mockResolvedValueOnce(NO_CERTS_OUTPUT);

    const result = await parseCerts(true);

    expect(command).not.toHaveBeenCalledWith(expect.stringContaining('cp -rf'));
    expect(result).toEqual({});
  });

  it('discards the backup when the backup path does not exist on disk', async () => {
    setupBackupEnv();
    fs.existsSync.mockReturnValue(false);
    command.mockResolvedValueOnce(NO_CERTS_OUTPUT);

    const result = await parseCerts(true);

    expect(fs.readdirSync).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalledWith(expect.stringContaining('cp -rf'));
    expect(result).toEqual({});
  });

  it('does not inspect backups when copy_files is false, even with CERTBOT_BACKUP set', async () => {
    setupBackupEnv();
    command.mockResolvedValueOnce(NO_CERTS_OUTPUT);

    const result = await parseCerts(false);

    expect(fs.existsSync).not.toHaveBeenCalled();
    expect(fs.readdirSync).not.toHaveBeenCalled();
    expect(result).toEqual({});
  });
});

// ──────────────────────────────────────────────
//  Certificate block parsing — real Certbot output
// ──────────────────────────────────────────────
//
// These exercise the real parseCerts() against output shaped like what the
// image's Certbot actually prints. The bug they exist to prevent survived
// precisely because every handler test mocks parseCerts() and hands the handler
// a ready-made object, so no test ever compared the parser to reality: Certbot
// renamed the domain field to "Identifiers:", the parser still looked for
// "Domains:", and cert_domains silently became undefined until something
// downstream called .filter() on it.
//
// The fixture below is transcribed from `certbot certificates` run against
// Certbot 5.6.0 in this project's own image (two lineages, one of them with two
// identifiers), not from what the parser expects to receive.

const certbotOutput = (label, blocks) => `
- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
Found the following certs:
${blocks.map(({ name, domains, serial }) => `  Certificate Name: ${name}
    Serial Number: ${serial}
    Key Type: RSA
    ${label} ${domains}
    Expiry Date: 2026-09-26 23:25:50+00:00 (VALID: 29 days)
    Certificate Path: /etc/letsencrypt/live/${name}/fullchain.pem
    Private Key Path: /etc/letsencrypt/live/${name}/privkey.pem`).join('\n')}
- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
`;

const EXAMPLE = { name: 'example', domains: 'example.com www.example.com', serial: '3d8b2f29c9fa34921b3037ebdb6d5a1cad080173' };
const OTHER = { name: 'other', domains: 'other.example.org', serial: '1f90126eda799af7ad67455af687c7116666a53f' };

describe('parseCerts — Certbot 5.6.0 "Identifiers:" output', () => {
  it('parses the identifier list into cert_domains', async () => {
    command.mockResolvedValueOnce(certbotOutput('Identifiers:', [EXAMPLE]));

    const result = await parseCerts();

    expect(result.example.cert_domains).toEqual(['example.com', 'www.example.com']);
  });

  it('parses every other field alongside it, unchanged', async () => {
    command.mockResolvedValueOnce(certbotOutput('Identifiers:', [EXAMPLE]));

    const result = await parseCerts();

    expect(result.example).toEqual({
      cert_path: '/etc/letsencrypt/live/example/fullchain.pem',
      cert_key_path: '/etc/letsencrypt/live/example/privkey.pem',
      cert_domains: ['example.com', 'www.example.com'],
      status: 'valid',
      validity: 'mock-validity',
    });
  });
});

describe('parseCerts — historical "Domains:" output stays supported', () => {
  it('parses the domain list from the old label', async () => {
    command.mockResolvedValueOnce(certbotOutput('Domains:', [EXAMPLE]));

    const result = await parseCerts();

    expect(result.example.cert_domains).toEqual(['example.com', 'www.example.com']);
  });

  // Fixing the current image must not break older ones, so both spellings have
  // to produce byte-identical parse results.
  it('produces identical results to the new label', async () => {
    command.mockResolvedValueOnce(certbotOutput('Identifiers:', [EXAMPLE, OTHER]));
    const fromIdentifiers = await parseCerts();

    command.mockResolvedValueOnce(certbotOutput('Domains:', [EXAMPLE, OTHER]));
    const fromDomains = await parseCerts();

    expect(fromDomains).toEqual(fromIdentifiers);
  });
});

describe('parseCerts — multiple certificate blocks', () => {
  it.each(['Identifiers:', 'Domains:'])('keeps each block\'s domains to itself (%s)', async (label) => {
    command.mockResolvedValueOnce(certbotOutput(label, [EXAMPLE, OTHER]));

    const result = await parseCerts();

    expect(Object.keys(result)).toEqual(['example', 'other']);
    expect(result.example.cert_domains).toEqual(['example.com', 'www.example.com']);
    expect(result.other.cert_domains).toEqual(['other.example.org']);
    expect(result.other.cert_path).toBe('/etc/letsencrypt/live/other/fullchain.pem');
  });
});

describe('parseCerts — indentation and separator tolerance', () => {
  it('does not depend on an exact number of spaces before the field', async () => {
    command.mockResolvedValueOnce(
      certbotOutput('Identifiers:', [EXAMPLE]).replace('    Identifiers:', '        Identifiers:')
    );

    const result = await parseCerts();

    expect(result.example.cert_domains).toEqual(['example.com', 'www.example.com']);
  });

  it('splits identifiers on any run of whitespace', async () => {
    command.mockResolvedValueOnce(
      certbotOutput('Identifiers:', [EXAMPLE]).replace('example.com www.example.com', 'example.com   www.example.com')
    );

    const result = await parseCerts();

    expect(result.example.cert_domains).toEqual(['example.com', 'www.example.com']);
  });
});

describe('parseCerts — a block with neither supported label fails at the parser', () => {
  // The whole point of the fix: an unsupported output format must surface as a
  // clear parser error, never as an undefined field that becomes a TypeError in
  // checkCertFiles() several steps later.
  const withoutDomainField = (blocks = [{ ...EXAMPLE, name: 'broken' }]) =>
    certbotOutput('Identifiers:', blocks).replace(/^ *Identifiers:.*$/m, '    Key Usage: Digital Signature');

  it('rejects, naming the affected certificate', async () => {
    command.mockResolvedValueOnce(withoutDomainField());

    await expect(parseCerts()).rejects.toThrow(/broken/);
  });

  it('says which labels it looked for', async () => {
    command.mockResolvedValueOnce(withoutDomainField());

    await expect(parseCerts()).rejects.toThrow(/"Identifiers:" or "Domains:"/);
  });

  it('is a parser error, not a downstream TypeError', async () => {
    command.mockResolvedValueOnce(withoutDomainField());

    await expect(parseCerts()).rejects.toThrow(/Failed to parse "certbot certificates" output/);

    command.mockResolvedValueOnce(withoutDomainField());
    await expect(parseCerts()).rejects.not.toBeInstanceOf(TypeError);
  });

  // Field lookups scan forward from the start of the block, so an unbounded
  // search would let a block missing the field adopt the *next* certificate's
  // identifiers — a wrong domain list is worse than a detected failure, because
  // checkCertFiles() would act on it and needlessly recreate the certificate.
  it('does not inherit the following block\'s identifiers', async () => {
    command.mockResolvedValueOnce(withoutDomainField([{ ...EXAMPLE, name: 'broken' }, OTHER]));

    await expect(parseCerts()).rejects.toThrow(/broken/);
  });
});

describe('parseCerts — cert_domains is always usable on a successful parse', () => {
  it.each(['Identifiers:', 'Domains:'])('returns an array for every entry (%s)', async (label) => {
    command.mockResolvedValueOnce(certbotOutput(label, [EXAMPLE, OTHER]));

    const result = await parseCerts();

    for (const [id, cert] of Object.entries(result)) {
      expect(Array.isArray(cert.cert_domains)).toBe(true);
      expect(cert.cert_domains.length).toBeGreaterThan(0);
      // The exact operation that used to throw once cert_domains was undefined.
      expect(() => cert.cert_domains.filter((c) => c === id)).not.toThrow();
    }
  });
});
