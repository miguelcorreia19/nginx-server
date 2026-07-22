const fs = require("fs");
const { commandSafe } = require("../utils.js");
const path = require("path");
const { createLogger } = require("../logger.js");
const { fatal } = createLogger("http");

module.exports = async () => {
  const _certs = require("../config.json");

  const certs = { ..._certs };

  for (let id in certs) {
    if (certs[id].mode !== 'http') {
      delete certs[id];
    }
  }

  try {
    for (let id in certs) {
      await commandSafe('cp', [path.join(__dirname, 'templates/http-certificate.conf'), `/etc/nginx/conf/${id}.conf`]);

      // Symlink (not copy) the mounted site file, matching the live-update
      // convention every other mode gets via configFiles() in ../utils.js:
      // reload.sh watches /home/nginx/sites/ directly, so an edit there is
      // picked up on the next reload without a stale startup-time copy.
      // configFiles() itself isn't reused here — it targets conf.d/443, also
      // writes an SSL http_redirect file (not applicable to HTTP-only mode),
      // and treats a missing site file as a non-fatal skip, which would
      // silently change this mode's existing fatal-on-missing behavior.
      // `ln -sf` succeeds even when the source is missing (it creates a
      // dangling symlink), unlike the `cp` it replaces, so this existence
      // check is required to keep a missing site file fatal here. js/preflight.js
      // now also guarantees this file exists before any production handler
      // runs, so in practice this is a defensive check for the file
      // disappearing between preflight and this call — already fatal, so no
      // behavior change was needed to satisfy that.
      const sitePath = `/home/nginx/sites/${id}.conf`;
      if (!fs.existsSync(sitePath)) {
        throw new Error(`HTTP site "${id}": missing site config ${sitePath}`);
      }
      await commandSafe('ln', ['-sf', sitePath, `/etc/nginx/conf.d/80/${id}.conf`]);
    }

    // No default :80 vhost restoration here any more. Production startup
    // restores it centrally before this handler runs (reconcileProductionConfig
    // in ../reconcile.js), so it is present whether or not any HTTP site is
    // configured — it is production-global infrastructure, not an artifact this
    // mode owns. The old zero-entry branch here only ever fired when there were
    // no HTTP sites, which left it missing after a development startup had
    // removed it.
  } catch (err) {
    fatal("setup failed —", err);
    throw err;
  }
}
