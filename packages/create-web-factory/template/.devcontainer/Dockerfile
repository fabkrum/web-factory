# Everything a Builder needs, so a Codespace asks them to install nothing: git and Node come
# with this image, and every supported Agent CLI is here, because the Builder picks one at Kickoff.
FROM mcr.microsoft.com/devcontainers/javascript-node:22

# Claude Code's sandbox on Linux runs on bubblewrap and socat, and without them no session starts.
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap socat && rm -rf /var/lib/apt/lists/*

RUN npm install --global --no-audit --no-fund @anthropic-ai/claude-code @openai/codex @google/gemini-cli

# Antigravity CLI is a binary from Google's own installer, which puts it in ~/.local/bin.
USER node
RUN curl -fsSL -o /tmp/install-agy.sh https://antigravity.google/cli/install.sh && bash /tmp/install-agy.sh && rm /tmp/install-agy.sh
ENV PATH="/home/node/.local/bin:${PATH}"
