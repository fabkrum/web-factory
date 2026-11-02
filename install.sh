#!/bin/sh
# The local installer for macOS, Linux and WSL. Native Windows is not supported.
#
#   curl -fsSL https://raw.githubusercontent.com/fabkrum/web-factory/main/install.sh | sh -s -- my-site
#
# It installs what is missing (git, Node, the GitHub CLI, your Agent CLI) and creates a Site.
# It is safe to run again: it checks each tool by running it, repairs what an earlier
# run left broken, and changes nothing that already works.
#
#   sh install.sh [--agent claude-code|codex|antigravity|gemini] [folder]

set -eu

FACTORY_HOME="$HOME/.web-factory"
TOOLS="$FACTORY_HOME/tools"
UNFINISHED="$FACTORY_HOME/unfinished"
DOWNLOADS="$FACTORY_HOME/downloads.partial"
NODE_DIST="https://nodejs.org/dist/latest-v22.x"
GH_RELEASES="https://github.com/cli/cli/releases"
AGY_INSTALLER="https://antigravity.google/cli/install.sh"
PATH_LINE="export PATH=\"\$HOME/.web-factory/tools/node/bin:\$HOME/.web-factory/tools/gh/bin:\$HOME/.web-factory/tools/npm/bin:\$HOME/.local/bin:\$PATH\" # web-factory"
USAGE="Usage: sh install.sh [--agent claude-code|codex|antigravity|gemini] [folder]"

say() {
  printf '%s\n' "$*"
}

die() {
  printf '%s\n' "$*" >&2
  exit 1
}

# Every failure after this point can be retried: the marker tells the next run what to finish.
stopped() {
  die "$1
Nothing is lost. Run the same command again: it continues where this one stopped."
}

detect_platform() {
  case "$(uname -s)" in
    Darwin) OS=mac ;;
    Linux) OS=linux ;;
    *) die "This installer runs on macOS, Linux and WSL. Native Windows is not supported: open a Codespace from the template, or install WSL and run this command inside it." ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) NODE_ARCH=x64 GH_ARCH=amd64 ;;
    arm64 | aarch64) NODE_ARCH=arm64 GH_ARCH=arm64 ;;
    *) die "This installer supports 64-bit Intel and ARM processors, and this machine is $(uname -m). Open a Codespace from the template instead." ;;
  esac
}

valid_agent() {
  case "$1" in
    claude-code | codex | antigravity | gemini) return 0 ;;
    *) return 1 ;;
  esac
}

# There is no default on purpose: the Builder's plan decides, not this script.
ask_agent() {
  if ! (: </dev/tty) 2>/dev/null; then
    printf '%s\n%s\n' "Which Agent CLI do you use? There is no default, and this run has no terminal to ask you in." "$USAGE" >&2
    exit 2
  fi
  say "Which Agent CLI do you use? The README's cost table says what each one needs."
  say "  1) Claude Code"
  say "  2) Codex"
  say "  3) Antigravity CLI"
  say "  4) Gemini CLI"
  while [ -z "$AGENT" ]; do
    printf 'Type a number from 1 to 4: '
    read -r answer </dev/tty || answer=""
    case "$answer" in
      1) AGENT=claude-code ;;
      2) AGENT=codex ;;
      3) AGENT=antigravity ;;
      4) AGENT=gemini ;;
    esac
  done
}

remember() {
  mkdir -p "$FACTORY_HOME"
  printf 'site=%s\nagent=%s\n' "$SITE" "$AGENT" >"$UNFINISHED.partial"
  mv "$UNFINISHED.partial" "$UNFINISHED"
}

# Only this script writes these partial folders, so an earlier run's leftovers are safe to remove.
clear_leftovers() {
  rm -rf "$DOWNLOADS" "$TOOLS/node.partial" "$TOOLS/gh.partial" "$UNFINISHED.partial"
}

require_downloader() {
  command -v curl >/dev/null 2>&1 || die "This installer needs curl, which is missing here. Install curl, then run this command again."
  command -v tar >/dev/null 2>&1 || die "This installer needs tar, which is missing here. Install tar, then run this command again."
}

