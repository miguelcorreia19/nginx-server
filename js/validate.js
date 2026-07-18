// Input validation for all user-controlled values that flow into shell commands or file paths.
// All validators throw on invalid input so callers can abort early with a clear message.

// Cert IDs are used as --cert-name args and as filename stems (e.g. id_fullchain.pem).
const CERT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/;

// Standard hostname labels: alphanumeric, hyphens in the middle, dots as separators.
const DOMAIN_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

// A wildcard domain is an ordinary hostname (above) carrying a literal "*."
// prefix, e.g. "*.example.com". The prefix is stripped before matching rather
// than folded into DOMAIN_RE: "*" must never become a character allowed inside
// a label (so "*example.com", "foo.*.example.com" and "*.*.example.com" all
// stay invalid), and DOMAIN_RE is also used by validateIgnoreIp, which must
// keep rejecting wildcards.
const WILDCARD_PREFIX = '*.';

// Certificate filenames: basename only, no path separators or shell metacharacters.
const CERT_FILE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,253}$/;

// Basic email: sufficient to block injection without a full RFC 5321 parser.
const EMAIL_RE = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;

// 5-field cron expression (matches the existing inline regex in letsencrypt/index.js).
const CRON_RE = /^(\*|([0-9]|1[0-9]|2[0-9]|3[0-9]|4[0-9]|5[0-9])|\*\/([0-9]|1[0-9]|2[0-9]|3[0-9]|4[0-9]|5[0-9])) (\*|([0-9]|1[0-9]|2[0-3])|\*\/([0-9]|1[0-9]|2[0-3])) (\*|([1-9]|1[0-9]|2[0-9]|3[0-1])|\*\/([1-9]|1[0-9]|2[0-9]|3[0-1])) (\*|([1-9]|1[0-2])|\*\/([1-9]|1[0-2])) (\*|([0-6])|\*\/([0-6]))$/;

// Positive integer with no leading zeros, sign, decimals, or surrounding
// whitespace. Used for the Fail2ban numeric tunables (bantime/findtime/maxretry),
// which are interpolated into the generated jail.local.
const POSITIVE_INT_RE = /^[1-9][0-9]*$/;

const validateCertId = (id) => {
  if (typeof id !== 'string' || !CERT_ID_RE.test(id)) {
    throw new Error(
      `Cert ID "${id}" is invalid: use only letters, digits, dots, hyphens, underscores ` +
      `(max 63 chars, must start with alphanumeric)`
    );
  }
};

// Removes an exact leading "*." so the remainder can be validated by the
// unchanged DOMAIN_RE. Anything else is left untouched.
const stripWildcardPrefix = (domain) =>
  domain.startsWith(WILDCARD_PREFIX) ? domain.slice(WILDCARD_PREFIX.length) : domain;

// True when a domain carries the wildcard prefix accepted by validateDomain.
// Syntax only: it says nothing about whether a given SSL mode can obtain a
// certificate for that name — that capability rule belongs to each mode handler.
const isWildcardDomain = (domain) =>
  typeof domain === 'string' && domain.startsWith(WILDCARD_PREFIX);

// Accepts an ordinary hostname, optionally prefixed with "*." to wildcard the
// complete left-most label. The length limit still applies to the value as
// written, so non-wildcard input behaves exactly as before.
const validateDomain = (domain) => {
  if (typeof domain !== 'string' || domain.length > 253 || !DOMAIN_RE.test(stripWildcardPrefix(domain))) {
    throw new Error(`Domain "${domain}" is invalid: must be a valid hostname`);
  }
};

const validateCertFilename = (filename, fieldName = 'filename') => {
  if (typeof filename !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }
  if (filename.includes('/') || filename.includes('..')) {
    throw new Error(`${fieldName} "${filename}" must not contain path separators`);
  }
  if (!CERT_FILE_RE.test(filename)) {
    throw new Error(
      `${fieldName} "${filename}" is invalid: use only letters, digits, dots, hyphens, underscores`
    );
  }
};

