import { sourceUrl } from '../domain/source';

/**
 * The version running and a link to its source (AGPL §13), which names the commit the build was
 * made from when it knows it.
 */
export function Footer() {
  const commit = __CONSOLA_COMMIT__.slice(0, 7);
  return (
    <footer className="footer">
      <span>Consola Cloud {__CONSOLA_VERSION__}</span>
      <a href={sourceUrl(__CONSOLA_COMMIT__)} target="_blank" rel="noreferrer">
        Source
        {commit && <span className="footer-commit">{commit}</span>}
      </a>
    </footer>
  );
}
