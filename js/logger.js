// Shared logger for project-owned Node logs.
//
// One consistent, container-friendly line format:
//   YYYY-MM-DD HH:mm:ss [component] message
//
// The timestamp deliberately matches the shell scripts' `date '+%Y-%m-%d
// %H:%M:%S'` helper exactly — same format and same (local) timezone — so Bash
// and Node lines are visually uniform in a single container log stream. The
// timestamp is carried on every line so output reads the same whether it
// reaches the user via Docker's log pipeline (entrypoint path) or is written
// straight to a file by cron (the renewal path, which bypasses Docker's own
// timestamps).
//
// warn()/error()/fatal() add a severity label (WARNING:/ERROR:/Fatal:).
//
// Deliberately tiny — no logging library, no JSON, no colors, no emojis. Just
// console.* with a consistent prefix. Extra console.* arguments are passed
// through unchanged (e.g. an Error object for its stack), so callers can keep
// `fatal('...', err)`.

const pad = (n) => String(n).padStart(2, "0");

// Local-time "YYYY-MM-DD HH:mm:ss" (no milliseconds, no timezone suffix) to
// mirror `date '+%Y-%m-%d %H:%M:%S'`.
const timestamp = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

const createLogger = (component) => {
  const tag = `[${component}]`;
  return {
    log:   (msg, ...rest) => console.log(`${timestamp()} ${tag} ${msg}`, ...rest),
    warn:  (msg, ...rest) => console.warn(`${timestamp()} ${tag} WARNING: ${msg}`, ...rest),
    error: (msg, ...rest) => console.error(`${timestamp()} ${tag} ERROR: ${msg}`, ...rest),
    fatal: (msg, ...rest) => console.error(`${timestamp()} ${tag} Fatal: ${msg}`, ...rest),
  };
};

module.exports = { createLogger };
