import { getIcon } from 'material-file-icons';

interface FileIconProps {
  filename: string;
  className?: string;
}

export function FileIcon({ filename, className }: FileIconProps) {
  const icon = getIcon(filename);
  return (
    <span
      className={className}
      dangerouslySetInnerHTML={{ __html: icon.svg }}
    />
  );
}
