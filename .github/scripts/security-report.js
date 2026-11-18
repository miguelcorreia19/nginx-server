#!/usr/bin/env node
'use strict';

// Turns Trivy JSON reports into the security-scan job summary and applies the
// failure policy documented in docs/security-scanning.md.
//
// nginx itself is checked against the nginx.org advisory list as well, because
// the base image installs nginx from nginx.org's own Alpine repository: Trivy
// matches Alpine packages against Alpine's secdb, which does not describe that
// build, so it reports no nginx findings at all.
//
// Exit status: 0 within policy, 1 policy violation, 2 unusable input. Unusable
// input is a scanner failure and is never reported as "no findings".

const fs = require('fs');

const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'];
const NGINX_SEVERITY = { major: 'HIGH', medium: 'MEDIUM', low: 'LOW' };
const NGINX_ADVISORIES_URL = 'https://nginx.org/en/security_advisories.html';

class InputError extends Error {}

function readFile(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new InputError(`${file}: ${err.message}`);
  }
}

function parseTrivyReport(text, name) {
  let report;
  try {
    report = JSON.parse(text);
  } catch (err) {
    throw new InputError(`${name}: ${err.message}`);
  }
  if (!report || report.SchemaVersion !== 2 || !report.Metadata || !Array.isArray(report.Results)) {
    throw new InputError(`${name}: not a Trivy schema-2 JSON report`);
  }
  if (!report.Metadata.OS || !report.Results.some((r) => r.Class === 'os-pkgs')) {
    throw new InputError(`${name}: Trivy detected no operating system, so the image was not analysed`);
  }
  return report;
}

const osPackages = (report) => report.Results
  .filter((r) => r.Class === 'os-pkgs')
  .flatMap((r) => r.Packages || []);

