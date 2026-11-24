#!/bin/sh
# Install the Jira mod into the current user's Herdr app config.
#   mods/jira/         -> ~/.config/herdr-app/mods/jira/  (replaced on every run)
#   jira.example.json  -> ~/.config/herdr-app/jira.json   (only if missing)
set -eu

src_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
config_dir="${HOME:?HOME is not set}/.config/herdr-app"
mod_dir="$config_dir/mods/jira"
settings="$config_dir/jira.json"

if [ ! -f "$src_dir/mods/jira/mod.json" ]; then
  echo "install.sh: $src_dir/mods/jira/mod.json not found; run this from the repo" >&2
  exit 1
fi

mkdir -p "$config_dir/mods"
rm -rf "$mod_dir"
cp -R "$src_dir/mods/jira" "$mod_dir"
echo "Installed mod to $mod_dir"

if [ -e "$settings" ]; then
  echo "Kept existing settings at $settings"
else
  cp "$src_dir/jira.example.json" "$settings"
  echo "Wrote example settings to $settings: edit base_url, token_cmd and token_on"
fi

if command -v herdr-app >/dev/null 2>&1; then
  herdr-app check "$mod_dir"
else
  echo "herdr-app not on PATH; skipped 'herdr-app check'"
fi
