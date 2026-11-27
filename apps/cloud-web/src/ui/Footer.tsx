import { sourceUrl } from '../domain/source';

/**
 * A link to the running code's source (AGPL §13), which names the commit the build was made from
 * when it knows it. It closes Settings → General, and the narrow page under sign-in and the
 * create form. No version: the cloud runs a commit, not a release.
 */
export function Footer() {
  const commit = __CONSOLA_COMMIT__.slice(0, 7);
  return (
    <footer className="footer">
      <a href={sourceUrl(__CONSOLA_COMMIT__)} target="_blank" rel="noreferrer">
        Source
        {commit && <span className="footer-commit">{commit}</span>}
      </a>
    </footer>
  );
}
