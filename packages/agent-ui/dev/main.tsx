import { createRoot } from 'react-dom/client';
import { DevPage } from './DevPage.tsx';

const root = document.getElementById('root');
if (root === null) throw new Error('The dev page has no #root.');
createRoot(root).render(<DevPage search={window.location.search} />);
