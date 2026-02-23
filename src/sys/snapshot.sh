#!/bin/bash
# System context snapshot for Idle Hands (Phase 9)
# Usage: snapshot.sh [scope]
# Scope: all | services | network | disk | packages
# Target: <500 tokens for full scope, <100 tokens per individual scope, <2s to collect

set -euo pipefail
SCOPE="${1:-all}"

collect_os() {
  echo "OS: $(cat /etc/os-release 2>/dev/null | grep '^PRETTY_NAME' | cut -d'"' -f2 || uname -s) ($(uname -m))"
  echo "Kernel: $(uname -r)"
  echo "Hostname: $(hostname)"
  echo "Uptime: $(uptime -p 2>/dev/null | sed 's/^up //' || echo 'unknown')"
  # CPU
  local cpus
  cpus=$(nproc 2>/dev/null || echo '?')
  local model
  model=$(grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2 | xargs || echo 'unknown')
  echo "CPU: ${model} (${cpus} cores)"
  # RAM
  if command -v free &>/dev/null; then
    local total avail
    total=$(free -h | awk '/^Mem:/{print $2}')
    avail=$(free -h | awk '/^Mem:/{print $7}')
    echo "RAM: ${total} (${avail} available)"
  fi
}

collect_disk() {
  if command -v df &>/dev/null; then
    echo "Disk:"
    df -h --output=target,size,used,avail,pcent / /home 2>/dev/null | tail -n +2 | while read -r mount size used avail pct; do
      echo "  ${mount} ${pct} of ${size} (${avail} free)"
    done
  fi
}

collect_network() {
  if command -v ip &>/dev/null; then
    echo "Network:"
    ip -br addr 2>/dev/null | grep -v '^lo ' | while read -r iface state addrs; do
      echo "  ${iface} ${state} ${addrs}"
    done
  fi
}

collect_services() {
  if command -v systemctl &>/dev/null; then
    echo "Services (active): $(systemctl list-units --state=active --type=service --no-legend --no-pager 2>/dev/null | awk '{print $1}' | sed 's/\.service$//' | head -20 | tr '\n' ', ' | sed 's/,$//')"
    local failed
    failed=$(systemctl list-units --state=failed --type=service --no-legend --no-pager 2>/dev/null | awk '{print $1}' | sed 's/\.service$//' | tr '\n' ', ' | sed 's/,$//')
    echo "Services (failed): ${failed:-none}"
  fi
}

collect_packages() {
  if command -v apt &>/dev/null; then
    local installed upgradable
    installed=$(dpkg -l 2>/dev/null | grep -c '^ii' || echo '?')
    upgradable=$(apt list --upgradable 2>/dev/null | grep -c 'upgradable' || echo '0')
    echo "Packages (apt): ${installed} installed, ${upgradable} upgradable"
  elif command -v dnf &>/dev/null; then
    local installed
    installed=$(dnf list installed 2>/dev/null | tail -n +2 | wc -l || echo '?')
    echo "Packages (dnf): ${installed} installed"
  elif command -v pacman &>/dev/null; then
    local installed
    installed=$(pacman -Q 2>/dev/null | wc -l || echo '?')
    echo "Packages (pacman): ${installed} installed"
  fi
  # Last boot
  if command -v who &>/dev/null; then
    echo "Last boot: $(who -b 2>/dev/null | awk '{print $3, $4}' || echo 'unknown')"
  fi
}

echo "[System context]"
case "$SCOPE" in
  all)
    collect_os
    collect_disk
    collect_network
    collect_services
    collect_packages
    ;;
  services) collect_services ;;
  network) collect_network ;;
  disk) collect_disk ;;
  packages) collect_packages ;;
  *)
    echo "Unknown scope: $SCOPE"
    echo "Valid scopes: all, services, network, disk, packages"
    exit 1
    ;;
esac
echo "[End system context]"
