/** Keep E2E launches off the desktop unless explicitly debugging visibly. */
export const isBackgroundTest =
    process.env.NODE_ENV === 'test' && process.env.CONSOLA_E2E_HEADED !== '1';
