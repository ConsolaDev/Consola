import { useEffect, useState } from 'react';
import { Box, Flex, Text, ScrollArea } from '@radix-ui/themes';
import { MarkdownRenderer } from '../Markdown';
import { fileBridge } from '../../services/fileBridge';
import { AlertCircle, Loader2 } from 'lucide-react';
import './styles.css';

interface MarkdownFileViewProps {
  filePath: string;
}

export function MarkdownFileView({ filePath }: MarkdownFileViewProps) {
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadFile() {
      setLoading(true);
      setError(null);
      try {
        const fileContent = await fileBridge.readFile(filePath);
        setContent(fileContent);
      } catch (err) {
        setError(err instanceof Error ? err.message : `Failed to load file: ${err}`);
      } finally {
        setLoading(false);
      }
    }
    loadFile();
  }, [filePath]);

  if (loading) {
    return (
      <Flex align="center" justify="center" className="markdown-file-view loading">
        <Loader2 className="spinner" size={24} />
        <Text color="gray" ml="2">Loading...</Text>
      </Flex>
    );
  }

  if (error) {
    return (
      <Flex align="center" justify="center" direction="column" gap="2" className="markdown-file-view error">
        <AlertCircle size={32} color="var(--red-9)" />
        <Text color="red">{error}</Text>
      </Flex>
    );
  }

  return (
    <Box className="markdown-file-view">
      <ScrollArea className="file-content">
        <Box p="4">
          <MarkdownRenderer content={content} />
        </Box>
      </ScrollArea>
    </Box>
  );
}
