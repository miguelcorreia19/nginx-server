// Tests for the optional Fail2ban config-generation module (js/fail2ban).
// Covers the feature gate, default/custom value propagation, graceful fallback
// on invalid values, and the guarantee that generation never throws (so nginx
// startup is never blocked). No Docker or network required — the module renders
// the real template and writes to a temp path.

const fs = require('fs');
const os = require('os');
const path = require('path');

const fail2ban = require('../fail2ban');

// Snapshot/restore the FAIL2BAN_* env so tests don't leak into each other.
const ENV_KEYS = [
  'FAIL2BAN_ENABLED',
  'FAIL2BAN_BANTIME',
  'FAIL2BAN_FINDTIME',
  'FAIL2BAN_MAXRETRY',
  'FAIL2BAN_IGNOREIP',
  'FAIL2BAN_JAIL_PATH',
];
let savedEnv;
let tmpDir;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fail2ban-test-'));
  process.env.FAIL2BAN_JAIL_PATH = path.join(tmpDir, 'jail.local');
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

describe('isEnabled — feature gate (disabled by default)', () => {
  it('is disabled when FAIL2BAN_ENABLED is unset', () => {
    expect(fail2ban.isEnabled()).toBe(false);
  });
  it('is disabled when FAIL2BAN_ENABLED=false', () => {
    process.env.FAIL2BAN_ENABLED = 'false';
    expect(fail2ban.isEnabled()).toBe(false);
  });
  it('is enabled only on the exact string "true"', () => {
    process.env.FAIL2BAN_ENABLED = 'true';
    expect(fail2ban.isEnabled()).toBe(true);
  });
  it('does not treat "TRUE" or "1" as enabled (no silent normalization)', () => {
    process.env.FAIL2BAN_ENABLED = 'TRUE';
    expect(fail2ban.isEnabled()).toBe(false);
    process.env.FAIL2BAN_ENABLED = '1';
    expect(fail2ban.isEnabled()).toBe(false);
  });
});

describe('buildConfig — default values', () => {
  const config = () => fail2ban.buildConfig({});

  it('uses the polling backend (pyinotify unavailable on Alpine)', () => {
    expect(config()).toMatch(/^backend = polling$/m);
  });
  it('uses the iptables-multiport ban action', () => {
    expect(config()).toMatch(/^banaction = iptables-multiport$/m);
  });
  it('applies the documented default tunables', () => {
    const c = config();
    expect(c).toMatch(/^bantime\s+= 3600$/m);
    expect(c).toMatch(/^findtime = 3600$/m);
    expect(c).toMatch(/^maxretry = 6$/m);
    expect(c).toMatch(/^ignoreip = 127\.0\.0\.1\/8 ::1$/m);
  });
  it('enables exactly the three error-log nginx jails', () => {
    const c = config();
    expect(c).toMatch(/\[nginx-http-auth\]/);
    expect(c).toMatch(/\[nginx-botsearch\]/);
    expect(c).toMatch(/\[nginx-forbidden\]/);
    // Exactly three jail sections — guards against any extra jail being added.
    expect((c.match(/^\[nginx-[a-z-]+\]$/gm) || []).length).toBe(3);
  });
  it('does not include any access-log-based jail', () => {
    const c = config();
    // Assert on jail section headers (not bare substrings), so the absence is
    // checked regardless of any prose comments.
    expect(c).not.toMatch(/^\[nginx-bad-request\]$/m);
    expect(c).not.toMatch(/^\[nginx-limit-req\]$/m);
  });
  it('all default jails read the nginx error log only', () => {
    const logpaths = config().match(/^logpath = .*$/gm) || [];
    expect(logpaths.length).toBe(3);
    for (const lp of logpaths) expect(lp).toBe('logpath = /var/log/nginx/error.log');
  });
  it('leaves no unsubstituted ${...} placeholders', () => {
    expect(config()).not.toMatch(/\$\{[A-Z_]+\}/);
  });
});

