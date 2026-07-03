const {
  validateCertId,
  validateDomain,
  validateCertFilename,
  validateEmail,
  validateCronExpression,
  validatePositiveInt,
  validateIgnoreIp,
  validateConfigEntry,
} = require('../validate.js');

// ──────────────────────────────────────────────
//  validateCertId
// ──────────────────────────────────────────────
describe('validateCertId', () => {
  const valid = ['mysite', 'my-site', 'my.site', 'my_site', 'abc123', 'a', 'Site-01.prod'];
  const invalid = [
    ['empty string', ''],
    ['shell semicolon', 'my;site'],
    ['shell ampersand', 'my&&site'],
    ['shell pipe', 'my|site'],
    ['shell dollar', 'my$site'],
    ['shell backtick', 'my`site'],
    ['space', 'my site'],
    ['path traversal', '../site'],
    ['slash', 'my/site'],
    ['angle bracket', 'my<site'],
    ['newline', 'my\nsite'],
    ['starts with hyphen', '-mysite'],
  ];

  test.each(valid)('accepts "%s"', (id) => {
    expect(() => validateCertId(id)).not.toThrow();
  });

  test.each(invalid)('%s is rejected', (_label, id) => {
    expect(() => validateCertId(id)).toThrow();
  });
});

// ──────────────────────────────────────────────
//  validateDomain
// ──────────────────────────────────────────────
describe('validateDomain', () => {
  const valid = [
    'example.com',
    'www.example.com',
    'sub.domain.co.uk',
    'abc.def.ghi.com',
    'example123.com',
    'my-domain.net',
    'localhost',
    '192.168.1.1',
    'a',
  ];
  const invalid = [
    ['shell injection', 'example.com; rm -rf /'],
    ['dollar expansion', '$(whoami).com'],
    ['pipe', 'example.com|whoami'],
    ['space', 'example com'],
    ['starts with hyphen', '-example.com'],
    ['trailing dot', 'example.com.'],
    ['empty string', ''],
    ['newline', 'example.com\nwhoami'],
  ];

  test.each(valid)('accepts "%s"', (domain) => {
    expect(() => validateDomain(domain)).not.toThrow();
  });

  test.each(invalid)('%s is rejected', (_label, domain) => {
    expect(() => validateDomain(domain)).toThrow();
  });
});

// ──────────────────────────────────────────────
//  validateCertFilename
// ──────────────────────────────────────────────
describe('validateCertFilename', () => {
  const valid = ['cert.pem', 'site.crt', 'my-cert.key', 'my_cert.pem', 'site123.pem', 'a.pem'];
  const invalid = [
    ['path traversal with dots', '../cert.pem'],
    ['path separator', 'path/cert.pem'],
    ['shell semicolon', 'cert.pem; rm -rf /'],
    ['shell dollar', '$(cmd).pem'],
    ['shell ampersand', 'cert.pem && cat /etc/passwd'],
    ['shell pipe', 'cert.pem|whoami'],
    ['newline', 'cert.pem\nwhoami'],
    ['starts with hyphen', '-cert.pem'],
    ['empty string', ''],
  ];

  test.each(valid)('accepts "%s"', (filename) => {
    expect(() => validateCertFilename(filename)).not.toThrow();
  });

  test.each(invalid)('%s is rejected', (_label, filename) => {
    expect(() => validateCertFilename(filename)).toThrow();
  });

  it('rejects strings containing ".."', () => {
    expect(() => validateCertFilename('cert..pem')).toThrow();
  });
});

// ──────────────────────────────────────────────
//  validateEmail
// ──────────────────────────────────────────────
describe('validateEmail', () => {
  const valid = [
    'admin@example.com',
    'user.name+tag@domain.co.uk',
    'test@subdomain.example.org',
  ];
  const invalid = [
    ['shell injection', 'admin@example.com; rm -rf /'],
    ['dollar expansion', '$(whoami)@example.com'],
    ['pipe', 'admin@example.com|cat /etc/passwd'],
    ['no at sign', 'not-an-email'],
    ['space in domain', 'admin@ example.com'],
    ['empty string', ''],
    ['newline', 'admin@example.com\nwhoami'],
  ];

  test.each(valid)('accepts "%s"', (email) => {
    expect(() => validateEmail(email)).not.toThrow();
  });

  test.each(invalid)('%s is rejected', (_label, email) => {
    expect(() => validateEmail(email)).toThrow();
  });
});

// ──────────────────────────────────────────────
//  validateCronExpression
// ──────────────────────────────────────────────
describe('validateCronExpression', () => {
  const valid = ['0 5 * * *', '*/5 * * * *', '0 2 1 * 0', '30 12 * */2 *'];
  const invalid = [
    ['newline injection', '0 5 * * *\n malicious'],
    ['shell semicolon', '0 5 * * *; cat /etc/passwd'],
    ['shell pipe', '0 5 * * *| whoami'],
    ['shell dollar', '0 5 * * *$HOME'],
    ['backtick', '0 5 * * *`whoami`'],
    ['not a cron', 'not a cron'],
    ['empty string', ''],
    ['six fields', '0 5 * * * extra'],
  ];

  test.each(valid)('accepts "%s"', (cron) => {
    expect(() => validateCronExpression(cron)).not.toThrow();
  });

  test.each(invalid)('%s is rejected', (_label, cron) => {
    expect(() => validateCronExpression(cron)).toThrow();
  });
});

