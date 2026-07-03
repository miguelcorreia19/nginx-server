// Optional Fail2ban configuration generation.
//
// This module mirrors the other mode-handler modules (letsencrypt/, dev/, ...):
// it renders a config file from a template under templates/. It is orthogonal to
// ENVIRONMENT and self-gates on FAIL2BAN_ENABLED, so entrypoint.js can call it
// unconditionally — it is a no-op unless the feature is explicitly enabled.
//
// Invalid FAIL2BAN_* values do not abort startup: each is validated and, on
// failure, falls back to its default with a warning — the same graceful pattern
// used for CERTBOT_RENEW_CRONJOB in letsencrypt/index.js. Fail2ban is protective,
// never load-bearing, so it must never prevent nginx from starting.

const fs = require("fs");
const path = require("path");
const { validatePositiveInt, validateIgnoreIp } = require("../validate.js");

// Defaults documented in the README. Strings so they substitute verbatim.
const DEFAULTS = {
  bantime: "3600",
  findtime: "3600",
  maxretry: "6",
  ignoreip: "127.0.0.1/8 ::1",
};

const TEMPLATE_PATH = path.join(__dirname, "templates/jail.local");

// Real Fail2ban location; overridable so tests can write to a temp path.
const jailOutputPath = () => process.env.FAIL2BAN_JAIL_PATH || "/etc/fail2ban/jail.local";

// Enabled only on the exact string "true": unset and "false" both mean disabled.
const isEnabled = () => process.env.FAIL2BAN_ENABLED === "true";

// Warn (once, at startup) if FAIL2BAN_ENABLED holds a non-empty value that is
// neither "true" nor "false" (e.g. "True", "1", "yes"), so a typo cannot
// silently leave protection disabled. Enablement semantics are unchanged: only
// the exact string "true" enables the feature; anything else stays disabled.
const warnIfUnrecognizedFlag = () => {
  const raw = process.env.FAIL2BAN_ENABLED;
  if (raw !== undefined && raw !== "" && raw !== "true" && raw !== "false") {
    console.warn(
      `FAIL2BAN_ENABLED="${raw}" is not a recognized value — Fail2ban stays disabled. ` +
      `Set FAIL2BAN_ENABLED="true" to enable, or "false"/unset to disable.`
    );
  }
};

// Validate one tunable, or warn and fall back to its default.
const resolveValue = (envName, rawValue, defaultValue, validator) => {
  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return defaultValue;
  }
  try {
    validator(rawValue, envName);
    return rawValue;
  } catch (err) {
    console.warn(`Invalid ${envName}: ${err.message}. Using default: ${defaultValue}`);
    return defaultValue;
  }
};

// Pure: renders the jail.local contents from the template + (validated) env.
// Exposed for tests; reads the real template file but writes nothing.
const buildConfig = (env = process.env) => {
  const bantime = resolveValue("FAIL2BAN_BANTIME", env.FAIL2BAN_BANTIME, DEFAULTS.bantime, validatePositiveInt);
  const findtime = resolveValue("FAIL2BAN_FINDTIME", env.FAIL2BAN_FINDTIME, DEFAULTS.findtime, validatePositiveInt);
  const maxretry = resolveValue("FAIL2BAN_MAXRETRY", env.FAIL2BAN_MAXRETRY, DEFAULTS.maxretry, validatePositiveInt);
  const ignoreip = resolveValue("FAIL2BAN_IGNOREIP", env.FAIL2BAN_IGNOREIP, DEFAULTS.ignoreip, validateIgnoreIp);

  return fs.readFileSync(TEMPLATE_PATH, "utf8")
    .replace(/\$\{BANTIME\}/g, bantime)
    .replace(/\$\{FINDTIME\}/g, findtime)
    .replace(/\$\{MAXRETRY\}/g, maxretry)
    .replace(/\$\{IGNOREIP\}/g, ignoreip);
};

// Orchestrator called from entrypoint.js. No-op when disabled; never throws —
// a Fail2ban config failure is logged and swallowed so nginx still starts.
module.exports = async () => {
  warnIfUnrecognizedFlag();
  if (!isEnabled()) {
    return;
  }
  try {
    const config = buildConfig();
    fs.writeFileSync(jailOutputPath(), config);
    console.log(`Fail2ban enabled — wrote jail configuration to ${jailOutputPath()}`);
  } catch (err) {
    console.error(`WARNING: Fail2ban configuration generation failed — continuing without Fail2ban: ${err.message || err}`);
  }
};

module.exports.isEnabled = isEnabled;
module.exports.warnIfUnrecognizedFlag = warnIfUnrecognizedFlag;
module.exports.buildConfig = buildConfig;
module.exports.DEFAULTS = DEFAULTS;
