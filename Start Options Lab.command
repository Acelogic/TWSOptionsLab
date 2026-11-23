#!/bin/sh
# Double-click on macOS or run from a POSIX shell in a source checkout.
set -eu
project_dir=$(CDPATH= cd -P -- "$(dirname -- "$0")" && pwd)
cd "$project_dir"

web_port=18762
show_page=1
read_options() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --no-open) show_page=0 ;;
      --port|--tws-port|--data-dir)
        flag=$1
        shift
        if [ "$#" -eq 0 ]; then echo "$flag needs a value." >&2; exit 2; fi
        if [ "$flag" = --port ]; then web_port=$1; fi
        ;;
      --help|-h)
        echo 'Start Options Lab.command [--port WEB_PORT] [--tws-port TWS_PORT] [--data-dir DIRECTORY] [--no-open]'
        exit 0
        ;;
      *) echo "Unknown option: $1" >&2; exit 2 ;;
    esac
    shift
  done
}
read_options "$@"
case "$web_port" in ''|*[!0-9]*) echo 'Use a numeric web port.' >&2; exit 2 ;; esac
if [ "$web_port" -lt 1 ] || [ "$web_port" -gt 65535 ]; then echo 'Use a web port from 1 to 65535.' >&2; exit 2; fi
url="http://127.0.0.1:$web_port/"
is_lab_running() {
  result=$(curl --noproxy '*' --silent --fail --max-time 2 "${url}api/status" 2>/dev/null) || return 1
  case "$result" in *'"app":"TWSOptionsLab"'*) return 0 ;; *) return 1 ;; esac
}
open_page() {
  case "$(uname -s)" in
    Darwin) open "$url" || echo "Open $url in your browser." ;;
    Linux) if command -v xdg-open >/dev/null 2>&1 && [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
             xdg-open "$url" >/dev/null 2>&1 || echo "Open $url in your browser."
           else echo "Open $url in your browser."; fi ;;
    *) echo "Open $url in your browser." ;;
  esac
}
if command -v curl >/dev/null 2>&1 && is_lab_running; then
  echo "Options Lab already runs at $url. Startup options apply to a new instance."
  if [ "$show_page" -eq 1 ]; then open_page; fi
  exit 0
fi

cargo_bin=$(command -v cargo || true)
if [ -z "$cargo_bin" ]; then
  for bin in "${CARGO_HOME:-$HOME/.cargo}/bin/cargo" /opt/homebrew/bin/cargo /usr/local/bin/cargo; do
    if [ -x "$bin" ]; then cargo_bin=$bin; break; fi
  done
fi
if [ -z "$cargo_bin" ]; then echo 'Install a current Rust toolchain from https://rustup.rs and run the launcher again.' >&2; exit 1; fi

"$cargo_bin" build --locked --quiet
if [ "$show_page" -eq 1 ] && command -v curl >/dev/null 2>&1; then
  launcher_pid=$$
  (
    attempt=0
    while [ "$attempt" -lt 50 ] && kill -0 "$launcher_pid" 2>/dev/null; do
      if is_lab_running; then open_page; exit 0; fi
      attempt=$((attempt + 1))
      sleep 0.2
    done
  ) &
fi
echo "Options Lab · $url"
exec "$cargo_bin" run --locked --quiet -- "$@"
