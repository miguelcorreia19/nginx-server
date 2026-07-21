// Generated nginx configuration reconciliation for production startup.
//
// Runs in js/entrypoint.js on the production path only, after schema
// validation (js/validate.js) and filesystem preflight (js/preflight.js), and
// before any production mode handler (letsencrypt/custom/http) adds anything.
//
// Ownership model
// ---------------
// Production startup owns /etc/nginx/conf.d/80 and /etc/nginx/conf.d/443
// outright. Both directories hold *only* the image's default vhosts plus
// artifacts generated at startup — users mount their own inputs elsewhere
// (site files under /home/nginx/sites, base-config overrides under
// CUSTOM_NGINX_CONFIG_FILES_PATH, certificates under CUSTOM_CERTS_PATH), so
// nothing here is user-supplied and everything here can be rebuilt.
//
// So each production startup clears both directories, restores the two
// default vhosts as the baseline, and then lets the handlers add exactly the
// sites the *current* config.json asks for. The mode handlers are purely
// additive with respect to these directories; none of them cleans up after
// another (previously the Let's Encrypt handler wiped both directories on
// behalf of every mode, but only when it had at least one entry of its own —
// which left removed sites of every mode still being served after a restart
// of the same container).
//
// This makes a same-container restart converge on the same state a freshly
// created container would produce, instead of inheriting whatever the
// previous startup left in the writable layer.
//
// Deliberately NOT in scope here:
//   - /etc/nginx/conf/<id>.conf mode fragments. nginx.conf never globs that
//     directory, so a fragment is inert unless a live conf.d symlink includes
//     it by name — and clearing the conf.d directories removes exactly those
//     symlinks. It also holds image files (proxy.conf, nginx.conf, ...), so it
//     could not be cleared wholesale anyway.
//   - Certificate material under /etc/ssl/certs and /etc/letsencrypt, which is
//     inert once nothing references it.
//
// Development mode is intentionally excluded: js/dev/index.js deliberately
// removes both default vhosts because its own generated fragment declares the
// HTTPS default_server, so restoring them would conflict.

const fs = require("fs");
const path = require("path");

const { createLogger } = require("./logger.js");
const { log } = createLogger("reconcile");

// Paths are fixed in the image. The overrides argument exists so tests can
// point the whole operation at a temp tree, mirroring the same approach
// js/letsencrypt/migrate_renewal.js already uses for its renewal directories.
const cfg = (overrides = {}) => ({
  dir80: overrides.dir80 || "/etc/nginx/conf.d/80",
  dir443: overrides.dir443 || "/etc/nginx/conf.d/443",
  src80: overrides.src80 || "/home/scripts/nginx/nginx.vh.default.80.conf",
  src443: overrides.src443 || "/home/scripts/nginx/nginx.vh.default.443.conf",
});

// Removes every entry in `dir`, creating the directory if it is missing.
// Entries are enumerated with readdirSync rather than tested with existsSync:
// existsSync follows symlinks and so reports `false` for a *dangling* symlink
// left behind by a site whose source file was deleted — exactly the artifact
// that must be removed here, because nginx would otherwise fail to open it and
// abort startup. rmSync unlinks a symlink itself and never follows it.
const clearDir = (dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    return 0;
  }
  const entries = fs.readdirSync(dir);
  for (const entry of entries) {
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
  return entries.length;
};

// Clears both generated directories and restores the two default vhosts.
// Throws on any failure: this is deterministic local startup infrastructure,
// and a partially reset tree must never reach the mode handlers or nginx.
const reconcileGeneratedConfig = (overrides = {}) => {
  const { dir80, dir443, src80, src443 } = cfg(overrides);

  const removed = clearDir(dir80) + clearDir(dir443);

  fs.copyFileSync(src80, path.join(dir80, "nginx.vh.default.80.conf"));
  fs.copyFileSync(src443, path.join(dir443, "nginx.vh.default.443.conf"));

  log(
    `Reset generated nginx config: removed ${removed} artifact(s) from conf.d/80 and conf.d/443, ` +
    `restored the default :80 and :443 vhosts`
  );

  return { removed };
};

module.exports = { reconcileGeneratedConfig };
