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
collabora=1
collabora_enabled=0
rclone_drive=1
runtime_compose=0
tls_email=${YOURWIKI_TLS_EMAIL:-}
public_tls=0
tls_ready=0

env_value() {
 if [ ! -f .env ]; then return 0; fi
 sed -n "s/^$1=//p" .env | tail -n 1
}

file_public_url=$(env_value YOURWIKI_PUBLIC_URL)
file_port=$(env_value YOURWIKI_PORT)
file_transport=$(env_value YOURWIKI_DRIVE_TRANSPORT)
case ${YOURWIKI_DRIVE_TRANSPORT:-$file_transport} in api|"'api'"|'"api"') rclone_drive=0 ;; esac
rclone_data=${YOURWIKI_RCLONE_DATA:-$(env_value YOURWIKI_RCLONE_DATA)}
rclone_runtime=${YOURWIKI_RCLONE_RUNTIME:-$(env_value YOURWIKI_RCLONE_RUNTIME)}
for setting in data runtime; do
 if [ "$setting" = data ]; then value=$rclone_data; else value=$rclone_runtime; fi
 case $value in \'*\') value=${value#\'}; value=${value%\'} ;; \"*\") value=${value#\"}; value=${value%\"} ;; esac
 # Values are assigned as data; never evaluate environment-file contents.
 if [ "$setting" = data ]; then rclone_data=${value:-/var/lib/yourwiki/rclone}; else rclone_runtime=${value:-/var/lib/yourwiki/rclone-runtime}; fi
done
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

On Ubuntu/Debian, installs missing Docker/Compose/Nginx/Certbot packages, configures
swap on low-memory servers, prepares Nginx, checks DNS, obtains a TLS
certificate, builds the image, configures Collabora on public HTTPS domains,
and starts the initialized workspace. Only the initial administrator form
requires browser input.

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
  --no-collabora      Do not install or start Collabora Online
  --rclone            Enable containerized rclone (Linux, local rootful Docker, FUSE)
  --no-rclone         Use the Google API adapter instead of the default rclone transport
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
  --no-collabora) collabora=0; shift ;;
  --rclone) rclone_drive=1; shift ;;
  --no-rclone) rclone_drive=0; shift ;;
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
if [ "$collabora" -eq 1 ] && [ "$public_tls" -eq 1 ]; then collabora_enabled=1; fi

as_root() {
 if [ "$(id -u)" -eq 0 ]; then
  "$@"
  return $?
 fi
 if ! command -v sudo >/dev/null 2>&1; then
  printf '%s\n' '[ERROR] Root access or sudo is required for server setup.' >&2
  exit 1
 fi
 sudo "$@"
}

configure_docker_compose_repository() {
 os_id=$(sed -n 's/^ID=//p' /etc/os-release | tr -d '\042\047')
 os_codename=$(sed -n 's/^VERSION_CODENAME=//p' /etc/os-release | tr -d '\042\047')
 case $os_id in ubuntu|debian) ;; *) printf '%s\n' '[ERROR] Install Docker Compose on this distribution manually, then rerun ./install.sh.' >&2; exit 1 ;; esac
 case $os_codename in ''|*[!a-z0-9]*) printf '%s\n' '[ERROR] Cannot determine the distribution release for the Docker APT repository.' >&2; exit 1 ;; esac
 architecture=$(dpkg --print-architecture)
 case $architecture in amd64|arm64|armhf|ppc64el|s390x) ;; *) printf '%s\n' '[ERROR] Install Docker Compose manually for this CPU architecture.' >&2; exit 1 ;; esac
 printf '%s\n' '[SETUP] Compose is absent from system repositories; adding the signed official Docker repository.'
 as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl
 as_root install -d -m 755 /etc/apt/keyrings
 key_file=$(mktemp)
 if ! curl -fsSL "https://download.docker.com/linux/$os_id/gpg" -o "$key_file"; then rm -f "$key_file"; printf '%s\n' '[ERROR] Could not download the official Docker repository key.' >&2; exit 1; fi
 if ! as_root install -m 644 "$key_file" /etc/apt/keyrings/yourwiki-docker.asc; then rm -f "$key_file"; exit 1; fi
 rm -f "$key_file"
 printf 'Types: deb\nURIs: https://download.docker.com/linux/%s\nSuites: %s\nComponents: stable\nArchitectures: %s\nSigned-By: /etc/apt/keyrings/yourwiki-docker.asc\n' "$os_id" "$os_codename" "$architecture" | as_root tee /etc/apt/sources.list.d/yourwiki-docker.sources >/dev/null
 as_root apt-get update
 if ! apt-cache show docker-compose-plugin >/dev/null 2>&1; then printf '%s\n' '[ERROR] Docker Compose is unavailable for this distribution/release. Install it manually before retrying.' >&2; exit 1; fi
}

