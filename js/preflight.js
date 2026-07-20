// Filesystem preflight for startup (the fail-fast startup contract). Runs in
// js/entrypoint.js after schema validation (js/validate.js) and before any
// mode handler begins mutating certificate or nginx state:
//   - preflightEntry() — one call per config.json entry, production only
//     (letsencrypt/custom/http), after every entry has already passed
//     validateConfigEntry.
//   - preflightDev() — one call, development only, before js/dev/index.js
//     runs. dev.conf is a single, fixed, whole-container requirement, not a
//     config.json entry, so it doesn't fit preflightEntry()'s per-entry
//     mode/cert-file model — kept as its own small function instead of
//     forcing it through that shape.
//
// Kept separate from js/validate.js on purpose: that module validates
// deterministic configuration *values* (fields, hostname syntax, supported
// modes, cross-field rules) against parsed JSON alone and has no filesystem
// or environment-path concerns. This module checks that the *local
// artifacts* those values point to — the mounted site config(s), and for
// "custom" mode the certificate files — actually exist on disk. Different
// inputs (parsed JSON vs. the real filesystem), different failure class (a
// typo in config.json vs. a missing bind mount), so kept as separate,
// narrowly-scoped responsibilities rather than folded into one validator.

const fs = require("fs");

const CUSTOM_CERTS_PATH_DEFAULT = "/home/custom-certificates";

const sitePath = (id) => `/home/nginx/sites/${id}.conf`;

// Same default documented for CUSTOM_CERTS_PATH and relied on by
// js/custom/index.js / js/custom/utils.js (set as the image's Docker ENV
// default). Resolved explicitly here — rather than assuming the env var is
// always set — so preflight is correct in any execution context, not only
// inside the built image.
const customCertsPath = () => process.env.CUSTOM_CERTS_PATH || CUSTOM_CERTS_PATH_DEFAULT;

// Throws unless `filePath` exists and is a regular file (following
// symlinks, so a valid symlink to a real file passes). Never reads the
// file's contents.
const requireFile = (filePath, label) => {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} ${filePath} does not exist`);
  }
  if (!fs.statSync(filePath).isFile()) {
    throw new Error(`${label} ${filePath} exists but is not a file`);
  }
};

// Checks the local filesystem prerequisites for a single config.json entry
// that has already passed validateConfigEntry. Throws a single-line Error
// naming the site and the missing path on the first problem found.
// Effective mode mirrors validateConfigEntry (js/validate.js): only an
// omitted `mode` defaults to letsencrypt.
const preflightEntry = (id, entry) => {
  const mode = entry.mode === undefined ? 'letsencrypt' : entry.mode;

  requireFile(sitePath(id), `Entry "${id}": required site config`);

  if (mode === 'custom') {
    const dir = customCertsPath();
    requireFile(`${dir}/${entry.cert_file}`, `Entry "${id}": required certificate file`);
    requireFile(`${dir}/${entry.privkey_file}`, `Entry "${id}": required private key file`);
  }
};

const DEV_SITE_PATH = "/home/nginx/sites/dev.conf";

// Checks development mode's local filesystem prerequisite: dev.conf must
// exist before js/dev/index.js runs. Throws a single-line Error naming
// development mode and the missing path.
const preflightDev = () => {
  requireFile(DEV_SITE_PATH, 'Development mode: required site config');
};

module.exports = { preflightEntry, preflightDev, customCertsPath };
