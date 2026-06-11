// Input validation for all user-controlled values that flow into shell commands or file paths.
// All validators throw on invalid input so callers can abort early with a clear message.

// Cert IDs are used as --cert-name args and as filename stems (e.g. id_fullchain.pem).
const CERT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/;

// Standard hostname labels: alphanumeric, hyphens in the middle, dots as separators.
const DOMAIN_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

// Certificate filenames: basename only, no path separators or shell metacharacters.
const CERT_FILE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,253}$/;

// Basic email: sufficient to block injection without a full RFC 5321 parser.
const EMAIL_RE = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;

// 5-field cron expression (matches the existing inline regex in letsencrypt/index.js).
const CRON_RE = /^(\*|([0-9]|1[0-9]|2[0-9]|3[0-9]|4[0-9]|5[0-9])|\*\/([0-9]|1[0-9]|2[0-9]|3[0-9]|4[0-9]|5[0-9])) (\*|([0-9]|1[0-9]|2[0-3])|\*\/([0-9]|1[0-9]|2[0-3])) (\*|([1-9]|1[0-9]|2[0-9]|3[0-1])|\*\/([1-9]|1[0-9]|2[0-9]|3[0-1])) (\*|([1-9]|1[0-2])|\*\/([1-9]|1[0-2])) (\*|([0-6])|\*\/([0-6]))$/;

const validateCertId = (id) => {
  if (typeof id !== 'string' || !CERT_ID_RE.test(id)) {
    throw new Error(
      `Cert ID "${id}" is invalid: use only letters, digits, dots, hyphens, underscores ` +
      `(max 63 chars, must start with alphanumeric)`
    );
  }
};

const validateDomain = (domain) => {
  if (typeof domain !== 'string' || domain.length > 253 || !DOMAIN_RE.test(domain)) {
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

// Validates all security-relevant fields of a single config.json entry.
// Called at startup for every entry before any mode handler runs.
const validateConfigEntry = (id, entry) => {
  validateCertId(id);

  if (entry.names !== undefined) {
    if (!Array.isArray(entry.names) || entry.names.length === 0) {
      throw new Error(`Entry "${id}": names must be a non-empty array`);
    }
    for (const domain of entry.names) {
      validateDomain(domain);
    }
  }

  if (entry.email !== undefined && entry.email !== null && entry.email !== '') {
    validateEmail(entry.email);
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
  validateCertFilename,
  validateEmail,
  validateCronExpression,
  validateConfigEntry,
};