install_system_requirements() {
 if [ "$system_setup" -ne 1 ]; then return 0; fi
 packages=''
 if ! command -v apt-get >/dev/null 2>&1; then
  printf '%s\n' '[INFO] Automatic packages are supported on Debian/Ubuntu. Existing Docker/Compose can be used on other Linux distributions.'
  return 0
 fi
 if ! command -v docker >/dev/null 2>&1; then packages="$packages docker.io"; fi
 need_compose=0
 if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then need_compose=1; fi
 if [ "$configure_proxy" -eq 1 ] && [ "$public_tls" -eq 1 ]; then
  if ! command -v nginx >/dev/null 2>&1; then packages="$packages nginx"; fi
  if ! command -v certbot >/dev/null 2>&1; then packages="$packages certbot python3-certbot-nginx"; fi
  if ! command -v curl >/dev/null 2>&1; then packages="$packages curl ca-certificates"; fi
 fi
 if [ -n "$packages" ] || [ "$need_compose" -eq 1 ]; then
  printf '%s\n' '[SETUP] Installing missing server prerequisites.'
  as_root apt-get update
  if [ "$need_compose" -eq 1 ]; then
   if apt-cache show docker-compose-v2 >/dev/null 2>&1; then packages="$packages docker-compose-v2"
   elif apt-cache show docker-compose-plugin >/dev/null 2>&1; then packages="$packages docker-compose-plugin"
   else
    configure_docker_compose_repository
    packages="$packages docker-compose-plugin"
   fi
  fi
  # Package names are fixed above, never supplied by the caller.
  as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $packages
 fi
 if command -v systemctl >/dev/null 2>&1 && systemctl show-environment >/dev/null 2>&1; then
  as_root systemctl enable --now docker
  if [ "$configure_proxy" -eq 1 ] && [ "$public_tls" -eq 1 ] && command -v nginx >/dev/null 2>&1; then as_root systemctl enable --now nginx; fi
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
  as_root fallocate -l 2G /swapfile || return 1
  as_root chmod 600 /swapfile || return 1
  as_root mkswap /swapfile || return 1
 fi
 if ! swapon --show=NAME --noheadings | grep -qx /swapfile; then as_root swapon /swapfile || return 1; fi
 if ! as_root grep -qE '^/swapfile[[:space:]]' /etc/fstab; then
  printf '/swapfile none swap sw 0 0\n' | as_root tee -a /etc/fstab >/dev/null
 fi
}

install_system_requirements
if ! configure_low_memory_swap; then
 printf '%s\n' '[WARN] Swap could not be enabled on this host. Installation continues; ensure sufficient RAM or configure swap manually.' >&2
fi

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
compose_cmd() {
 if [ "$runtime_compose" -eq 1 ] && [ "$rclone_drive" -eq 1 ]; then
  if [ "$collabora_enabled" -eq 1 ]; then docker_cmd compose -f compose.yaml -f compose.rclone.yaml -f compose.collabora.yaml "$@"
  else docker_cmd compose -f compose.yaml -f compose.rclone.yaml "$@"; fi
 elif [ "$collabora_enabled" -eq 1 ]; then docker_cmd compose -f compose.yaml -f compose.collabora.yaml "$@"
 else docker_cmd compose -f compose.yaml "$@"; fi
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
    YOURWIKI_PUBLIC_URL=*|YOURWIKI_PORT=*|YOURWIKI_DRIVE_TRANSPORT=*|YOURWIKI_RCLONE_DATA=*|YOURWIKI_RCLONE_RUNTIME=*|COMPOSE_FILE=*) ;;
    COLLABORA_URL=*|COLLABORA_WOPI_URL=*) if [ "$collabora_enabled" -eq 0 ]; then printf '%s\n' "$line"; fi ;;
    *) printf '%s\n' "$line" ;;
   esac
  done < .env > "$temporary"
 fi
 drive_transport=api
 if [ "$rclone_drive" -eq 1 ]; then drive_transport=rclone; fi
 printf 'YOURWIKI_PUBLIC_URL=%s\nYOURWIKI_PORT=%s\nYOURWIKI_DRIVE_TRANSPORT=%s\n' "$public_url" "$port" "$drive_transport" >> "$temporary"
 printf "YOURWIKI_RCLONE_DATA='%s'\nYOURWIKI_RCLONE_RUNTIME='%s'\n" "$rclone_data" "$rclone_runtime" >> "$temporary"
 if [ "$collabora_enabled" -eq 1 ]; then
  printf 'COLLABORA_URL=%s/collabora\nCOLLABORA_WOPI_URL=%s\n' "$public_url" "$public_url" >> "$temporary"
 fi
 compose_files=compose.yaml
 if [ "$rclone_drive" -eq 1 ]; then compose_files="$compose_files:compose.rclone.yaml"; fi
 if [ "$collabora_enabled" -eq 1 ]; then compose_files="$compose_files:compose.collabora.yaml"; fi
 printf 'COMPOSE_FILE=%s\n' "$compose_files" >> "$temporary"
 chmod 600 "$temporary"
 mv "$temporary" .env
 trap - EXIT HUP INT TERM
 export YOURWIKI_PUBLIC_URL="$public_url" YOURWIKI_PORT="$port" YOURWIKI_DRIVE_TRANSPORT="$drive_transport"
 printf '%s\n' "[OK] Configuration saved to .env ($public_url, port $port)."
}

