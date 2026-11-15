#!/bin/sh
# A login shell for tests: point SHELL here and Consola's probe
# (`$SHELL -ilc 'env -0'`, src/main/LoginEnvironment.ts) reads back the app's
# own environment with STUB_LOGIN_PATH first on PATH. Everything that starts
# from the login environment then finds the stubs there, never a real CLI:
# `run:` steps, sessions, and anything else resolving a command by PATH.
#
# Accepts and ignores any flags, as the probe passes -ilc and a command.
#
# Env knobs:
#   STUB_LOGIN_PATH=dir[:dir…]   put first on PATH (the stub gh's folder, say);
#                                unset, PATH is printed unchanged
if [ -n "${STUB_LOGIN_PATH:-}" ]; then
  PATH="$STUB_LOGIN_PATH:$PATH"
  export PATH
fi
exec env -0
