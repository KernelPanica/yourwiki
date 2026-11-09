#!/bin/sh
set -eu
umask 077

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$root"
if [ ! -f compose.yaml ] || [ ! -f Dockerfile ]; then
 printf '%s\n' '[ERROR] install.sh must remain in the Yourwiki project root.' >&2
 exit 1
fi

build=1
setup=1
start=1
assume_yes=0
use_sudo=0
system_setup=1
configure_proxy=1
configure_swap=1
tls_email=${YOURWIKI_TLS_EMAIL:-}
public_tls=0
tls_ready=0

env_value() {
 if [ ! -f .env ]; then return 0; fi
 sed -n "s/^$1=//p" .env | tail -n 1
}

file_public_url=$(env_value YOURWIKI_PUBLIC_URL)
file_port=$(env_value YOURWIKI_PORT)
case $file_public_url in
 \'*\') file_public_url=${file_public_url#\'}; file_public_url=${file_public_url%\'} ;;
 \"*\") file_public_url=${file_public_url#\"}; file_public_url=${file_public_url%\"} ;;
esac
case $file_port in
 \'*\') file_port=${file_port#\'}; file_port=${file_port%\'} ;;
 \"*\") file_port=${file_port#\"}; file_port=${file_port%\"} ;;
esac
public_url=${YOURWIKI_PUBLIC_URL:-$file_public_url}
port=${YOURWIKI_PORT:-${file_port:-3000}}

usage() {
 cat <<'EOF'
Yourwiki server installer

Usage: ./install.sh [OPTIONS]

On Ubuntu, installs missing Docker/Compose/Nginx/Certbot packages, configures
swap on low-memory servers, prepares Nginx, checks DNS, obtains a TLS
certificate, builds the image, and starts the initialized workspace.
Only the initial administrator form requires browser input.

Options:
  --public-url URL    Public HTTPS origin, or a loopback HTTP origin
  --port PORT         Host port bound to 127.0.0.1 (default: 3000)
  --tls-email EMAIL   Email for the Let's Encrypt account (optional)
  --yes               Start services without a confirmation prompt
  --no-start          Build and initialize only
  --build-only        Build yourwiki:npm-local without changing the server
  --start-only        Configure and start an existing workspace
  --no-system-setup   Do not install OS packages or enable system services
  --no-proxy          Do not configure Nginx, DNS, TLS, or public HTTP checks
  --no-swap           Do not create swap on a low-memory server
  -h, --help          Show this help

Existing unrelated .env settings, including Collabora configuration, are kept.
Unrecognized existing Nginx virtual hosts are never overwritten.
EOF
}

while [ "$#" -gt 0 ]; do
 case $1 in
  --public-url)
   if [ "$#" -lt 2 ]; then printf '%s\n' '[ERROR] --public-url requires a value.' >&2; exit 1; fi
   public_url=$2; shift 2 ;;
  --port)
   if [ "$#" -lt 2 ]; then printf '%s\n' '[ERROR] --port requires a value.' >&2; exit 1; fi
   port=$2; shift 2 ;;
  --tls-email)
   if [ "$#" -lt 2 ]; then printf '%s\n' '[ERROR] --tls-email requires a value.' >&2; exit 1; fi
   tls_email=$2; shift 2 ;;
  --yes) assume_yes=1; shift ;;
  --no-start) start=0; shift ;;
  --build-only) build=1; setup=0; start=0; system_setup=0; configure_proxy=0; configure_swap=0; shift ;;
  --start-only) build=0; setup=0; start=1; shift ;;
  --no-system-setup) system_setup=0; shift ;;
  --no-proxy) configure_proxy=0; shift ;;
  --no-swap) configure_swap=0; shift ;;
  -h|--help) usage; exit 0 ;;
  *) printf '%s\n' "[ERROR] Unknown option: $1" >&2; usage >&2; exit 1 ;;
 esac
done