rclone_preflight() {
 if [ "$rclone_drive" -eq 0 ] || [ "$start" -eq 0 ]; then return 0; fi
 if [ "$(uname -s)" != Linux ]; then
  printf '%s\n' '[ERROR] rclone mounts require a Linux host. Use --no-rclone for the API transport.' >&2; exit 1
 fi
 endpoint=${DOCKER_HOST:-$(docker_cmd context inspect --format '{{(index .Endpoints "docker").Host}}')}
 case $endpoint in unix://*|'') ;; *) printf '%s\n' '[ERROR] rclone requires a local Docker daemon. Use --no-rclone for remote Docker.' >&2; exit 1 ;; esac
 if docker_cmd info --format '{{json .SecurityOptions}} {{.OperatingSystem}}' | grep -Eiq 'rootless|userns|docker desktop'; then
  printf '%s\n' '[ERROR] FUSE sharing requires rootful native Linux Docker without user namespace remapping. Use --no-rclone on this Docker configuration.' >&2; exit 1
 fi
 for utility in mount mountpoint findmnt; do
  if ! command -v "$utility" >/dev/null 2>&1; then printf '%s\n' "[ERROR] Missing Linux utility $utility (util-linux). Install it or use --no-rclone." >&2; exit 1; fi
 done
 if ! as_root test -c /dev/fuse; then
  if command -v modprobe >/dev/null 2>&1; then as_root modprobe fuse || true; fi
  if ! as_root test -c /dev/fuse; then printf '%s\n' '[ERROR] /dev/fuse is unavailable. Enable FUSE on the host/VPS or rerun with --no-rclone.' >&2; exit 1; fi
 fi
}
validate_rclone_paths() {
 for path in "$rclone_data" "$rclone_runtime"; do
  case $path in /|/etc|/usr|/home|/var|/var/lib|/root|/data|/run|/tmp|*/../*|*/..|*/./*|*/.) printf '%s\n' '[ERROR] Choose dedicated absolute rclone data/runtime directories.' >&2; exit 1 ;; esac
  if ! printf '%s' "$path" | grep -Eq '^/[A-Za-z0-9_./ -]+$'; then printf '%s\n' '[ERROR] rclone directories must be absolute paths using letters, numbers, spaces, dash, underscore or dot.' >&2; exit 1; fi
 done
 case "$rclone_data/" in "$rclone_runtime/"*) printf '%s\n' '[ERROR] rclone data and runtime directories must not overlap.' >&2; exit 1 ;; esac
 case "$rclone_runtime/" in "$rclone_data/"*) printf '%s\n' '[ERROR] rclone data and runtime directories must not overlap.' >&2; exit 1 ;; esac
}
prepare_rclone_supervisor() {
 if [ "$rclone_drive" -eq 0 ]; then return 0; fi
 printf '%s\n' '[SETUP] Preparing rclone shared storage after workspace initialization.'
 as_root install -d -m 700 -o 10001 -g 10001 "$rclone_data" "$rclone_runtime"
 if ! as_root mountpoint -q "$rclone_data"; then
  if ! as_root mount --bind "$rclone_data" "$rclone_data"; then printf '%s\n' '[ERROR] This host does not allow shared bind mounts. Enable mount privileges or use --no-rclone.' >&2; exit 1; fi
 fi
 if ! as_root mount --make-rshared "$rclone_data"; then printf '%s\n' '[ERROR] Could not enable FUSE mount propagation. Use --no-rclone on restricted VPS/container hosts.' >&2; exit 1; fi
 if ! as_root findmnt -n -o PROPAGATION -T "$rclone_data" | grep -q shared; then printf '%s\n' '[ERROR] rclone storage is not a shared mount.' >&2; exit 1; fi
 # Persist only this dedicated self bind; never mount or access Docker internals.
 fstab_path=$(printf '%s' "$rclone_data" | sed 's/ /\\040/g')
 if ! as_root grep -qF " $fstab_path " /etc/fstab; then
  printf '%s %s none bind,rshared 0 0\n' "$fstab_path" "$fstab_path" | as_root tee -a /etc/fstab >/dev/null
 fi
 runtime_compose=1
}