// ──────────────────────────────────────────────
//  validatePositiveInt  (FAIL2BAN_BANTIME / FINDTIME / MAXRETRY)
// ──────────────────────────────────────────────
describe('validatePositiveInt', () => {
  const valid = ['1', '6', '3600', '604800', 60, 6];
  const invalid = [
    ['zero', '0'],
    ['negative', '-1'],
    ['decimal', '1.5'],
    ['non-numeric', 'abc'],
    ['empty string', ''],
    ['leading zero', '01'],
    ['trailing space', '60 '],
    ['leading space', ' 60'],
    ['shell injection', '60; rm -rf /'],
    ['newline', '60\n0'],
    ['plus sign', '+60'],
    ['boolean', true],
    ['null', null],
  ];

  test.each(valid)('accepts %p', (value) => {
    expect(() => validatePositiveInt(value)).not.toThrow();
  });

  test.each(invalid)('%s is rejected', (_label, value) => {
    expect(() => validatePositiveInt(value)).toThrow();
  });
});

// ──────────────────────────────────────────────
//  validateIgnoreIp  (FAIL2BAN_IGNOREIP)
// ──────────────────────────────────────────────
describe('validateIgnoreIp', () => {
  const valid = [
    '127.0.0.1/8 ::1',
    '127.0.0.1',
    '10.0.0.0/8',
    '192.168.1.1, 10.0.0.1',
    '::1',
    'fe80::/10',
    'trusted.example.com',
    '192.168.0.0/16 172.16.0.0/12 10.0.0.0/8',
  ];
  const invalid = [
    ['empty string', ''],
    ['whitespace only', '   '],
    ['newline injection', '1.2.3.4\nmaxretry = 0'],
    ['carriage return', '1.2.3.4\rmaxretry = 0'],
    ['semicolon', '1.2.3.4; rm -rf /'],
    ['backtick', '1.2.3.4`whoami`'],
    ['dollar', '1.2.3.4$HOME'],
    ['pipe', '1.2.3.4|whoami'],
    ['cidr prefix too large', '10.0.0.0/33'],
    ['ipv6 cidr prefix too large', '::1/129'],
    ['underscore in host', 'bad_host'],
    ['leading-hyphen label', '-badhost'],
    ['trailing dot', '192.168.1.1.'],
    ['non-string', 12345],
  ];

  test.each(valid)('accepts "%s"', (value) => {
    expect(() => validateIgnoreIp(value)).not.toThrow();
  });

  test.each(invalid)('%s is rejected', (_label, value) => {
    expect(() => validateIgnoreIp(value)).toThrow();
  });
});

// ──────────────────────────────────────────────
//  validateConfigEntry
// ──────────────────────────────────────────────
describe('validateConfigEntry', () => {
  it('accepts a full valid letsencrypt entry', () => {
    expect(() => validateConfigEntry('mysite', {
      names: ['example.com', 'www.example.com'],
      email: 'admin@example.com',
      mode: 'letsencrypt',
    })).not.toThrow();
  });

  it('accepts a custom-cert entry with cert filenames', () => {
    expect(() => validateConfigEntry('mysite', {
      names: ['example.com'],
      cert_file: 'site.pem',
      privkey_file: 'site.key',
      mode: 'custom',
    })).not.toThrow();
  });

  it('accepts an HTTP-only entry without names', () => {
    expect(() => validateConfigEntry('mysite', { mode: 'http' })).not.toThrow();
  });

  it('rejects an invalid cert ID', () => {
    expect(() => validateConfigEntry('my;site', { names: ['example.com'] })).toThrow(/invalid/i);
  });

  it('rejects an invalid domain name', () => {
    expect(() => validateConfigEntry('mysite', {
      names: ['example.com; rm -rf /'],
    })).toThrow();
  });

  it('rejects an invalid email', () => {
    expect(() => validateConfigEntry('mysite', {
      names: ['example.com'],
      email: '$(whoami)@example.com',
    })).toThrow();
  });

  it('rejects an invalid cert_file', () => {
    expect(() => validateConfigEntry('mysite', {
      names: ['example.com'],
      cert_file: '../etc/passwd',
    })).toThrow();
  });

  it('rejects an invalid privkey_file', () => {
    expect(() => validateConfigEntry('mysite', {
      names: ['example.com'],
      privkey_file: 'key.pem; rm -rf /',
    })).toThrow();
  });

  it('rejects names: [] (empty array)', () => {
    expect(() => validateConfigEntry('mysite', { names: [] })).toThrow();
  });
});
