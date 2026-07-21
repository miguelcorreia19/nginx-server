// Observability & logging.
//
// These tests guard the project's logging convention:
//   * Shell scripts keep their own "YYYY-MM-DD HH:MM:SS [component] message"
//     helper (intentionally left as-is — see js/logger.js / docs/architecture.md).
//   * Project-owned Node logs all go through the shared js/logger.js factory,
//     which emits "<ISO-8601 timestamp> [component] message" (with WARNING:/
//     ERROR:/Fatal: severity labels). Component tags now live in the logger
//     wiring (createLogger("<component>")) rather than inline in each message.
//   * Empty states are quiet: a handler with nothing to do logs nothing.
//   * Raw third-party output (certbot report, nginx -t, inotifywait) is left
//     untouched.
//
// Scripts/modules are checked via their source text (the same approach used by
// build-startup-assertions.test.js and environment-validation.test.js) rather
// than executed — inotifywait (reload.sh's core dependency) isn't available
// outside the Alpine runtime image, and certbot_renew.sh's behavior is already
// covered end-to-end by certbot-renew.test.js. The shared logger itself is also
// exercised behaviorally. Only operationally meaningful lines are asserted on.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const entrypointSh   = fs.readFileSync(path.join(root, 'entrypoint.sh'), 'utf8');
const reloadSh       = fs.readFileSync(path.join(root, 'reload.sh'), 'utf8');
const certbotRenewSh = fs.readFileSync(path.join(root, 'certbot_renew.sh'), 'utf8');

const TIMESTAMP_FORMAT = /date '\+%Y-%m-%d %H:%M:%S'/;

