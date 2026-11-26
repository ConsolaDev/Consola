import { installMock } from './mock';

installMock();
try {
  await import('./render');
} catch (error: unknown) {
  document.getElementById('root')!.textContent =
    'The demo could not load. Please refresh to try again.';
  console.error(error);
}