stop_previous_rclone_supervisor() {
 # Migrate only a previous host unit belonging to this checkout.
 if command -v systemctl >/dev/null 2>&1 && as_root test -f /etc/systemd/system/yourwiki-rclone-drive.service && as_root grep -Fq "$root/apps/server/src/rclone/manager-main.ts" /etc/systemd/system/yourwiki-rclone-drive.service; then
  as_root systemctl disable --now yourwiki-rclone-drive
 fi
 if [ "$rclone_drive" -eq 0 ]; then
  previous_ids=$(docker_cmd compose -f compose.yaml -f compose.rclone.yaml ps -aq rclone 2>/dev/null || true)
  if [ -n "$previous_ids" ]; then docker_cmd compose -f compose.yaml -f compose.rclone.yaml stop rclone; fi
 fi
}

rclone_preflight
if [ "$setup" -eq 1 ] || [ "$start" -eq 1 ]; then validate_rclone_paths; fi

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

reload_nginx() {
 if command -v systemctl >/dev/null 2>&1 && systemctl show-environment >/dev/null 2>&1; then as_root systemctl reload nginx
 elif ! as_root nginx -s reload; then as_root nginx; fi
}

configure_public_proxy() {
 if [ "$configure_proxy" -ne 1 ] || [ "$public_tls" -ne 1 ]; then return 0; fi
 if ! command -v nginx >/dev/null 2>&1 || ! command -v certbot >/dev/null 2>&1; then
  printf '%s\n' '[WARN] Nginx/Certbot are unavailable; configure the public proxy manually.' >&2
  return 0
 fi
 printf '%s\n' "[SETUP] Configuring Nginx for $public_domain."
 site=/etc/nginx/sites-available/yourwiki
 nginx_sites=1
 if ! as_root test -d /etc/nginx/sites-available; then
  nginx_sites=0
  as_root install -d -m 755 /etc/nginx/conf.d
  site=/etc/nginx/conf.d/yourwiki.conf
 fi
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
 as_root install -d -m 755 /etc/nginx/snippets
 sed "s/127.0.0.1:3000/127.0.0.1:$port/g" docker/nginx-location.conf | as_root tee /etc/nginx/snippets/yourwiki.conf >/dev/null
 if [ "$collabora_enabled" -eq 1 ]; then
  as_root install -D -m 644 docker/nginx-collabora.conf /etc/nginx/snippets/yourwiki-collabora.conf
  if ! as_root grep -q 'include /etc/nginx/snippets/yourwiki-collabora.conf' "$site"; then
   as_root sed -i '/include \/etc\/nginx\/snippets\/yourwiki.conf;/a\    include /etc/nginx/snippets/yourwiki-collabora.conf;' "$site"
  fi
 fi
 if [ "$nginx_sites" -eq 1 ]; then as_root ln -sfn /etc/nginx/sites-available/yourwiki /etc/nginx/sites-enabled/yourwiki; fi
 as_root nginx -t
 reload_nginx
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
 reload_nginx
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
 compose_cmd build web
 printf '%s\n' '[OK] Built yourwiki:npm-local.'
fi

stop_setup_containers() {
 setup_ids=$(docker_cmd compose -f compose.yaml ps -aq setup 2>/dev/null || true)
 if [ -n "$setup_ids" ]; then docker_cmd stop $setup_ids >/dev/null 2>&1 || true; fi
}

workspace_state=0
if [ "$setup" -eq 1 ] || [ "$start" -eq 1 ]; then
 docker_cmd compose -f compose.yaml run --rm --no-deps --entrypoint sh setup -c 'if test -f /data/workspace/database.sqlite3 && test -f /data/workspace/encryption.key && test -f /data/workspace/installation.json; then exit 0; fi; if test -e /data/workspace || test -L /data/workspace; then printf "%s\n" "[BLOCKED] Incomplete /data/workspace exists."; exit 2; fi; existing=$(find /data -mindepth 1 -maxdepth 1 ! -name release.lock -print) || exit 3; if test -n "$existing"; then printf "%s\n" "[BLOCKED] Existing entries in the data volume:" "$existing"; exit 2; fi; exit 1' || workspace_state=$?
 case $workspace_state in
  0) printf '%s\n' '[OK] Existing workspace found; setup will not overwrite it.'; setup=0 ;;
  1) if [ "$setup" -eq 0 ]; then printf '%s\n' '[ERROR] No complete workspace exists. Run ./install.sh without --start-only to initialize it.' >&2; exit 1; fi ;;
  2) printf '%s\n' '[ERROR] The volume contains existing data or an incomplete workspace (listed above). Inspect or restore it before setup; nothing was deleted or overwritten.' >&2; exit 1 ;;
  *) printf '%s\n' '[ERROR] Could not inspect the workspace. Check Docker access, image and volume permissions.' >&2; exit 1 ;;
 esac