fetch() {
  curl -fsSL --retry 3 -o "$2" "$1" || stopped "Downloading $1 did not work, often because of the network."
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# Downloads an archive, checks it against the checksum file, and unpacks it into the tool's own folder.
install_archive() {
  tool=$1 archive_url=$2 name=$3 checksums=$4
  rm -rf "$DOWNLOADS"
  mkdir -p "$DOWNLOADS/unpacked" "$TOOLS"
  fetch "$checksums" "$DOWNLOADS/checksums"
  expected=$(awk -v name="$name" '$2 == name {print $1}' "$DOWNLOADS/checksums")
  [ -n "$expected" ] || stopped "The checksum list has no entry for $name."
  fetch "$archive_url" "$DOWNLOADS/$name"
  [ "$(sha256 "$DOWNLOADS/$name")" = "$expected" ] || stopped "The download of $name is damaged: its checksum does not match."
  case "$name" in
    *.zip) unzip -q "$DOWNLOADS/$name" -d "$DOWNLOADS/unpacked" ;;
    *) tar -xzf "$DOWNLOADS/$name" -C "$DOWNLOADS/unpacked" ;;
  esac
  mv "$DOWNLOADS/unpacked"/* "$TOOLS/$tool.partial"
  rm -rf "$TOOLS/$tool"
  mv "$TOOLS/$tool.partial" "$TOOLS/$tool"
  rm -rf "$DOWNLOADS"
  # The shell remembers where it found a command, and that may be the broken one.
  hash -r
}

git_works() {
  git --version >/dev/null 2>&1
}

ensure_git() {
  git_works && return 0
  if [ "$OS" = mac ]; then
    # On a Mac git comes with Apple's command line tools, which only Apple's own window installs.
    xcode-select --install >/dev/null 2>&1 || true
    die "git is missing. A window from Apple has opened: press Install there, wait until it finishes, then run this same command again."
  fi
  say "Installing git, which keeps the history of your Site. Your computer may ask for your password."
  sudo_prefix=""
  if [ "$(id -u)" -ne 0 ]; then
    command -v sudo >/dev/null 2>&1 || die "git is missing, and installing it needs an administrator. Ask one to install git, then run this command again."
    sudo_prefix=sudo
  fi
  if command -v apt-get >/dev/null 2>&1; then
    # Repairs a package install that an earlier attempt left unfinished.
    $sudo_prefix dpkg --configure -a
    $sudo_prefix apt-get update -qq
    $sudo_prefix apt-get install -y -qq git
  elif command -v dnf >/dev/null 2>&1; then
    $sudo_prefix dnf install -y -q git
  elif command -v pacman >/dev/null 2>&1; then
    $sudo_prefix pacman -S --noconfirm --needed git
  elif command -v zypper >/dev/null 2>&1; then
    $sudo_prefix zypper --non-interactive install git
  elif command -v apk >/dev/null 2>&1; then
    $sudo_prefix apk add git
  else
    die "git is missing and this Linux has no package manager this installer knows. Install git, then run this command again."
  fi
  git_works || stopped "git did not install."
}

node_works() {
  version=$(node --version 2>/dev/null) || return 1
  npm --version >/dev/null 2>&1 || return 1
  version=${version#v}
  major=${version%%.*}
  rest=${version#*.}
  minor=${rest%%.*}
  case "$major$minor" in
    "" | *[!0-9]*) return 1 ;;
  esac
  [ "$major" -gt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -ge 19 ]; }
}

ensure_node() {
  node_works && return 0
  say "Installing Node 22, which runs the Factory. This changes only the folder $TOOLS."
  rm -rf "$DOWNLOADS"
  mkdir -p "$DOWNLOADS"
  fetch "$NODE_DIST/SHASUMS256.txt" "$DOWNLOADS/node-sums"
  case "$OS" in
    mac) node_os=darwin ;;
    *) node_os=linux ;;
  esac
  name=$(awk -v tail="-$node_os-$NODE_ARCH.tar.gz" 'length($2) > length(tail) && substr($2, length($2) - length(tail) + 1) == tail {print $2}' "$DOWNLOADS/node-sums")
  [ -n "$name" ] || stopped "Node has no download for this machine in its list."
  install_archive node "$NODE_DIST/$name" "$name" "$NODE_DIST/SHASUMS256.txt"
  node_works || stopped "Node did not install."
}

gh_works() {
  gh --version >/dev/null 2>&1
}

ensure_gh() {
  gh_works && return 0
  say "Installing the GitHub CLI, which keeps your work in GitHub issues. This changes only the folder $TOOLS."
  latest=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$GH_RELEASES/latest") || stopped "Asking GitHub for its newest CLI did not work, often because of the network."
  version=${latest##*/v}
  case "$OS" in
    mac) name="gh_${version}_macOS_$GH_ARCH.zip" ;;
    *) name="gh_${version}_linux_$GH_ARCH.tar.gz" ;;
  esac
  install_archive gh "$GH_RELEASES/download/v$version/$name" "$name" "$GH_RELEASES/download/v$version/gh_${version}_checksums.txt"
  gh_works || stopped "The GitHub CLI did not install."
}

