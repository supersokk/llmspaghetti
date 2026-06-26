# =============================================================================
# /etc/systemd/system/llmspaghetti-firstboot.service
#
# Runs the web setup wizard on port 80 on first boot only.
# Self-disables after setup completes.
# =============================================================================
[Unit]
Description=LLMSpaghetti First-Boot Setup Wizard
After=network-online.target
Wants=network-online.target
ConditionPathExists=!/opt/llmspaghetti/.firstboot-complete

[Service]
Type=simple
User=root
WorkingDirectory=/opt/llmspaghetti/firstboot
ExecStartPre=/usr/bin/pip3 install -q fastapi uvicorn jinja2 python-multipart
ExecStart=/usr/bin/python3 /opt/llmspaghetti/firstboot/main.py
Restart=on-failure
RestartSec=5
StandardOutput=append:/opt/llmspaghetti/logs/firstboot.log
StandardError=append:/opt/llmspaghetti/logs/firstboot.log

[Install]
WantedBy=multi-user.target

---FILE---

# =============================================================================
# /etc/systemd/system/llmspaghetti-status.service
#
# Displays the live status dashboard on tty1 instead of a login prompt.
# =============================================================================
[Unit]
Description=LLMSpaghetti Console Status Display
After=network-online.target
Wants=network-online.target
Conflicts=getty@tty1.service

[Service]
Type=simple
User=root
ExecStart=/usr/bin/python3 /opt/llmspaghetti/console/status.py
Restart=always
RestartSec=3
StandardInput=tty
StandardOutput=tty
TTYPath=/dev/tty1
TTYReset=yes
TTYVHangup=yes
TTYVTDisallocate=no
# When user presses Ctrl+C the script drops to a shell
# The shell's 'exit' restarts this service
ExecStopPost=/bin/bash -c "systemctl restart llmspaghetti-status.service"

[Install]
WantedBy=multi-user.target

---FILE---

# =============================================================================
# /etc/systemd/system/llmspaghetti.service
#
# Main service: starts the Docker Compose stack (Open WebUI + LiteLLM).
# =============================================================================
[Unit]
Description=LLMSpaghetti Stack (Open WebUI + LiteLLM)
Requires=docker.service ollama.service
After=docker.service ollama.service network-online.target
ConditionPathExists=/opt/llmspaghetti/.firstboot-complete

[Service]
Type=oneshot
RemainAfterExit=yes
User=llmspaghetti
WorkingDirectory=/opt/llmspaghetti
ExecStart=/usr/bin/docker compose -f /opt/llmspaghetti/docker-compose.yml up -d --remove-orphans
ExecStop=/usr/bin/docker compose -f /opt/llmspaghetti/docker-compose.yml down
ExecReload=/usr/bin/docker compose -f /opt/llmspaghetti/docker-compose.yml pull
StandardOutput=append:/opt/llmspaghetti/logs/stack.log
StandardError=append:/opt/llmspaghetti/logs/stack.log

[Install]
WantedBy=multi-user.target

---FILE---

# =============================================================================
# /etc/systemd/system/llmspaghetti-watchdog.service
#
# Checks service health every 60s and restarts anything that has failed.
# =============================================================================
[Unit]
Description=LLMSpaghetti Service Watchdog
After=llmspaghetti.service
ConditionPathExists=/opt/llmspaghetti/.firstboot-complete

[Service]
Type=simple
User=root
ExecStart=/usr/local/bin/llmspaghetti-watchdog
Restart=always
RestartSec=60

[Install]
WantedBy=multi-user.target

---FILE---

# =============================================================================
# /etc/systemd/system/llmspaghetti-update.service
# /etc/systemd/system/llmspaghetti-update.timer
#
# Weekly OTA update — pulls latest Docker images and restarts the stack.
# =============================================================================
[Unit]
Description=LLMSpaghetti Weekly Update
After=llmspaghetti.service

[Service]
Type=oneshot
User=llmspaghetti
WorkingDirectory=/opt/llmspaghetti
ExecStart=/usr/bin/docker compose -f /opt/llmspaghetti/docker-compose.yml pull
ExecStart=/usr/bin/docker compose -f /opt/llmspaghetti/docker-compose.yml up -d
StandardOutput=append:/opt/llmspaghetti/logs/update.log

---

[Unit]
Description=LLMSpaghetti Weekly Update Timer

[Timer]
OnCalendar=weekly
Persistent=true
RandomizedDelaySec=1h

[Install]
WantedBy=timers.target
