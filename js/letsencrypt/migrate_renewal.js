// Phase B — Let's Encrypt renewal-config migration (PREPARE ONLY).
//
// Goal: prepare a webroot-schema version of each legacy standalone Certbot
// renewal config so a later phase can switch renewals to webroot. This phase
// is deliberately NON-ACTIVATING:
//
//   * The live /etc/letsencrypt/renewal/*.conf are NEVER modified. They stay
//     `authenticator = standalone`, so `certbot renew` (driven by the unchanged
//     certbot_renew.sh, which frees port 80 for standalone) keeps working
//     exactly as today. Activating webroot now would break renewals, because
//     certbot_renew.sh removes the port-80 challenge handler to free the port.
//   * The migrated webroot configs are written to a separate STAGED directory,
//     which Certbot never reads (it only globs <renewal>/*.conf).
//   * A backup of each original is kept for a clean Phase-C rollback.
//
// The migration is idempotent, never throws, and never fails startup (warn and
// continue) — consistent with the rest of the project.
//
// Verified Certbot webroot renewal-config schema (Certbot 2.x/3.x):
//   [renewalparams]
//   authenticator = webroot
//   webroot_path = /var/www/certbot
// (No [[webroot_map]] is required; Certbot restores a string webroot_path into
//  a single-element list and uses it as the path for all of the cert's domains.)

const fs = require("fs");
const path = require("path");

// Bump this when the produced renewal schema changes. Independent of the
// nginx-server image/app version — it only describes the renewal config schema.
const SCHEMA_VERSION = "webroot-renewal-v1";

const WEBROOT_PATH = "/var/www/certbot";

const cfg = (overrides = {}) => ({
  renewalDir: overrides.renewalDir || process.env.CERTBOT_RENEWAL_DIR || "/etc/letsencrypt/renewal",
  stagedDir: overrides.stagedDir || process.env.CERTBOT_RENEWAL_STAGED_DIR || "/etc/letsencrypt/renewal-webroot",
  backupDir: overrides.backupDir || process.env.CERTBOT_RENEWAL_BACKUP_DIR || "/etc/letsencrypt/renewal-backup",
  markerPath: overrides.markerPath || process.env.CERTBOT_RENEWAL_MARKER || "/etc/letsencrypt/.nginx-server-renewal-schema",
});

const log = (msg) => console.log(`${new Date().toISOString()} [renewal-migration] ${msg}`);
const warn = (msg) => console.warn(`${new Date().toISOString()} [renewal-migration] ${msg}`);

// A config is "legacy standalone" if its [renewalparams] sets authenticator=standalone.
const isStandaloneConfig = (content) =>
  /^\s*authenticator\s*=\s*standalone\s*$/m.test(content);

// Transform a standalone renewal config into a webroot one, preserving every
// other line. The webroot_path is injected immediately after the authenticator
// line (so it stays inside [renewalparams]); existing webroot_path is kept.
const migrateConfigContent = (content) => {
  const hasWebrootPath = /^\s*webroot_path\s*=/m.test(content);
  let replaced = false;
  const out = content.split("\n").flatMap((line) => {
    if (!replaced && /^\s*authenticator\s*=\s*standalone\s*$/.test(line)) {
      replaced = true;
      const newAuth = line.replace("standalone", "webroot");
      return hasWebrootPath ? [newAuth] : [newAuth, `webroot_path = ${WEBROOT_PATH}`];
    }
    return [line];
  });
  return out.join("\n");
};

// Structural validation of a produced webroot config.
const validateMigratedContent = (content) => {
  if (!/^\[renewalparams\]\s*$/m.test(content)) return false;
  if (/^\s*authenticator\s*=\s*standalone\s*$/m.test(content)) return false;
  if (!/^\s*authenticator\s*=\s*webroot\s*$/m.test(content)) return false;
  const webrootRe = new RegExp(`^\\s*webroot_path\\s*=\\s*${WEBROOT_PATH.replace(/[/]/g, "\\/")}\\s*$`, "m");
  if (!webrootRe.test(content)) return false;
  return true;
};

