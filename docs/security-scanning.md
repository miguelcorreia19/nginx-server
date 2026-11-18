# Security Scanning

How the published image is watched for vulnerabilities, what makes a scan fail, and what to do when it does. The workflow is [`.github/workflows/security.yml`](../.github/workflows/security.yml); the policy it applies is implemented in [`.github/scripts/security-report.js`](../.github/scripts/security-report.js) and covered by `js/tests/security-report.test.js` and `js/tests/security-workflow.test.js`.

## What runs, and when

| Job | Schedule (UTC) | What it scans | Architectures |
| --- | --- | --- | --- |
| **Published image** | daily, 04:23 | `miguelcorreia19/nginx-server:latest` exactly as Docker Hub serves it, resolved to each architecture's digest; plus the upstream base image recorded in that image's build provenance | `linux/amd64`, `linux/arm64` (one job each) |
| **Fresh rebuild** | Mondays, 05:47 | A candidate built from the current Dockerfile with `docker build --pull --no-cache`, compared with the published image and with a fresh pull of the base image | `linux/amd64` on `ubuntu-24.04`, `linux/arm64` on `ubuntu-24.04-arm` (native builds, no emulation) |

Each architecture runs as its own job, so a failure on one never cancels or hides the other's result. Both jobs resolve `latest` to the architecture's own image digest first and scan, pull and inspect only that digest. Both can also be started by hand (see [Running a scan manually](#running-a-scan-manually)). Neither job pushes, tags or publishes an image, changes a dependency, opens an issue or a pull request, or writes to the repository; neither has access to any secret. The rebuild's candidate exists only in the runner's local Docker daemon and is discarded with the runner.

The daily job answers *"is the image people pull affected by something disclosed since it was built?"*. The weekly job answers *"would rebuilding today fix it, and does the current Dockerfile still build and pass?"* — it is the signal that a rebuild and re-release is worth doing, or that something now needs a code change.

## What is scanned

- **Alpine packages** (`apk`), matched against the Alpine security database.
- **Application dependencies**: the Node packages installed from `js/package-lock.json`, and the Python packages Alpine installs for Certbot (`cryptography`, `urllib3`, `certifi`, …). Trivy normally skips language packages that an OS package installed; the workflow uses `--detection-priority comprehensive` precisely so these stay visible, because they are where the known High findings of this image live. Losing them would not show as an error — the Python findings would simply vanish and the image would read as clean — so the report script checks the coverage itself: every Python distribution that the scan's own OS package inventory says an Alpine package installed must appear among the scanned Python packages, and for this image (`--expect-python-from certbot`) the inventory must list Certbot's. A report that fails either check is a scanner failure, not a result. The check uses no vulnerability counts or identifiers, so a clean image still passes.
- **nginx itself**, against the [nginx.org security advisories](https://nginx.org/en/security_advisories.html). The base image installs nginx from nginx.org's own Alpine repository, which the Alpine security database does not describe, so Trivy reports nothing for it — not even for releases with published advisories. The report script therefore parses the advisory page and checks the installed nginx version against every listed vulnerable range. If the page cannot be fetched or no longer parses, the job fails as a scanner failure rather than reporting "no nginx advisories".

Nothing is suppressed: the workflow sets `TRIVY_IGNOREFILE=/dev/null`, so a `.trivyignore` cannot hide a finding, and it does not use `--ignore-unfixed`. A triaged finding is recorded as an assessment or a decision (see [Known scanner findings](architecture.md#known-scanner-findings-in-the-released-image)), not as a filter.

## Failure policy

A scan **fails** when the image has:

| Finding | Fails? | Why |
| --- | --- | --- |
| Any **CRITICAL**, fixed or not | **Yes** | Always needs an explicit decision. |
| **HIGH** with a fix this project can apply — an Alpine package Alpine has fixed, nginx fixed in a newer release, or a project npm dependency with a fixed version | **Yes** | A rebuild, a base-image bump or a lockfile update resolves it. |
| **HIGH** fixed only upstream in a package Alpine installs (e.g. `cryptography` from `py3-cryptography`) | No — reported as a warning | Only a new Alpine build can fix it; the image cannot pick it up until then. |
| **HIGH** with no fix published anywhere | No — reported as a warning | Nothing to apply yet. |
| MEDIUM, LOW, UNKNOWN | No — counted in the summary, listed in the artifact and in code scanning | |

The non-failing HIGH findings are still shown in the job summary table, raised as a workflow warning annotation, and (for the daily job) uploaded to code scanning, so they remain visible every day.

The weekly job fails in two cases:

- the **candidate** violates the policy above — even a fresh rebuild would not be enough, so fixing needs a code, dependency or base-image change; or
- the **rebuild clears a CRITICAL or HIGH finding of the published image** — the published image is stale and should be rebuilt and released. This is also how an Alpine fix for an Alpine-installed package such as `py3-cryptography` surfaces: the daily scan can only report that finding, but once Alpine ships the fixed build, a fresh build no longer has it.

## Reading a report

Every run writes a job summary per architecture (Actions → the run → Summary). It shows which image digest, base image, Trivy version and vulnerability-database snapshot were used, how many Alpine-installed Python distributions were analysed, the policy result, a severity table, and one row per CRITICAL/HIGH finding:

| Column | Meaning |
| --- | --- |
| Policy | **FAIL** if this finding violates the policy, otherwise `report` |
| ID | CVE or GHSA identifier, linked to its advisory |
| Package / Installed / Fixed | the affected component, its installed version, and the first fixed version (`—` when none) — for an Alpine-installed language package, also the apk package that provides it |
| Arch | the architecture this scan covered |
| Fix available | whether any fixed version exists |
| Remediation | what would fix it: a rebuild, a base-image bump, a dependency update, or waiting for an Alpine build |
| Evidence | *distribution advisory* — Alpine's security database lists this exact package version as affected; *vendor advisory* — nginx.org lists the installed nginx as vulnerable; *triage* — a scanner match of the package version against a generic advisory database, which says nothing about whether this image's use of the package is exploitable |
| Origin | *upstream base image* — the same issue is present in the nginx base image itself; *added by nginx-server* — introduced by this image's own packages; *unknown* — no base scan for this run |
| Impact | the advisory title |

Below the table, the summary lists CRITICAL/HIGH findings present only in the upstream base (cleared by this image's `apk upgrade`) and, for the weekly job, what a rebuild clears and what it newly introduces, followed by the Alpine updates available to the published image (`apk list --upgradable`) and the package-version diff between published and rebuilt images.

No automated result is a confirmed vulnerability in this deployment: confirming that requires checking whether the vulnerable code path is reachable here.

Where to find the full data:

- **Artifacts** (`security-scan-published-<arch>`, `security-scan-rebuild-<arch>`, kept 30 days): Trivy JSON reports for the image and its base, SARIF, the advisory page that was checked, Trivy version/DB metadata, and the package lists.
- **Code scanning** (Security → Code scanning, categories `trivy-published-linux-amd64` / `-arm64`): the daily job's findings as alerts. Alerts are tracked across runs, so a finding that persists is one alert rather than one per day, and it closes when a later scan no longer reports it.

## Running a scan manually

Actions → **Security scan** → **Run workflow**, then choose `both`, `published` or `rebuild`. With the GitHub CLI:

```bash
gh workflow run security.yml -f check=both
gh run watch
```

GitHub only offers a manual run once the workflow file exists on the default branch. After that, a run can be started on another branch (`gh workflow run security.yml --ref <branch> -f check=both`) and then uses that branch's copy of the workflow, which is how a workflow change is tried before merging. Code-scanning results from such a run are filed under that branch.

## When a run fails

The failed step says which kind of failure it is:

| Failed step | Meaning | What to do |
| --- | --- | --- |
| Download and verify Trivy | The scanner download failed, or its **SHA-256 did not match** | A mismatch is a supply-chain alarm, not a flake: do not update the hash to make it pass. Investigate (see [Updating the scanner](#updating-the-scanner)). |
| Download the vulnerability database | The Trivy database could not be fetched | Scanner failure. Re-run; nothing was concluded about the image. |
| Resolve the published image (daily) / Resolve and pull the published image (weekly) — *Missing architecture* | `latest` does not publish that architecture | A release defect: republish `latest` as a multi-platform image. |
| Scan … / Fetch the nginx.org security advisories | Registry, network or scanner error | Scanner failure. Re-run. |
| Build a candidate image | The Dockerfile no longer builds against current upstream (for example the pinned Certbot package stopped resolving) | A real maintenance signal; reproduce locally with `docker build --pull --no-cache .`. |
| Apply the vulnerability policy — `::error` annotations naming CVEs | **Policy violation**: these findings fail the policy | Remediate (below). |
| Apply the vulnerability policy to the candidate — *Published image needs a rebuild* | A fresh build clears CRITICAL/HIGH findings the published image still has | Rebuild and release (below). |
| Apply the vulnerability policy — *Security report input unusable* | A report was missing or malformed, Trivy detected no OS, the advisory page did not parse, or the scan left out Python packages that Alpine packages installed (the message names them) | Scanner failure. The image was **not** evaluated; never read this as "clean". For missing Python packages, check that `TRIVY_DETECTION_PRIORITY: comprehensive` and `TRIVY_PKG_TYPES: os,library` are still in effect, and whether a Trivy update changed them. |
| Upload to GitHub code scanning | SARIF upload was refused | The summary and artifacts are still complete; check code scanning is available and the job still has `security-events: write`. |

## Remediation

1. **Alpine package with a fix** — start a `rebuild` run. If the candidate clears the finding, cut a patch release through the normal release procedure (tests, multi-platform build of the tagged commit, publish `X.Y.Z` and `latest` together). If the candidate still has it, the fixed build is not yet available to this Alpine branch, or the version is held by the base image (nginx and its modules are pinned in its `/etc/apk/world`) and needs a base-image bump instead.
2. **nginx advisory** — move both `FROM` lines and the Dockerfile header contract to the fixed nginx release (the build-startup assertions enforce that they agree), update `docs/architecture.md`, and validate as for any base-image change.
3. **Project npm dependency** — update `js/package-lock.json`, run the suite, release.
4. **HIGH fixed only upstream in an Alpine-installed package** — triage reachability and record the outcome in [Known scanner findings](architecture.md#known-scanner-findings-in-the-released-image); the weekly rebuild will start failing once Alpine ships the fix. Check Alpine's security database first: a fix Alpine backports keeps the upstream version, so the Python-level finding can persist after it.
5. **CRITICAL without any fix** — requires a decision (mitigate, change the affected component, or accept and document). The scan keeps failing until the finding is gone; there is deliberately no suppression switch.

Do not hand-edit a published version tag to remediate: publish a new version.

## Scheduled runs: operational caveats

- Scheduled workflows run **only from the default branch** (`main`), and GitHub offers manual runs only for workflows present there. Until `security.yml` is on `main`, it does not run at all.
- GitHub may **delay** scheduled runs at busy times, and occasionally drop one. A missed day is covered by the next run; start one by hand if it matters.
- In a public repository GitHub **disables scheduled workflows after 60 days without repository activity**. Re-enable it from the workflow's page in the Actions tab.
- Failure notifications for scheduled runs go to the user who last modified the schedule, through normal GitHub Actions notifications.

## Updating the scanner

Trivy and its GitHub Actions were compromised in March 2026 ([GHSA-69fq-xp46-6x23](https://github.com/advisories/GHSA-69fq-xp46-6x23)): malicious `v0.69.4` binaries, `0.69.5`/`0.69.6` Docker Hub images, and hijacked `trivy-action` / `setup-trivy` tags. This workflow therefore uses neither action: [`.github/actions/install-trivy`](../.github/actions/install-trivy/action.yml) downloads one release from GitHub and refuses it unless its SHA-256 matches the pinned value. To move to a new release:

1. Check the [Trivy advisories](https://github.com/aquasecurity/trivy/security/advisories) and pick a release that is not affected by any, published as an immutable GitHub release.
2. Download `trivy_<version>_Linux-64bit.tar.gz`, `trivy_<version>_Linux-ARM64.tar.gz` and their `.sigstore.json` bundles, and verify each was signed by Trivy's release workflow:

   ```bash
   cosign verify-blob \
     --certificate-identity-regexp '^https://github\.com/aquasecurity/trivy/\.github/workflows/' \
     --certificate-oidc-issuer https://token.actions.githubusercontent.com \
     --bundle trivy_<version>_Linux-64bit.tar.gz.sigstore.json \
     trivy_<version>_Linux-64bit.tar.gz
   ```

3. Update `TRIVY_VERSION` and both `TRIVY_SHA256_*` values together, and run `js/tests/security-workflow.test.js`.

Every other action in the workflows is pinned to a full commit SHA with its release in a trailing comment; keep that form when updating them.

## Limitations

- Scanners match versions against advisory databases; none of the results says whether a vulnerable code path is reachable in this image. The triage of the current findings is in [Known scanner findings](architecture.md#known-scanner-findings-in-the-released-image).
- Alpine packages are matched against Alpine's own security database, which knows about Alpine's backported fixes; the Python packages inside them are matched by upstream version against generic advisories, which do not. A Python finding can therefore outlive an Alpine backport, or describe a different build (GHSA-537c-gmf6-5ccf describes PyPI wheels, not Alpine's build).
- Code is only matched if Trivy can see what it is. Python packages are found through their `dist-info`/`egg-info` metadata; code vendored inside another package without its own metadata (as pip vendors its dependencies) is invisible unless the package ships an SBOM that lists it.
- The Python coverage check covers what Alpine packages install, because that is what this image contains. Python packages installed some other way are reported when Trivy finds them, but nothing requires them to be found.
- The nginx check depends on the nginx.org advisory page layout. A layout change makes the job fail loudly instead of passing silently, and then needs a parser update. nginx.org's "minor" and "none" ratings are reported as LOW. A rating the script does not know is reported as UNKNOWN, which never fails the policy, so a new nginx.org severity label needs a mapping before it can.
- The upstream-base comparison of the daily job relies on the build provenance attached to the published image; an image published without provenance is scanned without that comparison.
- Only the nginx-server image is monitored. Images the examples pull — such as the Certbot sidecar of [`examples/cloudflare-custom-certs`](../examples/cloudflare-custom-certs/) — are not scanned by this workflow; that sidecar's pin was assessed by hand (see its README).
