// Phase 5B — observability & logging.
//
// These tests guard the logging improvements made to the shell scripts and
// the Node mode handlers/certbot helpers: consistent timestamped log lines in
// the shell scripts, the "Realoading"/"realoaded" typo fix in reload.sh,
// clear success/failure distinction on nginx reload, and replacement of
// cryptic/inconsistent Node log messages with ones that carry real context
// (cert id, what was being parsed, etc).
//
// Scripts are checked via their source text (the same approach used by
// build-startup-assertions.test.js and environment-validation.test.js) rather
// than executed — inotifywait (reload.sh's core dependency) isn't available
// outside the Alpine runtime image, and certbot_renew.sh's behavior is already
// covered end-to-end by certbot-renew.test.js. Only operationally meaningful
// lines are asserted on, not incidental wording.

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
});

describe('js/letsencrypt/index.js — error-level messages use console.error', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'letsencrypt', 'index.js'), 'utf8');

  it('no longer logs certificate creation/deletion failures via console.log with a lowercase "error:" prefix', () => {
    expect(source).not.toMatch(/console\.log\(`error: Certificate/);
  });

  it('logs certificate creation/deletion failures via console.error', () => {
    expect(source).toMatch(/console\.error\(`Certificate \$\{id\} deletion failed`\)/);
    expect(source).toMatch(/console\.error\(`Certificate \$\{id\} creation failed`\)/);
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

  it('routes log lines through a single [certbot_renew.js]-prefixed helper', () => {
    expect(source).toMatch(/const PREFIX = '\[certbot_renew\.js\]'/);
    expect(source).toMatch(/const log = \(msg\) => console\.log\(`\$\{PREFIX\} \$\{msg\}`\)/);
  });

  it('logs ISO-8601-timestamped start and finish boundaries', () => {
    expect(source).toMatch(/Starting certificate renewal — \$\{new Date\(\)\.toISOString\(\)\}/);
    expect(source).toMatch(/certbot renew finished — \$\{new Date\(\)\.toISOString\(\)\}/);
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

  it('logs fatal errors with a clear [certbot_renew.js] ERROR prefix and preserves exit(1)', () => {
    expect(source).toMatch(/const error = \(msg\) => console\.error\(`\$\{PREFIX\} ERROR: \$\{msg\}`\)/);
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

  it('logs the active ENVIRONMENT in a labeled, readable line instead of a bare value dump', () => {
    expect(source).not.toMatch(/console\.log\("ENVIRONMENT", process\.env\.ENVIRONMENT/);
    expect(source).toMatch(/Starting in ENVIRONMENT=/);
  });
});
