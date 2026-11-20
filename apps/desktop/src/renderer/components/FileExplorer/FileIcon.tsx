import { getIcon } from 'material-file-icons';

interface FileIconProps {
  filename: string;
  className?: string;
}

export function FileIcon({ filename, className }: FileIconProps) {
  const icon = getIcon(filename);
  // biome-ignore lint/security/noDangerouslySetInnerHtml: the SVG comes from the bundled material-file-icons set, never from a file's contents
  return <span className={className} dangerouslySetInnerHTML={{ __html: icon.svg }} />;
}
