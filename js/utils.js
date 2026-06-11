const { exec, execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

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
// nginx writes its "test is successful" message to stderr even on success
// (like openssl), so — unlike commandSafe — success/failure here is decided
// purely by exit code; the rejection carries nginx's actual diagnostic text.
exports.validateNginxConfig = validateNginxConfig = () => {
  return new Promise((resolve, reject) => {
    execFile('nginx', ['-t'], { maxBuffer: 5 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject({ error: stderr || error.message });
        return;
      }
      resolve(stdout || stderr);
    });
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
  if (status !== 'invalid' && fs.existsSync(`/home/nginx/sites/${id}.conf`)) {
    await commandSafe('ln', ['-sf', `/home/nginx/sites/${id}.conf`, `/etc/nginx/conf.d/443/${id}.conf`]);
    
    // create redirect files from http to https
    if (http_redirect !== false) {
      await httpRedirect(id, cert_domains.join(' '));
    }
  } else {
    console.log(`Discarding ${id}.conf`);
  }
}