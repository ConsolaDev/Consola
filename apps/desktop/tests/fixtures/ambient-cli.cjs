#!/usr/bin/env node
// The stand-in an end-to-end test run launches wherever a harness names no
// binary of its own (the built-in harness, the "ambient CLI"): never the
// person's real CLI, which would run with their login (review S4). Main gives
// it in place of the ambient CLI (`drivers/testLaunchGuard.ts`) and records
// the launch, so a spec whose every launch is meant to be its own stub fails
// on one. It never contacts a model.
//
//   --version            prints a version, so a health probe reads it installed
//   -p / --print         answers nothing, as a call that failed
//   anything else        an interactive session: one line, then it idles
//                        until its terminal closes
const args = new Set(process.argv.slice(2));
if (args.has('--version')) {
  process.stdout.write('0.0.0 (Consola test stand-in)\n');
  process.exit(0);
}
if (args.has('-p') || args.has('--print')) {
  process.stdout.write('{"type":"result","is_error":true,"result":""}\n');
  process.exit(1);
}
process.stdout.write('Consola test stand-in for the ambient CLI\r\n');
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
