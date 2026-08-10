// Mocks must be declared before any require of the module under test.
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readdirSync: jest.fn(),
}));
jest.mock('../utils.js', () => ({
  command: jest.fn(),
  // The backup copy lives on commandSafe now, so "discovery copies nothing"
  // has to be asserted against this helper too, not just the shell one.
  commandSafe: jest.fn(),
}));
jest.mock('luxon', () => ({ DateTime: { fromJSDate: jest.fn(() => 'mock-validity') } }));

const fs = require('fs');
const { command, commandSafe } = require('../utils.js');
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

// The nine tests that used to live here exercised parseCerts(true): a bulk
// copy of the whole backup over /etc/letsencrypt whenever Certbot reported no
// certificates at all. That path is gone — recovery is now per-lineage, from a
// backup validated in isolation (validate_backup.js) and installed by a
// crash-safe transaction. What remains worth pinning is the invariant that
// replaced it: discovery reads, and only reads.
describe('parseCerts — discovery is pure', () => {
  it('never touches the backup, even when one is configured and populated', async () => {
    process.env.CERTBOT_BACKUP = 'true';
    process.env.CERTBOT_BACKUP_PATH = '/backup';
    fs.existsSync.mockReturnValue(true);
    fs.readdirSync.mockReturnValue(['README', 'example.com']);
    command.mockResolvedValueOnce(NO_CERTS_OUTPUT);

    const result = await parseCerts();

    expect(fs.existsSync).not.toHaveBeenCalled();
    expect(fs.readdirSync).not.toHaveBeenCalled();
    expect(result).toEqual({});
  });

  it('runs exactly one command and copies nothing', async () => {
    process.env.CERTBOT_BACKUP = 'true';
    process.env.CERTBOT_BACKUP_PATH = '/backup';
    fs.existsSync.mockReturnValue(true);
    fs.readdirSync.mockReturnValue(['example.com']);
    command.mockResolvedValueOnce(NO_CERTS_OUTPUT);

    await parseCerts();

    expect(command).toHaveBeenCalledTimes(1);
    expect(command).toHaveBeenCalledWith('certbot certificates');
    expect(command).not.toHaveBeenCalledWith(expect.stringContaining('cp -rf'));
    // No copy on either helper: the bulk backup write moved from a shell glob
    // to per-entry execFile calls, and discovery must issue neither.
    expect(commandSafe).not.toHaveBeenCalled();
  });

  it('takes no arguments — there is no restore mode left to ask for', () => {
    expect(parseCerts.length).toBe(0);
  });
});

// ──────────────────────────────────────────────
//  Certificate block parsing — Certbot 5.6 output
// ──────────────────────────────────────────────
//
// The image pins certbot=5.6.0-r0 (see Dockerfile), so there is exactly one
// supported `certbot certificates` output format and these exercise the real
// parseCerts() against it.
//
// They exist because the parser previously went untested against reality:
// every handler test mocks parseCerts() and hands the handler a ready-made
// object, so when Certbot renamed the domain field to "Identifiers:" nothing
// noticed that the parser still looked for the older "Domains:" — cert_domains
// silently became undefined until something downstream called .filter() on it.
//
// The fixture is transcribed from `certbot certificates` run against Certbot
// 5.6.0 in this project's own image (two lineages, one of them with two
// identifiers), not from what the parser expects to receive.

const certbotOutput = (blocks) => `
- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
Found the following certs:
${blocks.map(({ name, identifiers, serial }) => `  Certificate Name: ${name}
    Serial Number: ${serial}
    Key Type: RSA
    Identifiers: ${identifiers}
    Expiry Date: 2026-09-26 23:25:50+00:00 (VALID: 29 days)
    Certificate Path: /etc/letsencrypt/live/${name}/fullchain.pem
    Private Key Path: /etc/letsencrypt/live/${name}/privkey.pem`).join('\n')}
- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
`;

const EXAMPLE = { name: 'example', identifiers: 'example.com www.example.com', serial: '3d8b2f29c9fa34921b3037ebdb6d5a1cad080173' };
const OTHER = { name: 'other', identifiers: 'other.example.org', serial: '1f90126eda799af7ad67455af687c7116666a53f' };

// Strips the identifier field from the first block only.
const withoutIdentifiers = (blocks) =>
  certbotOutput(blocks).replace(/^ *Identifiers:.*$/m, '    Key Usage: Digital Signature');

