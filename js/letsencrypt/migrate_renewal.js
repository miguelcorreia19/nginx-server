// Let's Encrypt renewal-config migration (standalone -> webroot).
//
// Two modes, sharing one verified transform:
//
//   * stage  (default; Phase B): writes the migrated webroot config to a
//            separate STAGED directory and leaves the live config untouched.
//   * apply  (Phase C activation): rewrites the live config IN PLACE (atomically)
//            to webroot, after backing up the original. This is the active path
//            now that renewals use webroot and nginx keeps port 80 during
//            renewal — so a live webroot config is safe.
//
// Both modes are idempotent (already-webroot configs are left untouched), never
// throw, and never fail startup (warn and continue). On any per-config failure
// the original config is preserved (never corrupted) and the schema marker is
// withheld so the next run retries. Renewal correctness does not depend on this
// migration succeeding: certbot_renew.sh forces webroot via an explicit
// `certbot renew --webroot -w /var/www/certbot` regardless of the stored
// authenticator — this migration just persists the webroot setting in the
// config (as required) and keeps it accurate.
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

// Migrate standalone renewal configs to webroot.
//   stage mode (default): write the migrated config to the staged dir; leave live untouched.
//   apply mode (overrides.apply === true): rewrite the live config in place (atomically).
// Returns a summary; never throws.
const migrate = (overrides = {}) => {
  const apply = overrides.apply === true;
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
        summary.skipped++; // already webroot / non-standalone — nothing to do (idempotent)
        continue;
      }
      // In stage mode, skip configs already prepared. In apply mode, idempotency
      // is automatic: a config that's already webroot is caught above.
      if (!apply && fs.existsSync(staged)) {
        summary.alreadyStaged++;
        continue;
      }

      // First time we touch this one — announce it.
      log(`Found legacy standalone renewal config: ${file}`);

      let migrated;
      try {
        migrated = migrateConfigContent(content);
      } catch (err) {
        warn(`Migration of "${file}" failed to transform — leaving the original in place; skipping (${err.message})`);
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
        // Backup the original standalone config first (deterministic, easy to restore).
        writePreservingPerms(path.join(backupDir, file), content, stat);

        if (apply) {
          // Rewrite the live config in place, atomically (write a temp sibling
          // then rename over the original) so an interrupted write can never
          // leave a torn/half-written config.
          const tmp = `${live}.migrate-tmp`;
          writePreservingPerms(tmp, migrated, stat);
          fs.renameSync(tmp, live);
        } else {
          fs.mkdirSync(stagedDir, { recursive: true });
          // Stage the migrated webroot config (NOT read by Certbot until activation).
          writePreservingPerms(staged, migrated, stat);
        }
      } catch (err) {
        warn(`Could not write ${apply ? "live" : "staged"} config for "${file}" — original preserved; skipping (${err.message})`);
        // Best effort: drop a partially-written temp/staged file.
        try { if (fs.existsSync(`${live}.migrate-tmp`)) fs.unlinkSync(`${live}.migrate-tmp`); } catch (_) {}
        try { if (!apply && fs.existsSync(staged)) fs.unlinkSync(staged); } catch (_) {}
        summary.failed++;
        continue;
      }

      log(apply
        ? `Activated webroot renewal config (in place): ${file}`
        : `Migrating to webroot renewal schema (staged): ${file}`);
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
      log(apply
        ? `Migration successful — ${summary.migrated} renewal config(s) now use webroot (live). ` +
          `nginx keeps port 80 during renewal.`
        : `Migration successful — ${summary.migrated} renewal config(s) staged for webroot. ` +
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