describe('buildConfig — custom valid values propagate', () => {
  it('substitutes all four tunables', () => {
    const c = fail2ban.buildConfig({
      FAIL2BAN_BANTIME: '7200',
      FAIL2BAN_FINDTIME: '600',
      FAIL2BAN_MAXRETRY: '3',
      FAIL2BAN_IGNOREIP: '10.0.0.0/8 192.168.1.1',
    });
    expect(c).toMatch(/^bantime\s+= 7200$/m);
    expect(c).toMatch(/^findtime = 600$/m);
    expect(c).toMatch(/^maxretry = 3$/m);
    expect(c).toMatch(/^ignoreip = 10\.0\.0\.0\/8 192\.168\.1\.1$/m);
  });
});

describe('buildConfig — invalid values fall back to defaults (non-fatal)', () => {
  it('falls back and warns on a non-numeric bantime', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const c = fail2ban.buildConfig({ FAIL2BAN_BANTIME: 'abc' });
    expect(c).toMatch(/^bantime\s+= 3600$/m);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('FAIL2BAN_BANTIME'));
  });
  it('falls back on a negative findtime and a zero maxretry', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const c = fail2ban.buildConfig({ FAIL2BAN_FINDTIME: '-1', FAIL2BAN_MAXRETRY: '0' });
    expect(c).toMatch(/^findtime = 3600$/m);
    expect(c).toMatch(/^maxretry = 6$/m);
  });
  it('falls back on an injection-bearing ignoreip', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const c = fail2ban.buildConfig({ FAIL2BAN_IGNOREIP: '1.2.3.4\nmaxretry = 0' });
    expect(c).toMatch(/^ignoreip = 127\.0\.0\.1\/8 ::1$/m);
    // The injected directive must not have leaked into the rendered config.
    expect(c).not.toMatch(/maxretry = 0/);
  });
});

describe('module() — unrecognized flag value warns but stays disabled', () => {
  const jailPath = () => process.env.FAIL2BAN_JAIL_PATH;

  it.each(['True', 'TRUE', '1', 'yes', 'on', 'enabled'])(
    'warns and stays disabled for FAIL2BAN_ENABLED=%p',
    async (value) => {
      process.env.FAIL2BAN_ENABLED = value;
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      await fail2ban();
      // Warns, naming the offending value and the valid settings.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`FAIL2BAN_ENABLED="${value}"`));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('not a recognized value'));
      // Semantics unchanged: anything other than exactly "true" stays disabled.
      expect(fail2ban.isEnabled()).toBe(false);
      expect(fs.existsSync(jailPath())).toBe(false);
    }
  );

  it.each([
    ['true', undefined],   // recognized → enabled, no warning
    ['false', undefined],  // recognized → disabled, no warning
    [undefined, undefined], // unset → disabled, no warning
    ['', undefined],        // empty → disabled, no warning
  ])('does not warn for recognized/empty value %p', async (value) => {
    if (value === undefined) delete process.env.FAIL2BAN_ENABLED;
    else process.env.FAIL2BAN_ENABLED = value;
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await fail2ban();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('module() — write behaviour respects the gate', () => {
  const jailPath = () => process.env.FAIL2BAN_JAIL_PATH;

  it('writes nothing when disabled (unset)', async () => {
    await fail2ban();
    expect(fs.existsSync(jailPath())).toBe(false);
  });
  it('writes nothing when FAIL2BAN_ENABLED=false', async () => {
    process.env.FAIL2BAN_ENABLED = 'false';
    await fail2ban();
    expect(fs.existsSync(jailPath())).toBe(false);
  });
  it('writes the jail config when enabled', async () => {
    process.env.FAIL2BAN_ENABLED = 'true';
    jest.spyOn(console, 'log').mockImplementation(() => {});
    await fail2ban();
    expect(fs.existsSync(jailPath())).toBe(true);
    const written = fs.readFileSync(jailPath(), 'utf8');
    expect(written).toMatch(/\[nginx-http-auth\]/);
    expect(written).toMatch(/\[nginx-botsearch\]/);
    expect(written).toMatch(/\[nginx-forbidden\]/);
    expect(written).toMatch(/^backend = polling$/m);
  });
  it('never throws even if the output path is unwritable (nginx must continue)', async () => {
    process.env.FAIL2BAN_ENABLED = 'true';
    process.env.FAIL2BAN_JAIL_PATH = '/this/path/does/not/exist/jail.local';
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(fail2ban()).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledWith(expect.stringContaining('Fail2ban configuration generation failed'));
  });
});