describe('parseCerts — Certbot 5.6 "Identifiers:" output', () => {
  it('parses the identifier list into cert_domains', async () => {
    command.mockResolvedValueOnce(certbotOutput([EXAMPLE]));

    const result = await parseCerts();

    expect(result.example.cert_domains).toEqual(['example.com', 'www.example.com']);
  });

  it('parses every other field alongside it', async () => {
    command.mockResolvedValueOnce(certbotOutput([EXAMPLE]));

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

describe('parseCerts — multiple certificate blocks', () => {
  it('keeps each block\'s identifiers to itself', async () => {
    command.mockResolvedValueOnce(certbotOutput([EXAMPLE, OTHER]));

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
      certbotOutput([EXAMPLE]).replace('    Identifiers:', '        Identifiers:')
    );

    const result = await parseCerts();

    expect(result.example.cert_domains).toEqual(['example.com', 'www.example.com']);
  });

  it('splits identifiers on any run of whitespace', async () => {
    command.mockResolvedValueOnce(
      certbotOutput([EXAMPLE]).replace('example.com www.example.com', 'example.com   www.example.com')
    );

    const result = await parseCerts();

    expect(result.example.cert_domains).toEqual(['example.com', 'www.example.com']);
  });
});

describe('parseCerts — a block without "Identifiers:" fails at the parser', () => {
  // Unsupported output must surface as a clear parser error, never as an
  // undefined field that becomes a TypeError in checkCertFiles() several steps
  // later.
  it('rejects, naming the affected certificate', async () => {
    command.mockResolvedValueOnce(withoutIdentifiers([{ ...EXAMPLE, name: 'broken' }]));

    await expect(parseCerts()).rejects.toThrow(/broken/);
  });

  it('says which field it looked for', async () => {
    command.mockResolvedValueOnce(withoutIdentifiers([{ ...EXAMPLE, name: 'broken' }]));

    await expect(parseCerts()).rejects.toThrow(/no "Identifiers:" field/);
  });

  it('is a parser error, not a downstream TypeError', async () => {
    command.mockResolvedValueOnce(withoutIdentifiers([{ ...EXAMPLE, name: 'broken' }]));
    await expect(parseCerts()).rejects.toThrow(/Failed to parse "certbot certificates" output/);

    command.mockResolvedValueOnce(withoutIdentifiers([{ ...EXAMPLE, name: 'broken' }]));
    await expect(parseCerts()).rejects.not.toBeInstanceOf(TypeError);
  });

  // Field lookups scan forward from the start of the block, so an unbounded
  // search would let a block missing the field adopt the *next* certificate's
  // identifiers — a wrong domain list is worse than a detected failure, because
  // checkCertFiles() would act on it and needlessly recreate the certificate.
  it('does not inherit the following block\'s identifiers', async () => {
    command.mockResolvedValueOnce(withoutIdentifiers([{ ...EXAMPLE, name: 'broken' }, OTHER]));

    await expect(parseCerts()).rejects.toThrow(/broken/);
  });
});

describe('parseCerts — the supported Certbot version is a contract, not a guess', () => {
  // Pre-5.6 Certbot labelled this field "Domains:". The image pins
  // certbot=5.6.0-r0, so that output is out of contract: it must fail visibly
  // at the parser rather than be quietly accommodated. This is the deliberate
  // reversal of the temporary dual-label compatibility.
  it('rejects pre-5.6 "Domains:" output instead of accepting it', async () => {
    const legacy = certbotOutput([EXAMPLE]).replace('Identifiers:', 'Domains:');

    command.mockResolvedValueOnce(legacy);

    await expect(parseCerts()).rejects.toThrow(/no "Identifiers:" field/);
  });
});

describe('parseCerts — cert_domains is always usable on a successful parse', () => {
  it('returns a populated array for every entry', async () => {
    command.mockResolvedValueOnce(certbotOutput([EXAMPLE, OTHER]));

    const result = await parseCerts();

    for (const [id, cert] of Object.entries(result)) {
      expect(Array.isArray(cert.cert_domains)).toBe(true);
      expect(cert.cert_domains.length).toBeGreaterThan(0);
      // The exact operation that used to throw once cert_domains was undefined.
      expect(() => cert.cert_domains.filter((c) => c === id)).not.toThrow();
    }
  });
});

// ──────────────────────────────────────────────
//  The parser as a standalone function
// ──────────────────────────────────────────────
//
// parseCerts() delegates its block scraping to this pure function so the
// sandbox backup validator can reuse the one parser instead of growing a second
// reading of the same Certbot output. The tests above already pin the behaviour
// through parseCerts(); these pin the extracted function directly, since it is
// now a shared surface.
describe('parseCertbotCertificatesOutput — the shared parser', () => {
  const { parseCertbotCertificatesOutput, certbotReportedNoCertificates } =
    require('../letsencrypt/utils.js');

  it('parses without executing anything', () => {
    const result = parseCertbotCertificatesOutput(certbotOutput([EXAMPLE, OTHER]));

    expect(Object.keys(result)).toEqual(['example', 'other']);
    expect(result.example.cert_domains).toEqual(['example.com', 'www.example.com']);
    expect(result.other.cert_domains).toEqual(['other.example.org']);
    expect(command).not.toHaveBeenCalled();
  });

  it('keeps the strict Identifiers: contract', () => {
    const legacy = certbotOutput([EXAMPLE]).replace('Identifiers:', 'Domains:');

    expect(() => parseCertbotCertificatesOutput(legacy)).toThrow(/no "Identifiers:" field/);
  });

  it('keeps the block-bounded lookup', () => {
    const broken = certbotOutput([{ ...EXAMPLE, name: 'broken' }, OTHER])
      .replace(/^ *Identifiers:.*$/m, '    Key Usage: Digital Signature');

    expect(() => parseCertbotCertificatesOutput(broken)).toThrow(/broken/);
  });

  it('recognises the no-certificates report separately', () => {
    expect(certbotReportedNoCertificates('No certificates found.')).toBe(true);
    expect(certbotReportedNoCertificates(certbotOutput([EXAMPLE]))).toBe(false);
  });
});
