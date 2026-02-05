import { useState, useEffect, useMemo } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Flex, Text, Button } from '@radix-ui/themes';
import { Copy, Check, Loader2 } from 'lucide-react';
import { fileBridge } from '../../services/fileBridge';
import { FileIcon } from '../FileExplorer/FileIcon';
import { getLanguageFromPath } from '../../utils/fileUtils';

interface CodeFileViewProps {
  filePath: string;
}

export function CodeFileView({ filePath }: CodeFileViewProps) {
  const [content, setContent] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const filename = useMemo(() => filePath.split('/').pop() || '', [filePath]);
  const language = useMemo(() => getLanguageFromPath(filePath), [filePath]);

  useEffect(() => {
    setIsLoading(true);
    setError(null);

    fileBridge.readFile(filePath)
      .then(setContent)
      .catch(err => setError(err.message))
      .finally(() => setIsLoading(false));
  }, [filePath]);

  const handleCopy = async () => {
    if (content) {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (isLoading) {
    return (
      <div className="code-file-view loading">
        <Loader2 size={24} className="spinner" />
        <p>Loading file...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="code-file-view error">
        <p>Error loading file</p>
        <p className="code-file-error-detail">{error}</p>
      </div>
    );
  }

  return (
    <div className="code-file-view">
      <Flex className="code-file-header" justify="between" align="center">
        <Flex align="center" gap="2">
          <FileIcon filename={filename} className="code-file-icon" />
          <Text size="2" weight="medium">{filename}</Text>
          <Text size="1" color="gray">{language}</Text>
        </Flex>
        <Button size="1" variant="ghost" onClick={handleCopy}>
          {copied ? <Check size={14} /> : <Copy size={14} />}
          <Text size="1">{copied ? 'Copied!' : 'Copy'}</Text>
        </Button>
      </Flex>
      <div className="code-file-content">
        <SyntaxHighlighter
          style={oneDark}
          language={language}
          showLineNumbers
          customStyle={{
            margin: 0,
            borderRadius: 0,
            fontSize: '13px',
            height: '100%',
          }}
        >
          {content || ''}
        </SyntaxHighlighter>
      </div>
    </div>
  );
}
