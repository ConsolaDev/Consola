import { useState, useMemo } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { Box, Flex, Text, Button } from '@radix-ui/themes';
import { Copy, Check, ChevronDown, ChevronUp } from 'lucide-react';
import { codeTheme, codeCustomStyle } from '../../utils/codeTheme';
import { SelectableCode } from '../CodeSelection';
import { useCodeSelectionContext } from '../../contexts/CodeSelectionContext';

interface CodeBlockProps {
  code: string;
  language: string;
  collapsedLineThreshold?: number;
  /** Optional file path for code selection (defaults to language-based placeholder) */
  filePath?: string;
}

export function CodeBlock({
  code,
  language,
  collapsedLineThreshold = 15,
  filePath
}: CodeBlockProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const selectionContext = useCodeSelectionContext();

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

  // Determine the file path for selection
  const effectiveFilePath = filePath || `snippet.${language || 'txt'}`;
  const selectionEnabled = !!selectionContext;

  // Custom line number getter for syntax highlighter
  const getLineNumber = (element: Element): number | null => {
    // react-syntax-highlighter wraps each line in a span with a data-line-number
    const lineEl = element.closest('[class*="linenumber"]');
    if (lineEl) {
      const text = lineEl.textContent?.trim();
      if (text) {
        const num = parseInt(text, 10);
        if (!isNaN(num)) return num;
      }
    }
    return null;
  };

  const codeContent = (
    <>
      {/* Code content */}
      <Box className="code-block-content">
        <SyntaxHighlighter
          style={codeTheme}
          language={language}
          PreTag="div"
          showLineNumbers
          customStyle={codeCustomStyle}
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
    </>
  );

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

      {/* Wrap with SelectableCode if context is available */}
      {selectionEnabled ? (
        <SelectableCode
          filePath={effectiveFilePath}
          instanceId={selectionContext.instanceId}
          getLineNumber={getLineNumber}
        >
          {codeContent}
        </SelectableCode>
      ) : (
        codeContent
      )}
    </Box>
  );
}
