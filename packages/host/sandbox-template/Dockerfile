# consola-session: the sandbox a Consola cloud session runs in. The runner
# (`consola-host runner`) makes one per session and runs its start script,
# consola-session-start, which clones the session's repository into
# /workspace/repo and runs the host from its bundle, /opt/consola/consola-host.mjs.
# It holds Node, git, GitHub's CLI, the Claude Code CLI and the Codex CLI at the
# versions pinned below, which README.md lists.
#
# Its folder is staged by scripts/build-template.ts, which adds the two files
# scripts/bundle.ts writes and t3's patch to @ff-labs/fff-node (fff-node.patch).
#
# It writes no t3 settings: a provider's launch arguments there would override
# the host's approval mode (packages/host/AGENTS.md, "The host never starts a
# CLI in full access"). No version goes in an ARG: E2B keeps an ARG as a
# variable of every command the sandbox runs.
#
# Build it on Consola's E2B account (README.md): pnpm --filter @consola/host template:build
FROM e2bdev/base:latest

USER root

# Commands run with no login shell, so a PATH a profile adds is never read:
# every program below is in /usr/local/bin, which this PATH names first.
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# The CLIs stay at the versions pinned here.
ENV DISABLE_AUTOUPDATER=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git xz-utils \
 && rm -rf /var/lib/apt/lists/*

# Node 26.13.1, the official build, checked against its published SHA-256.
# Unpacked whole: its licence and the notices of the packages npm bundles stay.
RUN curl -fsSLo /tmp/node.tar.xz https://nodejs.org/dist/v26.13.1/node-v26.13.1-linux-x64.tar.xz \
 && echo "5c063e46bab0fbc1c17cc445d7ff129cbdcd0471be6ed83b6ab864f8143bc864  /tmp/node.tar.xz" | sha256sum -c - \
 && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner \
 && rm /tmp/node.tar.xz \
 && test "$(node --version)" = v26.13.1

# GitHub's CLI 2.105.0, its release build, checked against its published SHA-256.
RUN curl -fsSLo /tmp/gh.tar.gz https://github.com/cli/cli/releases/download/v2.105.0/gh_2.105.0_linux_amd64.tar.gz \
 && echo "79e7ab5db738c48777b696e374f8b428f0647debfb424f44d2f426370407fe2f  /tmp/gh.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/gh.tar.gz -C /tmp \
 && install -m 0755 /tmp/gh_2.105.0_linux_amd64/bin/gh /usr/local/bin/gh \
 && rm -rf /tmp/gh.tar.gz /tmp/gh_2.105.0_linux_amd64

# The Claude Code CLI and the Codex CLI, from npm. Claude Code is newer than the
# 2.1.321 the bundled Agent SDK names: the host gives the SDK this CLI's path, and
# 2.1.330 is the one Consola's desktop checks (README.md, "Claude Code's version").
RUN npm install --global --no-audit --no-fund @anthropic-ai/claude-code@2.1.330 @openai/codex@0.171.0 \
 && npm cache clean --force

# The packages t3 requires at run time from beside the bundle (scripts/bundle.ts):
# its workspace file search, @ff-labs/fff-node, which the host loads as it starts,
# and ffi-rs, which fff-node (and t3, on demand) loads, each with its linux-x64-gnu
# build. fff-node gets t3's patch, as pnpm gives it to the workspace: its async
# search methods, and its CommonJS entry pointed at them.
COPY fff-node.patch /tmp/fff-node.patch
RUN mkdir -p /opt/consola \
 && cd /opt/consola \
 && printf '{ "private": true }\n' > package.json \
 && npm install --save-exact --omit=dev --no-audit --no-fund \
      @ff-labs/fff-node@0.11.0 @ff-labs/fff-bin-linux-x64-gnu@0.11.0 \
      ffi-rs@1.3.2 @yuuang/ffi-rs-linux-x64-gnu@1.3.2 \
 && cd node_modules/@ff-labs/fff-node \
 && git apply /tmp/fff-node.patch \
 && rm /tmp/fff-node.patch \
 && npm cache clean --force
COPY consola-host.mjs claude-history-worker.mjs /opt/consola/
COPY --chmod=0755 consola-session-start /usr/local/bin/consola-session-start

# The session's folder: its repository is cloned into /workspace/repo.
RUN mkdir -p /workspace && chown user:user /workspace

# Each program's version, in the build's log.
RUN node --version && npm --version && git --version && gh --version \
 && claude --version && codex --version

USER user
WORKDIR /home/user