fi
if [ "$setup" -eq 1 ]; then
 if docker_cmd compose -f compose.yaml ps --status running --services 2>/dev/null | grep -Eq '^(web|provider|conversion)$'; then
  printf '%s\n' '[ERROR] Runtime services are running without a complete workspace. Check Docker volumes before initializing.' >&2; exit 1
 fi
 printf '%s\n' '[3/4] Opening the browser-based workspace installer.'
 printf '%s\n' 'Open the one-time URL printed below, then choose New workspace, Migration, or Restore.'
 printf '%s\n' "For a remote server use: ssh -L $port:127.0.0.1:$port user@server"
 printf '%s\n' 'After the browser reports success, return here and press Ctrl+C to stop the installer.'
 setup_status=0
 trap 'setup_status=130' INT
 docker_cmd compose -f compose.yaml run --rm --service-ports setup || setup_status=$?
 trap - INT
 stop_setup_containers
 if [ "$setup_status" -ne 0 ] && [ "$setup_status" -ne 130 ]; then printf '%s\n' '[ERROR] The workspace installer stopped before completion.' >&2; exit 1; fi
 if ! docker_cmd compose -f compose.yaml run --rm --no-deps --entrypoint sh setup -c 'test -f /data/workspace/database.sqlite3 && test -f /data/workspace/encryption.key && test -f /data/workspace/installation.json'; then
  printf '%s\n' '[ERROR] No complete workspace was found. Runtime services were not started; rerun ./install.sh to finish setup.' >&2; exit 1
 fi
 printf '%s\n' '[OK] Workspace initialized. Existing data was not overwritten.'
fi
if [ "$start" -eq 1 ]; then stop_previous_rclone_supervisor; prepare_rclone_supervisor; fi

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
 services='web provider conversion'
 if [ "$rclone_drive" -eq 1 ]; then services="rclone $services"; fi
 if [ "$collabora_enabled" -eq 1 ]; then services="$services collabora"; fi
 printf '%s\n' "[4/4] Starting $services."
 compose_cmd up -d $services
 printf '%s\n' 'Waiting for the application readiness check.'
 if ! wait_for_readiness; then
  printf '%s\n' '[WARN] Readiness failed; recreating services once to repair stale container networking.' >&2
  compose_cmd up -d --force-recreate $services
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
  if [ "$collabora_enabled" -eq 1 ] && ! curl -fsS --max-time 30 "$public_url/collabora/hosting/discovery" >/dev/null; then
   printf '%s\n' '[ERROR] Yourwiki is ready, but Collabora discovery failed. Check the collabora container and Nginx.' >&2
   exit 1
  fi
 fi
 printf '%s\n' "[OK] Yourwiki is ready: $public_url"
 printf '%s\n' 'Keep the workspace volume and its encryption key in protected backups.'
else
 printf '%s\n' '[OK] Installation files are ready. Start later with ./install.sh --start-only.'
fi