if [ "$setup" -eq 1 ] || [ "$start" -eq 1 ]; then
 case $port in
  ''|*[!0-9]*) printf '%s\n' '[ERROR] Port must be an integer from 1 to 65535.' >&2; exit 1 ;;
 esac
 if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
  printf '%s\n' '[ERROR] Port must be an integer from 1 to 65535.' >&2
  exit 1
 fi
 if [ -z "$public_url" ]; then public_url="http://127.0.0.1:$port"; fi
 public_url=${public_url%/}
 if ! printf '%s\n' "$public_url" | grep -Eq '^https://[^/@[:space:]?#]+(:[0-9]+)?$|^http://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?$'; then
  printf '%s\n' '[ERROR] Public URL must be an HTTPS origin without a path, or HTTP on localhost/127.0.0.1/[::1].' >&2
  exit 1
 fi
fi

public_domain=${public_url#https://}
if [ "$public_domain" != "$public_url" ] && [ "$public_url" = "https://$public_domain" ]; then
 case $public_domain in
  ''|*[!A-Za-z0-9.-]*) ;;
  *) public_tls=1 ;;
 esac
fi

as_root() {
 if [ "$(id -u)" -eq 0 ]; then "$@"; else
  if ! command -v sudo >/dev/null 2>&1; then
   printf '%s\n' '[ERROR] Root access or sudo is required for server setup.' >&2
   exit 1
  fi
  sudo "$@"
 fi
}

install_system_requirements() {
 if [ "$system_setup" -ne 1 ] || ! command -v apt-get >/dev/null 2>&1; then return 0; fi
 missing=0
 for name in docker nginx certbot curl; do
  if ! command -v "$name" >/dev/null 2>&1; then missing=1; fi
 done
 if command -v docker >/dev/null 2>&1 && ! docker compose version >/dev/null 2>&1; then missing=1; fi
 if [ "$missing" -eq 1 ]; then
  printf '%s\n' '[SETUP] Installing Docker, Compose, Nginx, Certbot, and utilities.'
  as_root apt-get update
  as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io docker-compose-v2 nginx certbot python3-certbot-nginx rsync curl
 fi
 if command -v systemctl >/dev/null 2>&1; then
  as_root systemctl enable --now docker nginx
 fi
}

configure_low_memory_swap() {
 if [ "$configure_swap" -ne 1 ] || [ "$system_setup" -ne 1 ] || [ ! -r /proc/meminfo ]; then return 0; fi
 memory_kb=$(awk '/^MemTotal:/{print $2}' /proc/meminfo)
 swap_kb=$(awk '/^SwapTotal:/{print $2}' /proc/meminfo)
 case $memory_kb in ''|*[!0-9]*) return 0 ;; esac
 case $swap_kb in ''|*[!0-9]*) return 0 ;; esac
 if [ "$memory_kb" -ge 3145728 ] || [ "$swap_kb" -ge 1048576 ]; then return 0; fi
 printf '%s\n' '[SETUP] Low memory detected; configuring a persistent 2 GiB swap file.'
 if [ ! -f /swapfile ]; then
  as_root fallocate -l 2G /swapfile
  as_root chmod 600 /swapfile
  as_root mkswap /swapfile
 fi
 if ! swapon --show=NAME --noheadings | grep -qx /swapfile; then as_root swapon /swapfile; fi
 if ! as_root grep -qE '^/swapfile[[:space:]]' /etc/fstab; then
  printf '/swapfile none swap sw 0 0\n' | as_root tee -a /etc/fstab >/dev/null
 fi
}

install_system_requirements
configure_low_memory_swap

if ! command -v docker >/dev/null 2>&1; then
 printf '%s\n' '[ERROR] Docker Engine with the Compose plugin is required.' >&2
 exit 1
fi
if ! docker info >/dev/null 2>&1; then
 if ! command -v sudo >/dev/null 2>&1; then
  printf '%s\n' '[ERROR] Docker is not accessible. Configure Docker permissions or install sudo.' >&2
  exit 1
 fi
 printf '%s\n' '[INFO] Docker requires elevated access; sudo may ask for your password.'
 if ! sudo docker info >/dev/null; then
  printf '%s\n' '[ERROR] Docker daemon access failed. No project data was changed.' >&2
  exit 1
 fi
 use_sudo=1
fi