describe('shell scripts — consistent timestamped log helper', () => {
  it.each([
    ['entrypoint.sh', entrypointSh, 'entrypoint'],
    ['reload.sh', reloadSh, 'reload'],
    ['certbot_renew.sh', certbotRenewSh, 'certbot_renew'],
  ])('%s defines a log() helper that timestamps lines and tags them [%s]', (_name, source, tag) => {
    expect(source).toMatch(TIMESTAMP_FORMAT);
    expect(source).toMatch(new RegExp(`log\\(\\)\\s*\\{[^}]*\\[${tag}\\]`));
  });

  it('entrypoint.sh and reload.sh route their operational messages through log()', () => {
    // Every remaining bare `echo` in these scripts should be incidental
    // (e.g. none) — operational messages go through the timestamped helper.
    expect(entrypointSh).not.toMatch(/^\techo "/m);
    expect(reloadSh).not.toMatch(/^\t\techo "/m);
  });
});

describe('reload.sh — typo fixes and reload outcome logging', () => {
  it('no longer contains the "Realoading"/"realoaded" typos', () => {
    expect(reloadSh).not.toMatch(/Realoading/);
    expect(reloadSh).not.toMatch(/realoaded/);
  });

  it('uses the corrected "Reloading"/"reloaded" spelling', () => {
    expect(reloadSh).toMatch(/reloading nginx/i);
    expect(reloadSh).toMatch(/reloaded successfully/i);
  });

  it('distinguishes a successful reload from a failed one', () => {
    // Must check nginx -s reload's exit status rather than assuming success —
    // the original script logged "Nginx realoaded" unconditionally.
    expect(reloadSh).toMatch(/nginx -s reload\s*\n\s*RELOAD_RC=\$\?/);
    expect(reloadSh).toMatch(/if \[ "\$RELOAD_RC" -eq 0 \]/);
    expect(reloadSh).toMatch(/ERROR: nginx reload failed/);
  });
});

describe('entrypoint.sh — clear startup and fatal-failure logging', () => {
  it('logs a startup line that names the active ENVIRONMENT', () => {
    expect(entrypointSh).toMatch(/log "Starting up \(ENVIRONMENT=/);
  });

  it('logs the entrypoint.js failure as a clearly-marked fatal error', () => {
    expect(entrypointSh).toMatch(/log "Fatal: entrypoint\.js failed/);
  });

  it('logs a clear line before handing off to nginx', () => {
    expect(entrypointSh).toMatch(/log "Entrypoint script ended/);
  });
});

describe('certbot_renew.sh — unchanged Phase 5A logging (no regressions)', () => {
  // certbot_renew.sh already had a timestamped log() helper with WARNING/ERROR
  // severity labels from Phase 5A — Phase 5B intentionally left it untouched.
  it('still uses WARNING/ERROR severity labels', () => {
    expect(certbotRenewSh).toMatch(/log "WARNING:/);
    expect(certbotRenewSh).toMatch(/log "ERROR:/);
  });
});

describe('js/letsencrypt/utils.js — actionable certificate-parsing diagnostics', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'letsencrypt', 'utils.js'), 'utf8');

  it('no longer logs cryptic numbered error codes', () => {
    expect(source).not.toMatch(/ERROR 1\.\d/);
  });

  it('parsing-failure messages name the certificate id and the missing field', () => {
    const matches = source.match(/Failed to parse "certbot certificates" output for "\$\{cert_id\}": missing "\$\{[A-Z_]+\}"/g) || [];
    // One for each of: cert path, key path, domains, status, validity
    expect(matches.length).toBe(5);
  });

  it('uses clear [letsencrypt]-prefixed backup-discovery logs (no legacy trailing-dot strings)', () => {
    expect(source).not.toMatch(/Check existing backups/);
    expect(source).not.toMatch(/Found some certificates on backup path/);
    expect(source).not.toMatch(/Backup path is empty/);
    expect(source).toMatch(/Checking backup certificates\.\.\./);
    expect(source).toMatch(/Found \$\{certDirs\.length\} certificate\(s\) in backup storage/);
  });
});

describe('js/letsencrypt/index.js — consistent [letsencrypt] logging', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'letsencrypt', 'index.js'), 'utf8');

  it('routes log lines through the shared [letsencrypt] logger', () => {
    expect(source).toMatch(/createLogger\(["']letsencrypt["']\)/);
    expect(source).toMatch(/const \{ log, warn, error, fatal \} = createLogger/);
  });

  it('removes the "Certificates Status" banner blocks (no #### separators)', () => {
    expect(source).not.toMatch(/#{4,}/);
    expect(source).not.toMatch(/Certificates Status/);
    expect(source).not.toMatch(/Certificates not found!/);
  });

  it('stays quiet on the empty state (no "No certificates found" noise)', () => {
    expect(source).not.toMatch(/No certificates found/);
  });

  it('logs a concise certificate status summary with a count', () => {
    expect(source).toMatch(/Certificate status summary: \$\{ids\.length\} certificate\(s\)/);
    expect(source).toMatch(/`- \$\{id\}: \$\{status\}`/);
    expect(source).toMatch(/domains: \$\{cert_domains\.join/);
  });

  it('routes certificate creation/deletion failures through the error() helper (stderr), not console.log', () => {
    expect(source).not.toMatch(/console\.log\(`error: Certificate/);
    expect(source).toMatch(/error\(`Certificate \$\{id\} deletion failed`\)/);
    expect(source).toMatch(/error\(`Certificate \$\{id\} creation failed`\)/);
  });

  it('normalizes the legacy ALL-CAPS / "!"-terminated status messages', () => {
    expect(source).not.toMatch(/NodeJS letsencrypt terminated/);
    expect(source).not.toMatch(/Start mapping certificates/);
    expect(source).toMatch(/Let's Encrypt startup completed/);
  });
});

describe('js/letsencrypt/certbot_renew.js — clear, consistent renewal logs', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'letsencrypt', 'certbot_renew.js'), 'utf8');

  it('no longer logs the all-caps "NODEJS START RENEWAL" banner or raw toTimeString() calls', () => {
    expect(source).not.toMatch(/NODEJS START RENEWAL/);
    expect(source).not.toMatch(/toTimeString/);
  });

  it('removes the "Certificates Status" banner blocks (no #### separators)', () => {
    expect(source).not.toMatch(/#{4,}/);
    expect(source).not.toMatch(/Certificates Status/);
    expect(source).not.toMatch(/Certificates not found/);
  });

  it('routes log lines through the shared [certbot_renew.js] logger', () => {
    expect(source).toMatch(/createLogger\(["']certbot_renew\.js["']\)/);
    expect(source).toMatch(/const \{ log, warn, error \} = createLogger/);
  });

  it('logs clear start and finish boundaries (timestamp supplied by the shared logger)', () => {
    expect(source).toMatch(/log\('Starting certificate renewal'\)/);
    expect(source).toMatch(/log\('certbot renew finished'\)/);
    // The embedded per-line toISOString() is gone — the logger prefix carries it.
    expect(source).not.toMatch(/— \$\{new Date\(\)\.toISOString\(\)\}/);
  });

  it('surfaces certbot\'s own renewal report instead of discarding it', () => {
    expect(source).toMatch(/const renewOutput = await command\(\s*`certbot renew/);
    expect(source).toMatch(/if \(renewOutput\) console\.log\(renewOutput\)/);
  });

  it('logs a concise certificate status summary with a count', () => {
    expect(source).toMatch(/Certificate status summary: \$\{ids\.length\} certificate\(s\)/);
    expect(source).toMatch(/`- \$\{id\}: \$\{status\}`/);
    expect(source).toMatch(/domains: \$\{cert_domains\.join/);
    expect(source).toMatch(/validity: \$\{formatValidity\(validity\)\}/);
  });

  it('warns clearly when no certificates are found after renewal', () => {
    expect(source).toMatch(/no certificates found after renewal/);
  });

  it('logs the exported certificate paths (never key contents)', () => {
    expect(source).toMatch(/fullchain:\s+\$\{fullchainDest\}/);
    expect(source).toMatch(/privkey:\s+\$\{privkeyDest\}/);
    expect(source).toMatch(/chain:\s+\$\{chainDest\}/);
    // The script never reads certificate/key file contents — it only copies and
    // logs paths — so no key material can leak into the logs.
    expect(source).not.toMatch(/readFileSync/);
  });

  it('uses clear backup logs', () => {
    expect(source).toMatch(/Backing up Let's Encrypt state to \$\{process\.env\.CERTBOT_BACKUP_PATH\}/);
    expect(source).toMatch(/Backup completed/);
  });

  it('logs fatal errors through the logger error() helper and preserves exit(1)', () => {
    expect(source).toMatch(/error\(`certbot renewal failed: /);
    expect(source).toMatch(/process\.exit\(1\)/);
  });
});

describe('js/letsencrypt/certbot_renew.js — formatValidity (behavioral)', () => {
  const { formatValidity } = require('../letsencrypt/certbot_renew');
  const { DateTime } = require('luxon');

  it('formats a future expiry as "expires in N day(s)"', () => {
    expect(formatValidity(DateTime.now().plus({ days: 30, hours: 6 }))).toMatch(/^expires in \d+ days?$/);
  });

  it('formats a past expiry as "expired N day(s) ago"', () => {
    expect(formatValidity(DateTime.now().minus({ days: 5, hours: 6 }))).toMatch(/^expired \d+ days? ago$/);
  });

  it('returns "unknown" for an invalid or missing validity', () => {
    expect(formatValidity(DateTime.invalid('parse error'))).toBe('unknown');
    expect(formatValidity(undefined)).toBe('unknown');
    expect(formatValidity(null)).toBe('unknown');
  });
});

describe('js/letsencrypt/manage_certs.js — fallback-certificate messages without ALL-CAPS shouting', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'letsencrypt', 'manage_certs.js'), 'utf8');

  it('no longer shouts instructions in all-caps', () => {
    expect(source).not.toMatch(/YOU CAN DISABLE THIS WITH THE FLAG/);
    expect(source).not.toMatch(/Probably this will fail/);
  });

  it('explains the fallback behavior and how to control it via FORCE_INVALID_ON_FAIL', () => {
    expect(source).toMatch(/generating a self-signed fallback certificate \(set FORCE_INVALID_ON_FAIL/);
    expect(source).toMatch(/proceeding without a fallback because FORCE_INVALID_ON_FAIL is set/);
  });
});

describe('js/entrypoint.js — clear startup environment line', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'entrypoint.js'), 'utf8');

  it('logs the active ENVIRONMENT through the shared [entrypoint] logger', () => {
    expect(source).not.toMatch(/console\.log\("ENVIRONMENT", process\.env\.ENVIRONMENT/);
    expect(source).toMatch(/createLogger\(["']entrypoint["']\)/);
    expect(source).toMatch(/Starting in ENVIRONMENT=/);
  });

  it('routes fatal/warning lines through the logger fatal()/warn() helpers', () => {
    expect(source).toMatch(/fatal\("entrypoint failed/);
    expect(source).toMatch(/warn\(`Fail2ban setup failed/);
  });
});

describe('js/http/index.js — quiet empty state', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'http', 'index.js'), 'utf8');

  it('no longer logs the noisy "No HTTP certificates found in config.json" line', () => {
    expect(source).not.toMatch(/No HTTP certificates found in config\.json/);
  });

  it('no longer copies the default :80 vhost itself (production startup restores it centrally)', () => {
    expect(source).not.toMatch(/nginx\.vh\.default\.80\.conf/);
  });
});

describe('js/logger.js — shared timestamped logger (source)', () => {
  const loggerSource = fs.readFileSync(path.join(__dirname, '..', 'logger.js'), 'utf8');

  it('builds a "YYYY-MM-DD HH:mm:ss [component] message" prefix (no ISO timestamps)', () => {
    expect(loggerSource).toMatch(/const tag = `\[\$\{component\}\]`/);
    // Local-time YYYY-MM-DD HH:mm:ss assembled from Date getters — matches the
    // shell `date '+%Y-%m-%d %H:%M:%S'` helper. The old ISO formatter is gone.
    expect(loggerSource).toMatch(/getFullYear\(\)/);
    expect(loggerSource).not.toMatch(/toISOString/);
  });

  it('adds WARNING:/ERROR:/Fatal: severity labels', () => {
    expect(loggerSource).toMatch(/WARNING:/);
    expect(loggerSource).toMatch(/ERROR:/);
    expect(loggerSource).toMatch(/Fatal:/);
  });

  it('introduces no logging library, JSON logs, or colors', () => {
    expect(loggerSource).not.toMatch(/require\(['"](winston|pino|bunyan|log4js|chalk)['"]\)/);
    expect(loggerSource).not.toMatch(/JSON\.stringify/);
    expect(loggerSource).not.toMatch(/\x1b\[/); // no ANSI color escapes
  });
});

describe('js/logger.js — behavioral', () => {
  const { createLogger } = require('../logger.js');
  // Same "YYYY-MM-DD HH:mm:ss " prefix the shell scripts emit — no ISO T/Z, no
  // milliseconds, no timezone suffix. Format only; never asserts a date value.
  const TS = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} /;

  it('prefixes log lines with a "YYYY-MM-DD HH:mm:ss" timestamp and the component tag', () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    createLogger('demo').log('hello');
    const line = spy.mock.calls[0][0];
    expect(line).toMatch(TS);
    expect(line).toMatch(/ \[demo\] hello$/);
    // No ISO-8601 timestamp leaks through (no "T..Z").
    expect(line).not.toMatch(/\dT\d{2}:\d{2}:\d{2}/);
    expect(line).not.toMatch(/Z\b/);
    spy.mockRestore();
  });

  it('labels warn/error/fatal severities and routes them to the right stream', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const l = createLogger('demo');
    l.warn('careful');
    l.error('broke');
    l.fatal('dead');
    expect(warnSpy.mock.calls[0][0]).toMatch(/ \[demo\] WARNING: careful$/);
    expect(errSpy.mock.calls[0][0]).toMatch(/ \[demo\] ERROR: broke$/);
    expect(errSpy.mock.calls[1][0]).toMatch(/ \[demo\] Fatal: dead$/);
    warnSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('passes through extra console arguments (e.g. an Error for its stack)', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const err = new Error('boom');
    createLogger('demo').fatal('failed —', err);
    expect(spy.mock.calls[0][0]).toMatch(/ \[demo\] Fatal: failed —$/);
    expect(spy.mock.calls[0][1]).toBe(err);
    spy.mockRestore();
  });
});

describe('Node modules — wired to the shared timestamped logger', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Each project-owned Node logging source and the component it registers with
  // createLogger(...). The shared logger supplies the "<ISO timestamp>
  // [component]" prefix, so the tag no longer appears inline in each message.
  const cases = [
    ['entrypoint.js', 'entrypoint'],
    ['utils.js', 'nginx'],
    ['letsencrypt/index.js', 'letsencrypt'],
    ['letsencrypt/utils.js', 'letsencrypt'],
    ['letsencrypt/manage_certs.js', 'letsencrypt'],
    ['letsencrypt/migrate_renewal.js', 'renewal-migration'],
    ['letsencrypt/certbot_renew.js', 'certbot_renew.js'],
    ['fail2ban/index.js', 'fail2ban'],
    ['http/index.js', 'http'],
    ['dev/index.js', 'dev'],
    ['custom/index.js', 'custom'],
  ];

  it.each(cases)('%s registers createLogger("%s")', (rel, component) => {
    expect(read(rel)).toMatch(new RegExp(`createLogger\\((['"])${esc(component)}\\1\\)`));
  });

  it.each(cases.map(([rel]) => [rel]))('%s contains no banner/separator blocks (no #### runs)', (rel) => {
    expect(read(rel)).not.toMatch(/#{4,}/);
  });

  it.each(cases.map(([rel]) => [rel]))('%s defines no inline `[component]` log-prefix helper', (rel) => {
    // The component tag must come from the shared logger, not a per-module
    // `const log = (msg) => console.log(`[x] ...`)` definition.
    expect(read(rel)).not.toMatch(/=> console\.(log|warn|error)\(`\[/);
  });
});
