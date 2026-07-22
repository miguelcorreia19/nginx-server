// Generated nginx configuration reconciliation.
//
// Runs in js/entrypoint.js after schema validation (js/validate.js) and the
// relevant filesystem preflight (js/preflight.js), and before any mode handler
// adds anything.
//
// Ownership model
// ---------------
// Startup owns /etc/nginx/conf.d/80 and /etc/nginx/conf.d/443 outright, in
// both environments. Both directories hold *only* the image's default vhosts
// plus artifacts generated at startup — users mount their own inputs elsewhere
// (site files under /home/nginx/sites, base-config overrides under
// CUSTOM_NGINX_CONFIG_FILES_PATH, certificates under CUSTOM_CERTS_PATH), so
// nothing here is user-supplied and everything here can be rebuilt.
//
// Each startup therefore clears both directories and establishes the baseline
// for the environment it is about to run, then lets the handlers add exactly
// what the *current* configuration asks for:
//
//   production   clear -> restore the default :80 and :443 vhosts
//                      -> letsencrypt() / custom() / http() add their sites
//   development  clear -> (no production defaults)
//                      -> dev() adds the development site, whose own generated
//                         fragment declares the HTTPS default_server
//
// The environments differ only in that baseline, which is why they share
// clearGeneratedDirs() but not the default-vhost restore: restoring the
// production defaults before dev() would collide with the development
// fragment's own `default_server`.
//
// This makes a same-container restart converge on the same state a freshly
// created container would produce for the current ENVIRONMENT, instead of
// inheriting whatever the previous startup left in the writable layer —
// including when ENVIRONMENT itself changed between the two startups.
//
// Deliberately NOT in scope here:
//   - /etc/nginx/conf/<id>.conf mode fragments. nginx.conf never globs that
//     directory, so a fragment is inert unless a live conf.d symlink includes
//     it by name — and clearing the conf.d directories removes exactly those
//     symlinks. It also holds image files (proxy.conf, nginx.conf, ...), so it
//     could not be cleared wholesale anyway.
//   - Certificate material under /etc/ssl/certs and /etc/letsencrypt, which is
//     inert once nothing references it.

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

// The half both environments share: empty both generated directories. Whatever
// the previous startup wrote — Let's Encrypt, staging, custom, HTTP or
// development artifacts, and the default vhosts themselves — is removed.
const clearGeneratedDirs = ({ dir80, dir443 }) => clearDir(dir80) + clearDir(dir443);

// Production baseline: cleared directories plus both default vhosts, ready for
// the letsencrypt/custom/http handlers to add the currently configured sites.
// Throws on any failure: this is deterministic local startup infrastructure,
// and a partially reset tree must never reach the mode handlers or nginx.
const reconcileProductionConfig = (overrides = {}) => {
  const { dir80, dir443, src80, src443 } = cfg(overrides);

  const removed = clearGeneratedDirs({ dir80, dir443 });

  fs.copyFileSync(src80, path.join(dir80, "nginx.vh.default.80.conf"));
  fs.copyFileSync(src443, path.join(dir443, "nginx.vh.default.443.conf"));

  log(
    `Reset generated nginx config for production: removed ${removed} artifact(s) from ` +
    `conf.d/80 and conf.d/443, restored the default :80 and :443 vhosts`
  );

  return { removed };
};

// Development baseline: cleared directories and nothing else. The production
// default vhosts are deliberately NOT restored — js/dev/index.js installs a
// fragment that declares its own `listen 443 ... default_server`, so a
// restored default :443 vhost would be a duplicate default server. dev() then
// adds the development site and its redirect.
const reconcileDevelopmentConfig = (overrides = {}) => {
  const { dir80, dir443 } = cfg(overrides);

  const removed = clearGeneratedDirs({ dir80, dir443 });

  log(
    `Reset generated nginx config for development: removed ${removed} artifact(s) from ` +
    `conf.d/80 and conf.d/443 (production default vhosts intentionally not restored)`
  );

  return { removed };
};

module.exports = { reconcileProductionConfig, reconcileDevelopmentConfig };