// Copy `content` to `dest`, preserving the source file's mode and (best-effort)
// ownership so a later activation keeps the original permissions.
const writePreservingPerms = (dest, content, srcStat) => {
  fs.writeFileSync(dest, content);
  try { fs.chmodSync(dest, srcStat.mode); } catch (_) {}
  try { fs.chownSync(dest, srcStat.uid, srcStat.gid); } catch (_) {}
};

// Prepare (stage) webroot renewal configs without touching the live ones.
// Returns a summary; never throws.
const migrate = (overrides = {}) => {
  const { renewalDir, stagedDir, backupDir, markerPath } = cfg(overrides);
  const summary = { scanned: 0, migrated: 0, alreadyStaged: 0, skipped: 0, failed: 0, markerWritten: false };

  try {
    if (!fs.existsSync(renewalDir)) {
      return summary; // No Let's Encrypt certificates installed — nothing to do, quietly.
    }

    const files = fs.readdirSync(renewalDir).filter((f) => f.endsWith(".conf"));
    summary.scanned = files.length;

    const markerCurrent =
      fs.existsSync(markerPath) && fs.readFileSync(markerPath, "utf8").trim() === SCHEMA_VERSION;

    for (const file of files) {
      const live = path.join(renewalDir, file);
      const staged = path.join(stagedDir, file);
      let content;
      let stat;
      try {
        content = fs.readFileSync(live, "utf8");
        stat = fs.statSync(live);
      } catch (err) {
        warn(`Could not read renewal config "${file}" — skipping (${err.message})`);
        summary.failed++;
        continue;
      }

      if (!isStandaloneConfig(content)) {
        summary.skipped++; // already webroot / non-standalone — nothing to prepare
        continue;
      }
      if (fs.existsSync(staged)) {
        summary.alreadyStaged++; // idempotent: already prepared
        continue;
      }

      // First time we touch this one — announce it.
      log(`Found legacy standalone renewal config: ${file}`);

      let migrated;
      try {
        migrated = migrateConfigContent(content);
      } catch (err) {
        warn(`Migration of "${file}" failed to transform — skipping (${err.message})`);
        summary.failed++;
        continue;
      }

      if (!validateMigratedContent(migrated)) {
        warn(`Migration validation failed for "${file}" — leaving the live standalone config in place; skipping`);
        summary.failed++;
        continue;
      }

      try {
        fs.mkdirSync(backupDir, { recursive: true });
        fs.mkdirSync(stagedDir, { recursive: true });
        // Backup the original standalone config (deterministic, easy to restore).
        writePreservingPerms(path.join(backupDir, file), content, stat);
        // Stage the migrated webroot config (NOT read by Certbot; activated in Phase C).
        writePreservingPerms(staged, migrated, stat);
      } catch (err) {
        warn(`Could not write staged/backup files for "${file}" — skipping (${err.message})`);
        // Best effort: drop a partially-written staged file so it isn't mistaken for valid.
        try { if (fs.existsSync(staged)) fs.unlinkSync(staged); } catch (_) {}
        summary.failed++;
        continue;
      }

      log(`Migrating to webroot renewal schema (staged): ${file}`);
      summary.migrated++;
    }

    // Only record the schema marker once every standalone config is prepared,
    // so a partial run is retried on the next startup.
    if (summary.failed === 0) {
      if (!markerCurrent) {
        try {
          fs.mkdirSync(path.dirname(markerPath), { recursive: true });
          fs.writeFileSync(markerPath, `${SCHEMA_VERSION}\n`);
          summary.markerWritten = true;
        } catch (err) {
          warn(`Could not write schema marker — will retry next startup (${err.message})`);
        }
      }
    }

    if (summary.migrated > 0) {
      log(`Migration successful — ${summary.migrated} renewal config(s) staged for webroot. ` +
          `Live renewals still use standalone mode (unchanged).`);
    }
    // If there was nothing to do (already migrated / no standalone configs), stay quiet.
  } catch (err) {
    warn(`Unexpected error during renewal-config migration — continuing startup (${err.message || err})`);
  }

  return summary;
};

module.exports = migrate;
module.exports.SCHEMA_VERSION = SCHEMA_VERSION;
module.exports.WEBROOT_PATH = WEBROOT_PATH;
module.exports.isStandaloneConfig = isStandaloneConfig;
module.exports.migrateConfigContent = migrateConfigContent;
module.exports.validateMigratedContent = validateMigratedContent;
