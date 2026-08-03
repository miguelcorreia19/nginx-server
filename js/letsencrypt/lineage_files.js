// Filesystem rules shared by the two lineage transactions.
//
// Both installing a backup over an existing lineage (restore_lineage.js) and
// installing one into an empty slot (bootstrap_lineage.js) need the same three
// answers: where a lineage's files canonically live, whether a backup's renewal
// config actually names those locations, and how to copy a lineage without
// damaging its symlinks. Those live here so the two transactions cannot drift
// apart on them — their *state machines* stay separate on purpose.

const fs = require("fs");
const path = require("path");

const LETSENCRYPT_DIR = "/etc/letsencrypt";

// The renewal-config keys whose values are absolute paths into the Certbot tree.
const PATH_KEYS = ['archive_dir', 'cert', 'privkey', 'chain', 'fullchain'];
const PATH_LINE = new RegExp(`^\\s*(${PATH_KEYS.join('|')})\\s*=\\s*(.*)$`);

const canonicalPathsFor = (id, root) => ({
  archive_dir: path.join(root, 'archive', id),
  cert: path.join(root, 'live', id, 'cert.pem'),
  privkey: path.join(root, 'live', id, 'privkey.pem'),
  chain: path.join(root, 'live', id, 'chain.pem'),
  fullchain: path.join(root, 'live', id, 'fullchain.pem'),
});

// Every path-valued key in a backup's renewal config must already name this
// lineage's canonical location. A backup produced some other way can carry
// paths into a temp dir or another cert-name, and installing it byte-for-byte
// would put a config pointing outside the tree into service. Checked without
// ever writing to the backup.
const checkCanonicalPaths = (content, id, root) => {
  const expected = canonicalPathsFor(id, root);
  const seen = new Set();
  for (const line of content.split('\n')) {
    const match = line.match(PATH_LINE);
    if (!match) continue;
    const [, key, value] = match;
    seen.add(key);
    if (value.trim() !== expected[key]) {
      return { ok: false, detail: `${key} = ${value.trim()} (expected ${expected[key]})` };
    }
  }
  const missing = PATH_KEYS.filter((key) => !seen.has(key));
  return missing.length > 0
    ? { ok: false, detail: `missing ${missing.join(', ')}` }
    : { ok: true };
};

// `verbatimSymlinks` is required, not cosmetic: without it Node rewrites
// live/<id>'s relative links into absolute paths pointing back at the source,
// so an installed lineage would reference the backup mount instead of its own
// archive.
const copyTree = (from, to) => fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });

// existsSync follows symlinks, so a dangling link would read as absent; lstat
// answers "is there an entry here at all", which is what these transactions ask.
const exists = (p) => fs.existsSync(p) || fs.lstatSync(p, { throwIfNoEntry: false }) !== undefined;

const removeIfPresent = (p) => fs.rmSync(p, { recursive: true, force: true });

module.exports = {
  LETSENCRYPT_DIR,
  PATH_KEYS,
  canonicalPathsFor,
  checkCanonicalPaths,
  copyTree,
  exists,
  removeIfPresent,
};
