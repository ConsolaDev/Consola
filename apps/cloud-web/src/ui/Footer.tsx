import { sourceUrl } from '../domain/source';

export function Footer() {
  return (
    <footer className="footer">
      Consola Cloud {__CONSOLA_VERSION__} ·{' '}
      <a href={sourceUrl(__CONSOLA_COMMIT__)} target="_blank" rel="noreferrer">
        Source
      </a>
    </footer>
  );
}