const validateEmail = (email) => {
  if (typeof email !== 'string' || !EMAIL_RE.test(email)) {
    throw new Error(`Email "${email}" is invalid`);
  }
};

const validateCronExpression = (cron) => {
  if (typeof cron !== 'string') {
    throw new Error('Cron expression must be a string');
  }
  // Explicit guard for characters that CRON_RE's $ anchor may not catch with trailing newlines.
  if (/[\n\r;&|`$\\]/.test(cron)) {
    throw new Error(`Cron expression "${cron}" contains invalid characters`);
  }
  if (!CRON_RE.test(cron)) {
    throw new Error(`Cron expression "${cron}" is not a valid 5-field cron expression`);
  }
};

// Positive integer used for Fail2ban tunables (seconds or counts). Accepts a
// string or number; rejects zero, negatives, decimals, and any stray characters
// (whitespace, signs, injection metacharacters) — the value is written verbatim
// into jail.local, so it must be a clean integer literal.
const validatePositiveInt = (value, fieldName = 'value') => {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`${fieldName} must be a string or number`);
  }
  if (!POSITIVE_INT_RE.test(String(value))) {
    throw new Error(`${fieldName} "${value}" is invalid: must be a positive integer`);
  }
};

// A single IPv4 address or CIDR, with each octet 0–255 and an optional /0–32.
const isIpv4OrCidr = (token) => {
  const m = token.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/);
  if (!m) return false;
  for (let i = 1; i <= 4; i++) {
    if (Number(m[i]) > 255) return false;
  }
  if (m[5] !== undefined && Number(m[5]) > 32) return false;
  return true;
};

// A single IPv6 address or CIDR. Permissive on internal structure (hex groups
// and "::"), but constrained to the hex/colon alphabet plus an optional /0–128
// prefix. Injection-bearing characters are already blocked by validateIgnoreIp.
const isIpv6OrCidr = (token) => {
  const m = token.match(/^([0-9a-fA-F:]+)(?:\/(\d{1,3}))?$/);
  if (!m || !m[1].includes(':')) return false;
  if (m[2] !== undefined && Number(m[2]) > 128) return false;
  return true;
};

// Validates FAIL2BAN_IGNOREIP: a space- and/or comma-separated allowlist of
// IPs, CIDRs, or hostnames written into jail.local's `ignoreip` directive.
// Rejects characters that could break out of that line and inject arbitrary
// Fail2ban configuration, then validates every token.
const validateIgnoreIp = (value) => {
  if (typeof value !== 'string') {
    throw new Error('FAIL2BAN_IGNOREIP must be a string');
  }
  if (/[\n\r;`$\\|&<>]/.test(value)) {
    throw new Error(`FAIL2BAN_IGNOREIP "${value}" contains invalid characters`);
  }
  const tokens = value.split(/[\s,]+/).filter(Boolean);
  if (tokens.length === 0) {
    throw new Error('FAIL2BAN_IGNOREIP must contain at least one IP, CIDR, or hostname');
  }
  for (const token of tokens) {
    if (!isIpv4OrCidr(token) && !isIpv6OrCidr(token) && !DOMAIN_RE.test(token)) {
      throw new Error(`FAIL2BAN_IGNOREIP entry "${token}" is not a valid IP, CIDR, or hostname`);
    }
  }
};

// Modes supported by a config.json entry. Only an *omitted* `mode` defaults
// to 'letsencrypt' (mirrors the runtime default in js/letsencrypt/index.js).
// An explicitly supplied falsy value (e.g. "", null, false, 0) is not treated
// as absent — it must still be one of the values below, so it is rejected.
const SUPPORTED_MODES = ['http', 'letsencrypt', 'letsencrypt-staging', 'custom'];

const isEmpty = (value) => value === undefined || value === null || value === '';

