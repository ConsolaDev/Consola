import { useState, useEffect, useMemo } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Loader2 } from 'lucide-react';
import { fileBridge } from '../../services/fileBridge';
import { getLanguageFromPath } from '../../utils/fileUtils';

interface CodeFileViewProps {
  filePath: string;
}

export function CodeFileView({ filePath }: CodeFileViewProps) {
  const [content, setContent] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const language = useMemo(() => getLanguageFromPath(filePath), [filePath]);

  useEffect(() => {
    setIsLoading(true);
    setError(null);

    fileBridge.readFile(filePath)
      .then(setContent)
      .catch(err => setError(err.message))
      .finally(() => setIsLoading(false));
  }, [filePath]);

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
