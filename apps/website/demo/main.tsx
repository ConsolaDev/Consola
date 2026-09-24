import { installMock } from './mock';

installMock();
void import('./render').catch(error => {
  document.getElementById('root')!.textContent = 'The demo could not load. Please refresh to try again.';
  console.error(error);
});
