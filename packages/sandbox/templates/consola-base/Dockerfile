# consola-base: what every Consola sandbox starts with, whatever runs in it: git, GitHub's
# CLI (gh) and Node 26. The agent CLIs a runner needs join once the runner's spec (21.3)
# lists them. Everything goes where the default PATH finds it (/usr/bin, /usr/local/bin):
# commands run with no login shell, so a PATH a profile adds is never read.
#
# Build it on Consola's E2B account: pnpm --filter @consola/sandbox template:build consola-base
FROM e2bdev/base:latest

USER root

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git gnupg \
 && rm -rf /var/lib/apt/lists/*

# The base image's own Node goes first (20.9.0, with npm 10, corepack and yarn, in
# /usr/local): the default PATH finds /usr/local/bin before /usr/bin, so with it there
# `node` would still be Node 20 after NodeSource's Node 26 is installed.
RUN rm -rf /usr/local/lib/node_modules /usr/local/include/node \
      /usr/local/share/doc/node /usr/local/share/man/man1/node.1 \
 && rm -f /usr/local/bin/node /usr/local/bin/nodejs /usr/local/bin/npm /usr/local/bin/npx \
      /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg

# Node 26, from NodeSource's apt repository.
RUN curl -fsSL https://deb.nodesource.com/setup_26.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/* \
 && node --version | grep -q '^v26\.'

# GitHub's CLI, from GitHub's apt repository.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

USER user
WORKDIR /home/user
