#!/bin/zsh

set -euo pipefail
umask 077

server="${PUNKLABZ_SERVER:-root@135.181.84.191}"
destination="/etc/punklabz"

typeset x_app_key x_app_secret x_access_token x_access_secret answer

clear_secrets() {
  unset x_app_key x_app_secret x_access_token x_access_secret
}
trap clear_secrets EXIT INT TERM

read_secret() {
  local label="$1"
  local variable="$2"
  local value

  IFS= read -rs "value?${label}: "
  print
  if [[ -z "$value" ]]; then
    print -u2 "${label} cannot be blank. Nothing was installed."
    exit 1
  fi
  typeset -g "$variable=$value"
  unset value
}

upload_secret() {
  local filename="$1"
  local value="$2"

  print -rn -- "$value" | ssh "$server" \
    "set -e; temporary=\$(mktemp ${destination}/.${filename}.XXXXXX); \
     trap 'rm -f \"\$temporary\"' EXIT; \
     dd of=\"\$temporary\" status=none; \
     chown root:root \"\$temporary\"; chmod 600 \"\$temporary\"; \
     mv \"\$temporary\" ${destination}/${filename}; trap - EXIT"
}

print "PunkLabz X credential installer"
print "Values are hidden and are sent only to ${server}."
print "Use OAuth 1.0a Access Token and Secret, not an OAuth 2.0 refresh token."
print "Press Ctrl-C to cancel."
print

read_secret "API Key (Consumer Key)" x_app_key
read_secret "API Key Secret (Consumer Secret)" x_app_secret
read_secret "OAuth 1.0a Access Token" x_access_token
read_secret "OAuth 1.0a Access Token Secret" x_access_secret

print
print "Destination: ${server}:${destination}/"
IFS= read -r "answer?Install four credentials on production? [y/N]: "
if [[ "$answer" != [yY] ]]; then
  print "Cancelled. Nothing was transmitted."
  exit 1
fi

upload_secret x-app-key "$x_app_key"
upload_secret x-app-secret "$x_app_secret"
upload_secret x-access-token "$x_access_token"
upload_secret x-access-secret "$x_access_secret"

print "Installed four root-owned credential files. Secrets were not echoed."
