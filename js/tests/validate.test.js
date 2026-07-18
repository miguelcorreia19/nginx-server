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
    // wildcard as the complete left-most label
    '*.example.com',
    '*.sub.example.com',
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
    ['bare wildcard', '*'],
    ['wildcard prefix with no domain', '*.'],
    ['wildcard not followed by a dot', '*example.com'],
    ['wildcard as a middle label', 'foo.*.example.com'],
    ['wildcard as the last label', 'example.*'],
    ['two wildcard labels', '*.*.example.com'],
    ['wildcard inside the left-most label', 'foo*.example.com'],
    ['wildcard inside a middle label', 'foo.*bar.example.com'],
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
    ['wildcard hostname', '*.example.com'],
    ['bare wildcard', '*'],
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

  // mode is 'custom' (rather than the implicit letsencrypt default) so this
  // exercises validateCertFilename in isolation, without also tripping the
  // separate "custom requires both filename fields" / "letsencrypt requires
  // an email" rules covered by their own describe blocks below.
  it('rejects an invalid cert_file', () => {
    expect(() => validateConfigEntry('mysite', {
      names: ['example.com'],
      mode: 'custom',
      cert_file: '../etc/passwd',
      privkey_file: 'site.key',
    })).toThrow(/cert_file/i);
  });

  it('rejects an invalid privkey_file', () => {
    expect(() => validateConfigEntry('mysite', {
      names: ['example.com'],
      mode: 'custom',
      cert_file: 'site.pem',
      privkey_file: 'key.pem; rm -rf /',
    })).toThrow(/privkey_file/i);
  });

  it('rejects names: [] (empty array)', () => {
    expect(() => validateConfigEntry('mysite', { names: [] })).toThrow();
  });
});

// ──────────────────────────────────────────────
//  validateConfigEntry — names is mandatory for every mode
// ──────────────────────────────────────────────
describe('validateConfigEntry — names is required for every mode', () => {
  // Extra fields each mode needs to satisfy its own unrelated requirements,
  // so these cases isolate the "names" check specifically.
  const extraByMode = {
    http: {},
    letsencrypt: { email: 'admin@example.com' },
    'letsencrypt-staging': { email: 'admin@example.com' },
    custom: { cert_file: 'site.pem', privkey_file: 'site.key' },
  };
  const modes = Object.keys(extraByMode);

  test.each(modes)('rejects a missing "names" field for mode "%s"', (mode) => {
    expect(() => validateConfigEntry('mysite', { mode, ...extraByMode[mode] })).toThrow(/names/i);
  });

  test.each(modes)('accepts a non-empty "names" array for mode "%s"', (mode) => {
    expect(() => validateConfigEntry('mysite', {
      mode, names: ['example.com'], ...extraByMode[mode],
    })).not.toThrow();
  });
});

// ──────────────────────────────────────────────
//  validateConfigEntry — mode
// ──────────────────────────────────────────────
describe('validateConfigEntry — mode', () => {
  it('defaults an omitted mode to letsencrypt', () => {
    expect(() => validateConfigEntry('mysite', {
      names: ['example.com'],
      email: 'admin@example.com',
    })).not.toThrow();
  });

  const explicitModes = [
    ['http', {}],
    ['letsencrypt', { email: 'admin@example.com' }],
    ['letsencrypt-staging', { email: 'admin@example.com' }],
    ['custom', { cert_file: 'site.pem', privkey_file: 'site.key' }],
  ];

  test.each(explicitModes)('accepts explicit mode "%s"', (mode, extra) => {
    expect(() => validateConfigEntry('mysite', {
      mode, names: ['example.com'], ...extra,
    })).not.toThrow();
  });

  it('rejects an unsupported mode', () => {
    expect(() => validateConfigEntry('mysite', {
      mode: 'bogus',
      names: ['example.com'],
    })).toThrow(/mode "bogus" is not supported/i);
  });

  // An explicitly supplied falsy/structural value must not be treated the
  // same as an omitted mode — only `undefined` defaults to letsencrypt.
  const explicitInvalidModes = [
    ['empty string', ''],
    ['null', null],
    ['false', false],
    ['zero', 0],
    ['array', ['letsencrypt']],
    ['object', { value: 'letsencrypt' }],
  ];

  test.each(explicitInvalidModes)('an explicitly supplied %s mode is rejected (not treated as absent)', (_label, mode) => {
    expect(() => validateConfigEntry('mysite', {
      mode,
      names: ['example.com'],
    })).toThrow();
  });
});

