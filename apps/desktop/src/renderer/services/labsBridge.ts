/**
 * Which hidden features this computer turned on (`shared/labs.ts`): the one
 * place the renderer reads `window.labsAPI`. Fixed for the window's life,
 * since main reads the file once per launch. A window without the bridge (a
 * test, the website's demo without it) shows none of them.
 */
export const labsBridge = {
  /** Whether Automations shows: its sidebar item, dashboard, runs and Settings › Secrets. */
  get automations(): boolean {
    return typeof window !== 'undefined' && window.labsAPI?.automations === true;
  },
};
