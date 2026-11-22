import { createRoot } from 'react-dom/client';
import { DevPage, forgetPassInAddress } from './DevPage.tsx';

const root = document.getElementById('root');
if (root === null) throw new Error('The dev page has no #root.');
// The pass is read once, here, then taken out of the address bar and the history.
const search = window.location.search;
forgetPassInAddress();
createRoot(root).render(<DevPage search={search} />);
