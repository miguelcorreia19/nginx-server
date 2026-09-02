const { configFiles, commandSafe } = require("../utils.js");
const { createConf, checkCertFiles } = require("./utils.js");

const { createLogger } = require("../logger.js");
const { log, fatal } = createLogger("custom");

module.exports = async () => {
  const _certs = require("../config.json");

  const certs = { ..._certs };

  for (let id in certs) {
    if (certs[id].mode !== 'custom') {
      delete certs[id];
    }
  }

  try {
    for (let id in certs) {
      log(`Mapping custom certificate ${id}`);

      // js/preflight.js already guarantees cert_file/privkey_file exist
      // under CUSTOM_CERTS_PATH before any production handler runs (and
      // Step 1 validation guarantees both fields are set and safe). This is
      // a defensive check only, for either file disappearing between
      // preflight and this call — it must fail rather than silently skip
      // the site.
      if (!checkCertFiles(id, certs[id])) {
        throw new Error(
          `Certificate "${id}": cert_file/privkey_file no longer present under ${process.env.CUSTOM_CERTS_PATH} ` +
          `(present at preflight, now missing)`
        );
      }

      // `--` because commandSafe (execFile) removes the *shell*, not cp(1)'s own
      // option parsing, and nothing validates CUSTOM_CERTS_PATH — so the source
      // operand begins with whatever the operator set. Verified against this
      // image's BusyBox 1.37.0: a `-badcerts/site.pem` source answers
      // `cp: unrecognized option: b` and dumps cp's usage, which surfaced as the
      // fatal startup error in place of any message naming the certificate or
      // the path. Behind `--` the same value copies literally.
      //
      // Same guard, same reasoning, as the backup copies in
      // js/letsencrypt/utils.js and the symlink in mapCustomNginxConf. Only the
      // source needs it — the destination is built from the fixed
      // `/etc/ssl/certs/` prefix and can never lead with `-` — but `--` ends
      // option parsing for the whole operand list either way.
      await commandSafe('cp', ['--', `${process.env.CUSTOM_CERTS_PATH}/${certs[id].cert_file}`, `/etc/ssl/certs/${certs[id].cert_file}`]);
      await commandSafe('cp', ['--', `${process.env.CUSTOM_CERTS_PATH}/${certs[id].privkey_file}`, `/etc/ssl/certs/${certs[id].privkey_file}`]);

      await createConf(id, certs[id]);
      await configFiles(id, "valid", certs[id].http_redirect, certs[id].names);

      // Deliberately narrower than "configured": at this point the files have
      // been copied and the SSL fragment and site links written, but nothing has
      // asked nginx whether it can actually load them. `nginx -t` runs once for
      // the whole assembled configuration after every handler (js/entrypoint.js),
      // so malformed or mismatched material fails *after* this line — and the
      // old wording read as a success the site had not yet earned.
      log(`Custom certificate configuration generated for ${id}`);
    }
  } catch (err) {
    fatal("setup failed —", err);
    throw err;
  }
}