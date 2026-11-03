#!/bin/sh
# Runs the installer twice on this machine and fails unless the second run changes nothing and
# the result is a working Site. The caller sets the registry; AGENT names the Agent CLI to install.
set -eu

repository=$PWD
work=$(mktemp -d)
cd "$work"

# Everything the installer may write, as one list of checksums. A Site's .git changes its
# timestamps on a read, so its history is compared by commit instead.
snapshot() {
  {
    find "$HOME/.web-factory" my-site -path my-site/.git -prune -o -type f -print
    ls "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc" 2>/dev/null || true
  } | LC_ALL=C sort | while IFS= read -r file; do cksum "$file"; done
  git -C my-site rev-parse HEAD
}

sh "$repository/install.sh" --agent "$AGENT" my-site
snapshot >"$work/first"

sh "$repository/install.sh" --agent "$AGENT" my-site >"$work/second-output"
cat "$work/second-output"
snapshot >"$work/second"

diff "$work/first" "$work/second"
grep -q "Nothing to do" "$work/second-output"
test ! -e "$HOME/.web-factory/unfinished"

test -z "$(git -C my-site status --porcelain)"
if [ "$(uname -s)" = Linux ] && [ "$AGENT" = claude-code ]; then
  bwrap --version
  socat -V >/dev/null
fi
PATH="$HOME/.web-factory/tools/node/bin:$PATH" my-site/node_modules/.bin/factory --help >/dev/null
echo "The installer ran twice on $(uname -s) with $AGENT, and the second run changed nothing."
