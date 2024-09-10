#!/bin/bash
# based on https://www.sqlpac.com/en/documents/linux-ubuntu-fail2ban-setup-configuration-iptables.html#installation
# configure ssh fail2ban

# sudo apt install python-is-python3 pip
# pip install virtualenv
# chmod +x ssh-fail2ban.sh
# sudo ./ssh-fail2ban.sh

# crontab -e
# @reboot fail2ban-client start


mkdir -p /opt/python/
touch /opt/python/.python-3.8

echo 'export PYHOME=/opt/python/python-3.8
export PATH=$PYHOME/bin:$PATH
export LD_LIBRARY_PATH=$PYHOME/lib:$LD_LIBRARY_PATH
export PYTHONPATH=/opt/python/packages' > /opt/python/.python-3.8

source /opt/python/.python-3.8

virtualenv --system-site-packages /opt/monitoring/fail2ban

source /opt/monitoring/fail2ban/bin/activate

mkdir -p /opt/monitoring/setup
cd /opt/monitoring/setup

git clone https://github.com/fail2ban/fail2ban.git
cd fail2ban
python setup.py install

touch /etc/fail2ban/jail.local

echo '[DEFAULT]
ignoreip = 127.0.0.1
backend = systemd
maxretry = 3
findtime = 300
bantime = 3600

[sshd]
enabled = true
port    = ssh
logpath = %(sshd_log)s
backend = %(sshd_backend)s

' > /etc/fail2ban/jail.local

fail2ban-client stop

cp build/fail2ban.service /lib/systemd/system/fail2ban.service


cd /etc/systemd/system
ln -fs /lib/systemd/system/fail2ban.service fail2ban.service

systemctl enable fail2ban

fail2ban-client start