docker_cmd() {
 if [ "$use_sudo" -eq 1 ]; then sudo docker "$@"; else docker "$@"; fi
}
if ! docker_cmd compose version >/dev/null 2>&1; then
 printf '%s\n' '[ERROR] Docker Compose v2 is required (docker compose).' >&2
 exit 1
fi

write_configuration() {
 if [ -L .env ] || { [ -e .env ] && [ ! -f .env ]; }; then
  printf '%s\n' '[ERROR] .env must be a regular file, not a symlink or directory.' >&2
  exit 1
 fi
 temporary=".env.install.$$"
 (set -C; : > "$temporary")
 trap 'rm -f "$temporary"' EXIT HUP INT TERM
 if [ -f .env ]; then
  while IFS= read -r line || [ -n "$line" ]; do
   case $line in
    YOURWIKI_PUBLIC_URL=*|YOURWIKI_PORT=*) ;;
    *) printf '%s\n' "$line" ;;
   esac
  done < .env > "$temporary"
 fi
 printf 'YOURWIKI_PUBLIC_URL=%s\nYOURWIKI_PORT=%s\n' "$public_url" "$port" >> "$temporary"
 chmod 600 "$temporary"
 mv "$temporary" .env
 trap - EXIT HUP INT TERM
 export YOURWIKI_PUBLIC_URL="$public_url" YOURWIKI_PORT="$port"
 printf '%s\n' "[OK] Configuration saved to .env ($public_url, port $port)."
}

dns_matches_server() {
 if ! command -v getent >/dev/null 2>&1; then return 1; fi
 dns_addresses=$(getent ahostsv4 "$public_domain" 2>/dev/null | awk '{print $1}' | sort -u)
 if [ -z "$dns_addresses" ]; then return 1; fi
 for local_address in $(hostname -I 2>/dev/null); do
  for dns_address in $dns_addresses; do
   if [ "$local_address" = "$dns_address" ]; then return 0; fi
  done
 done
 return 1
}

configure_public_proxy() {
 if [ "$configure_proxy" -ne 1 ] || [ "$public_tls" -ne 1 ]; then return 0; fi
 if ! command -v nginx >/dev/null 2>&1 || ! command -v certbot >/dev/null 2>&1; then
  printf '%s\n' '[WARN] Nginx/Certbot are unavailable; configure the public proxy manually.' >&2
  return 0
 fi
 printf '%s\n' "[SETUP] Configuring Nginx for $public_domain."
 as_root install -D -m 644 docker/nginx-location.conf /etc/nginx/snippets/yourwiki.conf
 site=/etc/nginx/sites-available/yourwiki
 if [ -e "$site" ]; then
  if ! as_root grep -q "server_name $public_domain" "$site" || ! as_root grep -q 'include /etc/nginx/snippets/yourwiki.conf' "$site"; then
   printf '%s\n' "[WARN] $site has an unrecognized configuration; leaving it unchanged. Configure it manually for $public_domain." >&2
   return 0
  fi
 else
  as_root tee "$site" >/dev/null <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $public_domain;
    include /etc/nginx/snippets/yourwiki.conf;
}
EOF
 fi
 as_root ln -sfn /etc/nginx/sites-available/yourwiki /etc/nginx/sites-enabled/yourwiki
 as_root nginx -t
 as_root systemctl reload nginx
 if ! dns_matches_server; then
  printf '%s\n' "[WARN] DNS for $public_domain does not match this server's addresses. TLS was not changed; fix DNS and rerun ./install.sh --start-only." >&2
  return 0
 fi
 printf '%s\n' '[SETUP] DNS matches this server; requesting or renewing the TLS certificate.'
 if [ -n "$tls_email" ]; then
  as_root certbot --nginx -d "$public_domain" --noninteractive --agree-tos --email "$tls_email" --redirect --keep-until-expiring
 else
  as_root certbot --nginx -d "$public_domain" --noninteractive --agree-tos --register-unsafely-without-email --redirect --keep-until-expiring
 fi
 as_root nginx -t
 as_root systemctl reload nginx
 tls_ready=1
 printf '%s\n' '[OK] Nginx and HTTPS are configured. Certbot renewal is installed by the package.'
}

