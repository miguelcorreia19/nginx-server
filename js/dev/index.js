const { configFiles, command, commandSafe } = require("../utils.js");
const path = require('path');
const { createLogger } = require("../logger.js");
const { fatal } = createLogger("dev");

module.exports = async () => {

  try {
    // No default-vhost removal here any more. Development startup clears both
    // /etc/nginx/conf.d/{80,443} before this handler runs and restores no
    // production defaults (reconcileDevelopmentConfig in ../reconcile.js), so
    // there is nothing left to delete — and that reset also removes any
    // production site links and redirects a previous startup of this container
    // left behind. This handler is purely additive.
    await command(`openssl req -x509 -newkey rsa:2048 -keyout /etc/ssl/certs/priv_dev.key -out /etc/ssl/certs/cert_dev.crt -days 365 -nodes -subj \"/C=UA\" 2>&1`);

    // execFile, matching how js/http/index.js already copies its own template:
    // the source is a __dirname-derived path, so a deployment/checkout
    // directory containing a space (or any shell metacharacter) would break a
    // shell string. `cp` writes nothing on success, so the outcome is unchanged.
    //
    // No `--` here, unlike the copies in js/letsencrypt/utils.js: neither
    // operand can lead with `-`. `__dirname` is always absolute for a CommonJS
    // module, so path.join() returns a path starting with `/`, and the
    // destination is a fixed literal. Nothing operator-supplied reaches this
    // argument vector.
    await commandSafe('cp', [path.join(__dirname, 'templates/ssl-dev-certificate.conf'), '/etc/nginx/conf/dev.conf']);

    // /home/nginx/sites/dev.conf is required and already confirmed to exist
    // by js/entrypoint.js's development preflight (preflightDev() in
    // js/preflight.js) before this handler ever runs. configFiles() below
    // still defensively re-checks it (js/utils.js) — protection against the
    // file disappearing between preflight and this call — and that check is
    // fatal, not a silent skip.
    await configFiles("dev", "valid", true, ["localhost", "127.0.0.1"]);

  } catch (err) {
    fatal("setup failed —", err);
    throw err;
  }
}

