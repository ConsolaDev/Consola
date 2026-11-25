#!/usr/bin/env node
/**
 * `consola-host`'s entry (`package.json` `bin`): it listens for SIGTERM and SIGINT, then loads the
 * program (`bin.ts`). Loading t3's module graph takes seconds, and with no listener Node ends the
 * process by the signal at once, which a runner reads as a crash. With one, Node hands a signal to
 * the listeners when its event loop next turns: should that be while the program loads, nothing
 * has started and the process exits 0; once it has loaded, the program's own handlers have it
 * (`runHostProcess`: the program is interrupted, everything it started stops, exit 0). The
 * listeners swap in one synchronous step, so no signal falls between them.
 *
 * `consola-host step-tools` loads `stepToolsMain.ts` instead: the step tools' MCP server, which a
 * step's CLI starts and waits for, and which needs none of t3's runtime.
 *
 * It imports nothing statically, so its listeners are there as soon as Node runs it.
 */
const exitBeforeLoading = () => process.exit(0);
process.on('SIGTERM', exitBeforeLoading);
process.on('SIGINT', exitBeforeLoading);

const argv = process.argv.slice(2);
if (argv[0] === 'step-tools') {
  const { stepToolsMain } = await import('./stepToolsMain.ts');
  await stepToolsMain(argv);
} else {
  const { main } = await import('./bin.ts');

  process.off('SIGTERM', exitBeforeLoading);
  process.off('SIGINT', exitBeforeLoading);
  main(argv);
}