function compareVersions(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

function trivyFindings(report) {
  // A language package (e.g. Certbot's Python dependencies) that an apk package
  // installed can only be fixed by a new Alpine build, not by this project.
  const apkOwner = new Map();
  for (const p of osPackages(report)) {
    for (const file of p.InstalledFiles || []) apkOwner.set(file, `${p.Name}-${p.Version}`);
  }
  return report.Results.flatMap((r) => (r.Vulnerabilities || []).map((v) => {
    const os = r.Class === 'os-pkgs';
    const source = v.DataSource || {};
    return {
      id: v.VulnerabilityID,
      severity: SEVERITIES.includes(v.Severity) ? v.Severity : 'UNKNOWN',
      pkg: v.PkgName,
      installed: v.InstalledVersion,
      fixed: v.FixedVersion || '',
      kind: os ? 'os' : 'library',
      apkPackage: os ? `${v.PkgName}-${v.InstalledVersion}` : apkOwner.get(v.PkgPath) || null,
      path: v.PkgPath || '',
      title: v.Title || '',
      url: v.PrimaryURL || '',
      evidence: os && source.ID === 'alpine'
        ? 'distribution advisory (Alpine secdb)'
        : `triage: version match (${source.Name || source.ID || 'unknown source'})`,
    };
  }));
}

function splitList(value) {
  return value.split(',').map((t) => t.trim()).filter(Boolean);
}

function decodeEntities(text) {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

function parseNginxAdvisories(html) {
  const advisories = [];
  for (const [, body] of html.matchAll(/<li><p>([\s\S]*?)<\/p><\/li>/g)) {
    const lines = body.split(/<br\s*\/?>/i).map((l) => decodeEntities(l.replace(/<[^>]+>/g, '')).trim());
    const field = (name) => {
      const line = lines.find((l) => l.startsWith(`${name}:`));
      return line ? line.slice(name.length + 1).trim() : '';
    };
    const severity = field('Severity').toLowerCase();
    const vulnerable = field('Vulnerable');
    if (!severity || !vulnerable) continue;
    advisories.push({
      title: lines[0],
      severity,
      ids: [...new Set(lines.join(' ').match(/CVE-\d{4}-\d+/g) || [])],
      vulnerable: splitList(vulnerable),
      notVulnerable: splitList(field('Not vulnerable')),
    });
  }
  if (advisories.length < 10) {
    throw new InputError(`nginx advisories: parsed ${advisories.length} entries; the page format may have changed`);
  }
  return advisories;
}

function advisoryAffects(advisory, version) {
  return advisory.vulnerable.some((token) => {
    if (token === 'all') return true;
    if (token === 'none' || /^nginx\/Windows\b/i.test(token)) return false;
    const m = token.match(/^(\d+(?:\.\d+)*)(?:-(\d+(?:\.\d+)*))?$/);
    if (!m) throw new InputError(`nginx advisories: unrecognised version range "${token}" in "${advisory.title}"`);
    const [, low, high = low] = m;
    return compareVersions(version, low) >= 0 && compareVersions(version, high) <= 0;
  });
}

function advisoryFixedVersion(advisory, version) {
  const branch = version.split('.').slice(0, 2).join('.');
  const newer = advisory.notVulnerable
    .map((t) => t.replace(/\+$/, ''))
    .filter((t) => /^\d+(\.\d+)*$/.test(t) && compareVersions(t, version) > 0)
    .sort(compareVersions);
  return newer.find((t) => t.startsWith(`${branch}.`)) || newer[0] || '';
}

function nginxFindings(report, advisories) {
  const pkg = osPackages(report).find((p) => p.Name === 'nginx');
  if (!pkg) throw new InputError('nginx advisories: the image has no "nginx" package to check');
  const version = pkg.Version.replace(/-r\d+$/, '');
  return advisories.filter((a) => advisoryAffects(a, version)).flatMap((a) =>
    (a.ids.length ? a.ids : [a.title]).map((id) => ({
      id,
      severity: NGINX_SEVERITY[a.severity] || 'UNKNOWN',
      pkg: 'nginx',
      installed: pkg.Version,
      fixed: advisoryFixedVersion(a, version),
      kind: 'nginx.org',
      apkPackage: null,
      path: '',
      title: `${a.title} (nginx severity: ${a.severity})`,
      url: NGINX_ADVISORIES_URL,
      evidence: 'vendor advisory (nginx.org)',
    })));
}

function remediation(f) {
  if (!f.fixed) return { actionable: false, text: 'no fix published' };
  if (f.kind === 'nginx.org') return { actionable: true, text: `move the base image to nginx ${f.fixed} or later` };
  if (f.kind === 'os') return { actionable: true, text: `Alpine ships ${f.fixed}: rebuild, or move the base image if it holds the version` };
  if (f.apkPackage) return { actionable: false, text: `fixed upstream in ${f.fixed}; no Alpine build yet (${f.apkPackage})` };
  return { actionable: true, text: `update the dependency to ${f.fixed}` };
}

const violatesPolicy = (f) => f.severity === 'CRITICAL' || (f.severity === 'HIGH' && remediation(f).actionable);
const isSevere = (f) => f.severity === 'CRITICAL' || f.severity === 'HIGH';
const keyOf = (f) => `${f.id}|${f.pkg}`;

function bySeverity(a, b) {
  return SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity)
    || a.pkg.localeCompare(b.pkg) || a.id.localeCompare(b.id);
}

function evaluate({ report, base = null, published = null, nginxAdvisories = null }) {
  const findings = [...trivyFindings(report), ...(nginxAdvisories ? nginxFindings(report, nginxAdvisories) : [])]
    .sort(bySeverity);
  const baseKeys = base ? new Set(trivyFindings(base).map(keyOf)) : null;
  const keys = new Set(findings.map(keyOf));
  const result = {
    findings: findings.map((f) => ({
      ...f,
      remediation: remediation(f),
      violation: violatesPolicy(f),
      origin: baseKeys ? (baseKeys.has(keyOf(f)) ? 'upstream base image' : 'added by nginx-server') : 'unknown',
    })),
    baseOnly: base ? trivyFindings(base).filter((f) => isSevere(f) && !keys.has(keyOf(f))).sort(bySeverity) : null,
    comparison: null,
  };
  if (published) {
    const publishedFindings = trivyFindings(published);
    const publishedKeys = new Set(publishedFindings.map(keyOf));
    result.comparison = {
      clearedByRebuild: publishedFindings.filter((f) => isSevere(f) && !keys.has(keyOf(f))).sort(bySeverity),
      newInRebuild: result.findings.filter((f) => isSevere(f) && !publishedKeys.has(keyOf(f))),
      publishedViolations: publishedFindings.filter(violatesPolicy).length,
    };
  }
  result.violations = result.findings.filter((f) => f.violation);
  // A fresh build that clears CRITICAL/HIGH findings of the published image
  // means the published image is stale. This also catches an Alpine fix for an
  // Alpine-installed language package, which the daily scan can only report.
  result.rebuildRequired = Boolean(result.comparison && result.comparison.clearedByRebuild.length);
  result.failed = result.violations.length > 0 || result.rebuildRequired;
  return result;
}

const cell = (value) => String(value || '—').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

function findingRow(f, arch) {
  const id = f.url ? `[${cell(f.id)}](${f.url})` : cell(f.id);
  const where = f.apkPackage && f.kind !== 'os' ? `${f.pkg} (from ${f.apkPackage})` : f.pkg;
  return `| ${f.violation ? '**FAIL**' : 'report'} | ${id} | ${f.severity} | ${cell(where)} | ${cell(f.installed)} | ${cell(f.fixed)} | ${arch} | ${f.fixed ? 'yes' : 'no'} | ${cell(f.remediation.text)} | ${cell(f.evidence)} | ${cell(f.origin)} | ${cell(f.title)} |`;
}

function countTable(findings) {
  const rows = SEVERITIES.map((s) => {
    const of = findings.filter((f) => f.severity === s);
    const actionable = of.filter((f) => f.remediation.actionable).length;
    const upstreamOnly = of.filter((f) => f.fixed && !f.remediation.actionable).length;
    return `| ${s} | ${of.length} | ${actionable} | ${upstreamOnly} | ${of.length - actionable - upstreamOnly} |`;
  });
  return ['| Severity | Total | Fix this project can apply | Fixed upstream only | No fix published |', '| --- | ---: | ---: | ---: | ---: |', ...rows].join('\n');
}

function render(result, { title, arch, report, notes = [] }) {
  const os = report.Metadata.OS;
  const digest = report.ArtifactName.includes('@sha256:')
    ? ''
    : (report.Metadata.RepoDigests || [])[0] || report.Metadata.ImageID || '';
  const lines = [
    `### ${title} — linux/${arch}`,
    '',
    `Image \`${report.ArtifactName}\`${digest ? ` (\`${digest}\`)` : ''} · ${os.Family} ${os.Name}${os.EOSL ? ' · **this OS release is end-of-life**' : ''}`,
    ...notes.map((n) => `\n${n}`),
    '',
    result.violations.length
      ? `**Policy: FAIL** — ${result.violations.length} finding(s) violate the policy (any CRITICAL; HIGH with a fix this project can apply).`
      : result.rebuildRequired
        ? '**Policy: FAIL** — the rebuilt image is within policy, but the published image is stale.'
        : '**Policy: pass** — no CRITICAL findings and no HIGH finding with a fix this project can apply.',
    ...(result.rebuildRequired
      ? ['', `**Rebuild needed** — rebuilding clears ${result.comparison.clearedByRebuild.length} CRITICAL/HIGH finding(s) of the published image; rebuild and release it.`]
      : []),
    '',
    countTable(result.findings),
  ];
  const severe = result.findings.filter(isSevere);
  if (severe.length) {
    lines.push('', '#### CRITICAL and HIGH findings', '',
      '| Policy | ID | Severity | Package | Installed | Fixed | Arch | Fix available | Remediation | Evidence | Origin | Impact |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      ...severe.map((f) => findingRow(f, arch)));
  }
  if (result.baseOnly) {
    lines.push('', `CRITICAL/HIGH findings present only in the upstream base image (cleared by this image's build): ${result.baseOnly.length ? result.baseOnly.map((f) => `${f.id} (${f.pkg})`).join(', ') : 'none'}.`);
  } else {
    lines.push('', 'Upstream base image comparison: not available for this run.');
  }
  if (result.comparison) {
    const list = (items) => (items.length ? items.map((f) => `${f.id} (${f.pkg} ${f.installed})`).join(', ') : 'none');
    lines.push('', '#### Fresh rebuild compared with the published image', '',
      `- Policy violations in the published image: ${result.comparison.publishedViolations}`,
      `- CRITICAL/HIGH cleared by rebuilding: ${list(result.comparison.clearedByRebuild)}`,
      `- CRITICAL/HIGH new in the rebuild: ${list(result.comparison.newInRebuild)}`);
  }
  lines.push('', 'MEDIUM, LOW and UNKNOWN findings are listed in the job artifact.', '');
  return lines.join('\n');
}

const escapeData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProperty = (s) => escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

function annotations(result, { arch }) {
  const out = result.violations.slice(0, 10).map((f) =>
    `::error title=${escapeProperty(`${f.severity} ${f.id} (linux/${arch})`)}::${escapeData(`${f.pkg} ${f.installed}: ${f.remediation.text}. ${f.title}`)}`);
  if (result.violations.length > 10) {
    out.push(`::error title=${escapeProperty(`linux/${arch}`)}::${escapeData(`${result.violations.length - 10} more policy violations; see the job summary`)}`);
  }
  if (result.rebuildRequired) {
    out.push(`::error title=${escapeProperty(`Published image needs a rebuild (linux/${arch})`)}::${escapeData(result.comparison.clearedByRebuild.map((f) => `${f.id} ${f.pkg} ${f.installed}`).join('; '))}`);
  }
  const reported = result.findings.filter((f) => f.severity === 'HIGH' && !f.violation);
  if (reported.length) {
    out.push(`::warning title=${escapeProperty(`HIGH findings without an applicable fix (linux/${arch})`)}::${escapeData(reported.map((f) => `${f.id} ${f.pkg} ${f.installed}`).join('; '))}`);
  }
  return out;
}

function parseArgs(argv) {
  const opts = { notes: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (value === undefined) throw new InputError(`missing value for ${flag}`);
    const name = {
      '--report': 'report', '--base': 'base', '--published': 'published', '--nginx-advisories': 'nginxAdvisories',
      '--trivy-version': 'trivyVersion', '--arch': 'arch', '--title': 'title', '--summary': 'summary', '--note': 'note',
    }[flag];
    if (!name) throw new InputError(`unknown option ${flag}`);
    if (name === 'note') opts.notes.push(value);
    else opts[name] = value;
  }
  for (const required of ['report', 'arch', 'title']) {
    if (!opts[required]) throw new InputError(`--${required} is required`);
  }
  return opts;
}

// `trivy version --format json`, recorded so a report always says which
// scanner and which vulnerability-database snapshot produced it.
function scannerNote(file) {
  let info;
  try {
    info = JSON.parse(readFile(file));
  } catch (err) {
    throw err instanceof InputError ? err : new InputError(`${file}: ${err.message}`);
  }
  const db = info.VulnerabilityDB;
  if (!info.Version || !db || !db.UpdatedAt) throw new InputError(`${file}: no Trivy version or vulnerability DB metadata`);
  return `Scanner: Trivy ${info.Version}, vulnerability DB updated ${db.UpdatedAt}.`;
}

function main(argv) {
  try {
    const opts = parseArgs(argv);
    if (opts.trivyVersion) opts.notes.push(scannerNote(opts.trivyVersion));
    const report = parseTrivyReport(readFile(opts.report), opts.report);
    const result = evaluate({
      report,
      base: opts.base ? parseTrivyReport(readFile(opts.base), opts.base) : null,
      published: opts.published ? parseTrivyReport(readFile(opts.published), opts.published) : null,
      nginxAdvisories: opts.nginxAdvisories ? parseNginxAdvisories(readFile(opts.nginxAdvisories)) : null,
    });
    const markdown = render(result, { ...opts, report });
    if (opts.summary) fs.appendFileSync(opts.summary, `${markdown}\n`);
    else process.stdout.write(`${markdown}\n`);
    for (const line of annotations(result, opts)) process.stdout.write(`${line}\n`);
    return result.failed ? 1 : 0;
  } catch (err) {
    // Exit 1 is reserved for policy violations, so an unexpected error must not
    // fall through to Node's default exit status of 1.
    const message = err instanceof InputError ? err.message : err.stack;
    process.stdout.write(`::error title=Security report input unusable::${escapeData(message)}\n`);
    return 2;
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = {
  InputError,
  parseTrivyReport,
  parseNginxAdvisories,
  advisoryAffects,
  advisoryFixedVersion,
  evaluate,
  render,
  annotations,
  main,
};
