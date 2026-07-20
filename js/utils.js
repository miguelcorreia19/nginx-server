const { exec, execFile, spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createLogger } = require("./logger.js");
const { log } = createLogger("nginx");

exports.command = command = (cmd) => {
  return new Promise((resolve, reject) => {
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        reject({ error: error.message });
        return;
      }
      if (stdout) {
        resolve(stdout);
        return;
      }
      if (stderr) {
        reject({ error: stderr });
        return;
      }
      resolve();
      return;
    });
  })
};

// Shell-injection-safe alternative: spawns the binary directly without a shell.
// Use this wherever user-controlled values (cert IDs, domains, filenames) are passed as args.
exports.commandSafe = commandSafe = (bin, args) => {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 5 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject({ error: error.message });
        return;
      }
      if (stdout) {
        resolve(stdout);
        return;
      }
      if (stderr) {
        reject({ error: stderr });
        return;
      }
      resolve();
    });
  });
};

// Runs `nginx -t` to validate the assembled configuration without reloading.
// nginx writes all output (including the success message) to stderr, so
// success/failure is decided purely by exit code; diagnostics come from the
// captured output.
//
// Uses spawn() with stdio mapped to a real temp file rather than anonymous
// pipes (as execFile/exec use). The repository's nginx.conf contains
// `error_log /dev/stderr warn;` — nginx resolves that to /proc/self/fd/2
// and reopens it via open(2) during config-test initialisation. open(2) on
// an anonymous pipe fails with ENXIO ("No such device or address"), which
// would falsely report any valid config as broken. A regular file is always
// re-openable by path, so this approach is reliable regardless of Docker
// log driver or stdio setup.
exports.validateNginxConfig = validateNginxConfig = () => {
  return new Promise((resolve, reject) => {
    const tmpPath = path.join(os.tmpdir(), `nginx-validate-${process.pid}.log`);
    let outFd;
    try {
      outFd = fs.openSync(tmpPath, 'w');
    } catch (err) {
      reject({ error: `validateNginxConfig: cannot open temp file: ${err.message}` });
      return;
    }

    const child = spawn('nginx', ['-t'], {
      stdio: ['ignore', outFd, outFd],
    });

    let settled = false;
    const finish = (code, spawnErr) => {
      if (settled) return;
      settled = true;
      try { fs.closeSync(outFd); } catch (_) {}
      let output = '';
      try { output = fs.readFileSync(tmpPath, 'utf8'); } catch (_) {}
      try { fs.unlinkSync(tmpPath); } catch (_) {}

      if (spawnErr) {
        reject({ error: spawnErr.message });
        return;
      }
      if (code !== 0) {
        reject({ error: output || `nginx -t exited with code ${code}` });
        return;
      }
      resolve(output);
    };

    child.on('error', (err) => finish(null, err));
    child.on('close', (code) => finish(code, null));
  });
};

exports.mapCustomNginxConf = mapCustomNginxConf = async (files, dirPath) => {
  for (const file of files) {
    const conf_file = `${dirPath}/${file}`;
    if (fs.existsSync(conf_file)) {
      await command(`ln -sf ${conf_file} /etc/nginx/${file}`);
    }
  }
}

const httpRedirect = async (id, names) => {
  let data = '';

  data = fs.readFileSync(path.join(__dirname, 'templates/http_redirect.conf'), 'utf8');
  data = data.replace('${SERVER_NAMES}', `${names}`);

  fs.writeFileSync(`/etc/nginx/conf.d/80/${id}-http-redirect.conf`, data);
}

exports.configFiles = async (id, status, http_redirect, cert_domains) => {
  // An invalid certificate is an external/transient Certbot outcome (e.g. a
  // failed issuance or renewal), not a local configuration problem — this
  // stays a non-fatal skip, unchanged from before.
  if (status === 'invalid') {
    log(`Skipping ${id}: certificate invalid`);
    return;
  }

  // js/preflight.js already guarantees this site config exists before the
  // calling handler runs — preflightEntry() for production entries,
  // preflightDev() for development's dev.conf — since js/entrypoint.js runs
  // the relevant one before dispatching to any handler. This is a defensive
  // check only, for the file disappearing between preflight and this call:
  // startup configuration is no longer satisfied, so it must fail rather
  // than silently skip the site.
  const sitePath = `/home/nginx/sites/${id}.conf`;
  if (!fs.existsSync(sitePath)) {
    throw new Error(`Site "${id}": missing site config ${sitePath} (present at preflight, now missing)`);
  }

  await commandSafe('ln', ['-sf', sitePath, `/etc/nginx/conf.d/443/${id}.conf`]);

  // create redirect files from http to https
  if (http_redirect !== false) {
    await httpRedirect(id, cert_domains.join(' '));
  }
}