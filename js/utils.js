const { exec } = require("child_process");
const fs = require("fs");

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

exports.mapCustomNginxConf = mapCustomNginxConf = async (files, path) => {
  files.forEach(async file => {
    const conf_file = `${path}/${file}`;
    if (fs.existsSync(conf_file)) {
      await command(`ln -sf ${conf_file} /etc/nginx/${file}`);
    }
  });
}

const httpRedirect = async (id, names) => {
  let data = '';

  data = fs.readFileSync('./templates/http_redirect.conf', 'utf8');
  data = data.replace('${SERVER_NAMES}', `${names}`);

  await command(`echo "${data}" > /etc/nginx/conf.d/80/${id}-http-redirect.conf`);
}

exports.configFiles = async (id, status, http_redirect, cert_domains) => {
  if (status !== 'invalid' && fs.existsSync(`/home/nginx/sites/${id}.conf`)) {
    await command(`ln -sf /home/nginx/sites/${id}.conf /etc/nginx/conf.d/443/${id}.conf`);
    
    // create redirect files from http to https
    if (http_redirect !== false) {
      await httpRedirect(id, cert_domains.join(' '));
    }
  } else {
    console.log(`Discarding ${id}.conf`);
  }
}