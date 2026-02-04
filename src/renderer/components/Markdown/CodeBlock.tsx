import { useState, useMemo } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Box, Flex, Text, Button } from '@radix-ui/themes';
import { Copy, Check, ChevronDown, ChevronUp } from 'lucide-react';

interface CodeBlockProps {
  code: string;
  language: string;
  collapsedLineThreshold?: number;
}

export function CodeBlock({
  code,
  language,
  collapsedLineThreshold = 15
}: CodeBlockProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const lines = useMemo(() => code.split('\n'), [code]);
  const shouldCollapse = lines.length > collapsedLineThreshold;

  const displayedCode = useMemo(() => {
    if (!shouldCollapse || isExpanded) return code;
    return lines.slice(0, collapsedLineThreshold).join('\n');
  }, [code, lines, shouldCollapse, isExpanded, collapsedLineThreshold]);

  const hiddenLineCount = lines.length - collapsedLineThreshold;

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Box className="code-block-wrapper">
      {/* Header with language and copy button */}
      <Flex className="code-block-header" justify="between" align="center">
        <Text size="1" className="code-language">{language}</Text>
        <Button
          size="1"
          variant="ghost"
          onClick={handleCopy}
          aria-label={copied ? 'Copied!' : 'Copy code'}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
          <Text size="1">{copied ? 'Copied!' : 'Copy'}</Text>
        </Button>
      </Flex>

      {/* Code content */}
      <Box className="code-block-content">
        <SyntaxHighlighter
          style={oneDark}
          language={language}
          PreTag="div"
          showLineNumbers
          customStyle={{
            margin: 0,
            borderRadius: 0,
            fontSize: '13px',
          }}
        >
          {displayedCode}
        </SyntaxHighlighter>

        {/* Gradient fade when collapsed */}
        {shouldCollapse && !isExpanded && (
          <Box className="code-block-fade" />
        )}
      </Box>

      {/* Expand/Collapse button */}
      {shouldCollapse && (
        <Button
          className="code-block-toggle"
          variant="ghost"
          onClick={() => setIsExpanded(!isExpanded)}
          aria-expanded={isExpanded}
        >
          {isExpanded ? (
            <>
              <ChevronUp size={14} />
              <Text size="1">Collapse</Text>
            </>
          ) : (
            <>
              <ChevronDown size={14} />
              <Text size="1">Show {hiddenLineCount} more lines</Text>
            </>
          )}
        </Button>
      )}
    </Box>
  );
}