// Validates all security-relevant fields of a single config.json entry, plus
// the deterministic configuration-contract rules that can be established
// before any mode handler runs: names is mandatory, mode must be one of the
// supported values, wildcard names are incompatible with the built-in
// Let's Encrypt modes, "custom" requires both certificate filename fields,
// and the Let's Encrypt modes require a usable email source. External or
// transient failures (a real Certbot/renewal/reload failure) are not this
// function's concern and keep their existing, feature-specific handling.
// Called at startup for every entry before any mode handler runs.
//
// certbotEmailFallback is the value of CERTBOT_EMAIL — the documented
// fallback email source for Let's Encrypt modes — passed in explicitly
// rather than read from process.env so this module stays free of direct
// environment access, matching its existing style.
const validateConfigEntry = (id, entry, certbotEmailFallback) => {
  validateCertId(id);

  // names is the canonical identity of every configured site — required for
  // all modes, including http, which does not currently consume it directly.
  if (!Array.isArray(entry.names) || entry.names.length === 0) {
    throw new Error(`Entry "${id}": names must be a non-empty array`);
  }
  for (const domain of entry.names) {
    validateDomain(domain);
  }

  const mode = entry.mode === undefined ? 'letsencrypt' : entry.mode;
  if (!SUPPORTED_MODES.includes(mode)) {
    throw new Error(
      `Entry "${id}": mode "${entry.mode}" is not supported (must be one of: ${SUPPORTED_MODES.join(', ')})`
    );
  }

  // Wildcard names require a DNS-01 challenge. This image's built-in Let's
  // Encrypt flow only implements http-01 (--standalone at issuance, webroot
  // at renewal) and does not support DNS-01, so a wildcard name is
  // incompatible with mode "letsencrypt"/"letsencrypt-staging". Wildcards
  // remain valid for "custom" (bring your own certificate) and "http" (no
  // certificate is issued).
  if (mode === 'letsencrypt' || mode === 'letsencrypt-staging') {
    const wildcards = entry.names.filter(isWildcardDomain);
    if (wildcards.length > 0) {
      throw new Error(
        `Entry "${id}": wildcard name(s) ${wildcards.join(', ')} are not supported by mode "${mode}" — ` +
        `wildcard certificates require a DNS-01 challenge, which this image's built-in Let's Encrypt flow ` +
        `does not implement. Use mode "custom" with your own wildcard certificate, or list each name explicitly.`
      );
    }
  }

  if (!isEmpty(entry.email)) {
    validateEmail(entry.email);
  }

  // Issuance always passes "--email <value>" to certbot; with neither a
  // per-site email nor CERTBOT_EMAIL, that argument becomes the literal
  // string "undefined" (Node stringifies a missing execFile array element
  // rather than throwing), so this is a deterministic, pre-runtime-detectable
  // misconfiguration rather than an external Certbot failure.
  if (mode === 'letsencrypt' || mode === 'letsencrypt-staging') {
    if (isEmpty(entry.email)) {
      if (isEmpty(certbotEmailFallback)) {
        throw new Error(
          `Entry "${id}": mode "${mode}" requires an email — set "email" on this entry or the CERTBOT_EMAIL environment variable`
        );
      }
      validateEmail(certbotEmailFallback);
    }
  }

  if (mode === 'custom') {
    if (entry.cert_file === undefined) {
      throw new Error(`Entry "${id}": mode "custom" requires "cert_file"`);
    }
    if (entry.privkey_file === undefined) {
      throw new Error(`Entry "${id}": mode "custom" requires "privkey_file"`);
    }
  }

  if (entry.cert_file !== undefined) {
    validateCertFilename(entry.cert_file, 'cert_file');
  }
  if (entry.privkey_file !== undefined) {
    validateCertFilename(entry.privkey_file, 'privkey_file');
  }
};

module.exports = {
  validateCertId,
  validateDomain,
  isWildcardDomain,
  validateCertFilename,
  validateEmail,
  validateCronExpression,
  validatePositiveInt,
  validateIgnoreIp,
  validateConfigEntry,
};