// ──────────────────────────────────────────────
//  validateConfigEntry — wildcard vs. mode compatibility
// ──────────────────────────────────────────────
describe('validateConfigEntry — wildcard vs. mode compatibility', () => {
  it('rejects a wildcard name with mode "letsencrypt"', () => {
    expect(() => validateConfigEntry('mysite', {
      mode: 'letsencrypt',
      names: ['*.example.com'],
      email: 'admin@example.com',
    })).toThrow(/wildcard/i);
  });

  it('rejects a wildcard name with mode "letsencrypt-staging"', () => {
    expect(() => validateConfigEntry('mysite', {
      mode: 'letsencrypt-staging',
      names: ['*.example.com'],
      email: 'admin@example.com',
    })).toThrow(/wildcard/i);
  });

  it('rejects a mix of wildcard and ordinary names under mode "letsencrypt"', () => {
    expect(() => validateConfigEntry('mysite', {
      mode: 'letsencrypt',
      names: ['example.com', '*.example.com'],
      email: 'admin@example.com',
    })).toThrow(/wildcard/i);
  });

  it('accepts a wildcard name with mode "custom"', () => {
    expect(() => validateConfigEntry('mysite', {
      mode: 'custom',
      names: ['*.example.com'],
      cert_file: 'site.pem',
      privkey_file: 'site.key',
    })).not.toThrow();
  });

  it('accepts a wildcard name with mode "http"', () => {
    expect(() => validateConfigEntry('mysite', {
      mode: 'http',
      names: ['*.example.com'],
    })).not.toThrow();
  });

  it('accepts ordinary (non-wildcard) names with mode "letsencrypt"', () => {
    expect(() => validateConfigEntry('mysite', {
      mode: 'letsencrypt',
      names: ['example.com', 'www.example.com'],
      email: 'admin@example.com',
    })).not.toThrow();
  });
});

// ──────────────────────────────────────────────
//  validateConfigEntry — custom requires both certificate filename fields
// ──────────────────────────────────────────────
describe('validateConfigEntry — custom requires both certificate filename fields', () => {
  it('rejects mode "custom" without cert_file', () => {
    expect(() => validateConfigEntry('mysite', {
      mode: 'custom',
      names: ['example.com'],
      privkey_file: 'site.key',
    })).toThrow(/cert_file/i);
  });

  it('rejects mode "custom" without privkey_file', () => {
    expect(() => validateConfigEntry('mysite', {
      mode: 'custom',
      names: ['example.com'],
      cert_file: 'site.pem',
    })).toThrow(/privkey_file/i);
  });

  it('rejects mode "custom" with neither field', () => {
    expect(() => validateConfigEntry('mysite', {
      mode: 'custom',
      names: ['example.com'],
    })).toThrow();
  });

  it('accepts mode "custom" with valid filenames for both fields', () => {
    expect(() => validateConfigEntry('mysite', {
      mode: 'custom',
      names: ['example.com'],
      cert_file: 'site.pem',
      privkey_file: 'site.key',
    })).not.toThrow();
  });
});

// ──────────────────────────────────────────────
//  validateConfigEntry — Let's Encrypt requires a usable email source
// ──────────────────────────────────────────────
describe("validateConfigEntry — Let's Encrypt requires a usable email source", () => {
  const leModes = ['letsencrypt', 'letsencrypt-staging'];

  test.each(leModes)('accepts mode "%s" with only a per-site email', (mode) => {
    expect(() => validateConfigEntry('mysite', {
      mode, names: ['example.com'], email: 'admin@example.com',
    })).not.toThrow();
  });

  test.each(leModes)('accepts mode "%s" with only a CERTBOT_EMAIL fallback', (mode) => {
    expect(() => validateConfigEntry('mysite', {
      mode, names: ['example.com'],
    }, 'fallback@example.com')).not.toThrow();
  });

  test.each(leModes)('rejects mode "%s" when neither a per-site email nor CERTBOT_EMAIL is available', (mode) => {
    expect(() => validateConfigEntry('mysite', {
      mode, names: ['example.com'],
    })).toThrow(/requires an email/i);
  });

  it('rejects an invalid CERTBOT_EMAIL fallback value (reuses the existing email validator)', () => {
    expect(() => validateConfigEntry('mysite', {
      mode: 'letsencrypt', names: ['example.com'],
    }, '$(whoami)@example.com')).toThrow(/invalid/i);
  });

  it('does not require an email for mode "http"', () => {
    expect(() => validateConfigEntry('mysite', {
      mode: 'http', names: ['example.com'],
    })).not.toThrow();
  });

  it('does not require an email for mode "custom"', () => {
    expect(() => validateConfigEntry('mysite', {
      mode: 'custom', names: ['example.com'], cert_file: 'site.pem', privkey_file: 'site.key',
    })).not.toThrow();
  });
});