if [ "$setup" -eq 1 ] || [ "$start" -eq 1 ]; then
 printf '%s\n' '[1/4] Saving deployment configuration.'
 write_configuration
 configure_public_proxy
fi

if [ "$build" -eq 1 ]; then
 if [ "$setup" -eq 1 ]; then printf '%s\n' '[2/4] Building the production image. This can take several minutes.'
 else printf '%s\n' '[BUILD] Building the production image. This can take several minutes.'
 fi
 docker_cmd compose build
 printf '%s\n' '[OK] Built yourwiki:npm-local.'
fi

stop_setup_containers() {
 setup_ids=$(docker_cmd compose ps -aq setup 2>/dev/null || true)
 if [ -n "$setup_ids" ]; then docker_cmd stop $setup_ids >/dev/null 2>&1 || true; fi
}

if [ "$setup" -eq 1 ]; then
 if docker_cmd compose ps --status running --services 2>/dev/null | grep -Eq '^(web|provider|conversion)$'; then
  printf '%s\n' '[ERROR] Runtime services are running. Stop them before setup; existing data will not be overwritten.' >&2
  exit 1
 fi
 printf '%s\n' '[3/4] Opening the browser-based workspace installer.'
 printf '%s\n' 'Open the one-time URL printed below, then choose New workspace, Migration, or Restore.'
 printf '%s\n' 'After the browser reports success, return here and press Ctrl+C to stop the installer.'
 setup_status=0
 trap 'setup_status=130' INT
 docker_cmd compose run --rm --service-ports setup || setup_status=$?
 trap - INT
 stop_setup_containers
 if [ "$setup_status" -ne 0 ] && [ "$setup_status" -ne 130 ]; then
  printf '%s\n' '[ERROR] The workspace installer stopped before completion.' >&2
  exit 1
 fi
 if ! docker_cmd compose run --rm --no-deps --entrypoint sh setup -c 'test -f /data/workspace/database.sqlite3 && test -f /data/workspace/encryption.key && test -f /data/workspace/installation.json'; then
  printf '%s\n' '[ERROR] No complete workspace was found. Runtime services were not started; rerun ./install.sh to finish setup.' >&2
  exit 1
 fi
 printf '%s\n' '[OK] Workspace initialized. Existing data was not overwritten.'
fi

wait_for_readiness() {
 attempt=0
 while [ "$attempt" -lt 60 ]; do
  if docker_cmd compose exec -T web node -e "fetch('http://127.0.0.1:3100/ready/').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" >/dev/null 2>&1; then return 0; fi
  attempt=$((attempt+1))
  sleep 2
 done
 return 1
}

if [ "$start" -eq 1 ]; then
 if [ "$assume_yes" -ne 1 ]; then
  printf 'Start Yourwiki at %s now? [Y/n] ' "$public_url"
  answer=''
  read -r answer || answer=n
  case $answer in
   ''|y|Y|yes|YES|Yes) ;;
   *) printf '%s\n' 'Setup complete. Start later with ./install.sh --start-only.'; exit 0 ;;
  esac
 fi
 printf '%s\n' '[4/4] Starting web, provider, and conversion.'
 docker_cmd compose up -d web provider conversion
 printf '%s\n' 'Waiting for the application readiness check.'
 if ! wait_for_readiness; then
  printf '%s\n' '[WARN] Readiness failed; recreating services once to repair stale container networking.' >&2
  docker_cmd compose up -d --force-recreate web provider conversion
  if ! wait_for_readiness; then
   printf '%s\n' '[ERROR] Yourwiki is not ready. Check docker compose ps and docker compose logs.' >&2
   exit 1
  fi
 fi
 if [ "$tls_ready" -eq 1 ]; then
  if ! curl -fsS --max-time 20 "$public_url/ready/" >/dev/null; then
   printf '%s\n' '[ERROR] Yourwiki is ready internally, but the public HTTPS check failed. Check Nginx and DNS.' >&2
   exit 1
  fi
 fi
 printf '%s\n' "[OK] Yourwiki is ready: $public_url"
 printf '%s\n' 'Keep the workspace volume and its encryption key in protected backups.'
else
 printf '%s\n' '[OK] Installation files are ready. Start later with ./install.sh --start-only.'
fi