ensure_agent() {
  case "$AGENT" in
    claude-code) command=claude package=@anthropic-ai/claude-code label="Claude Code" ;;
    codex) command=codex package=@openai/codex label=Codex ;;
    gemini) command=gemini package=@google/gemini-cli label="Gemini CLI" ;;
    antigravity) command=agy package="" label="Antigravity CLI" ;;
  esac
  "$command" --version >/dev/null 2>&1 && return 0
  say "Installing $label, the Agent CLI you chose."
  if [ -n "$package" ]; then
    npm install --global --prefix "$TOOLS/npm" --no-audit --no-fund "$package" || stopped "Installing $label did not work, often because of the network."
  else
    # Antigravity CLI is a binary from Google's own installer, not an npm package.
    rm -rf "$DOWNLOADS"
    mkdir -p "$DOWNLOADS"
    fetch "$AGY_INSTALLER" "$DOWNLOADS/install-agy.sh"
    bash "$DOWNLOADS/install-agy.sh" || stopped "Google's installer for $label did not work."
    rm -rf "$DOWNLOADS"
  fi
  hash -r
  "$command" --version >/dev/null 2>&1 || stopped "$label did not install."
}

# New terminal windows find the tools through one line, added once to each shell's start file.
ensure_path_line() {
  files="$HOME/.profile"
  [ -f "$HOME/.bashrc" ] && files="$files $HOME/.bashrc"
  [ -f "$HOME/.zshrc" ] && files="$files $HOME/.zshrc"
  case "${SHELL:-}" in
    */zsh) files="$files $HOME/.zshrc" ;;
    */bash) files="$files $HOME/.bashrc" ;;
  esac
  for file in $files; do
    grep -qxF "$PATH_LINE" "$file" 2>/dev/null || printf '\n%s\n' "$PATH_LINE" >>"$file"
  done
}

create_site() {
  npm create --yes web-factory@latest "$SITE" || stopped "Creating the Site stopped; the lines above say why."
}

main() {
  AGENT=""
  FOLDER=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --agent)
        [ $# -ge 2 ] || { printf '%s\n' "$USAGE" >&2; exit 2; }
        AGENT=$2
        shift 2
        ;;
      -h | --help)
        say "$USAGE"
        exit 0
        ;;
      -*)
        printf '%s\n' "$USAGE" >&2
        exit 2
        ;;
      *)
        [ -z "$FOLDER" ] || { printf '%s\n' "$USAGE" >&2; exit 2; }
        FOLDER=$1
        shift
        ;;
    esac
  done
  if [ -n "$AGENT" ] && ! valid_agent "$AGENT"; then
    printf 'The Factory has no Agent CLI called %s.\n%s\n' "$AGENT" "$USAGE" >&2
    exit 2
  fi

  detect_platform

  SITE=""
  if [ -f "$UNFINISHED" ]; then
    say "An earlier install did not finish. Checking what it left and finishing it."
    SITE=$(sed -n 's/^site=//p' "$UNFINISHED")
    [ -n "$AGENT" ] || AGENT=$(sed -n 's/^agent=//p' "$UNFINISHED")
    valid_agent "$AGENT" || AGENT=""
  fi
  if [ -n "$FOLDER" ]; then
    case "$FOLDER" in
      /*) SITE=$FOLDER ;;
      *) SITE="$PWD/$FOLDER" ;;
    esac
  fi
  [ -n "$SITE" ] || SITE="$PWD/my-site"
  [ -n "$AGENT" ] || ask_agent

  PATH="$TOOLS/node/bin:$TOOLS/gh/bin:$TOOLS/npm/bin:$HOME/.local/bin:$PATH"
  export PATH

  remember
  clear_leftovers
  require_downloader
  ensure_git
  ensure_node
  ensure_gh
  ensure_agent
  ensure_path_line
  create_site
  rm -f "$UNFINISHED"

  say ""
  say "Everything is installed. Open a new terminal window, so that it finds the new tools."
  say "Then go to your Site with: cd \"$SITE\""
  say "Start your Agent CLI there and tell it: next"
}

# Called on the last line, so that a download cut short runs nothing at all.
main "$@"
