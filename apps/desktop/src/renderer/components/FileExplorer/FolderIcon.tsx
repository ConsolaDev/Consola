import { Folder, FolderOpen } from 'lucide-react';

interface FolderIconProps {
  isOpen: boolean;
  className?: string;
}

export function FolderIcon({ isOpen, className }: FolderIconProps) {
  const Icon = isOpen ? FolderOpen : Folder;
  return <Icon size={16} className={className} />;
}
