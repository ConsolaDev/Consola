import React, { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeBlock } from './CodeBlock';
import { useCommandHighlightContext, HighlightedSegments } from '../HighlightedText';
import './styles.css';

interface MarkdownRendererProps {
  content: string;
  className?: string;
  /** Enable command/skill highlighting (default: true if context available) */
  enableCommandHighlighting?: boolean;
}

/**
 * Component to render text with command highlighting.
 * Used internally by MarkdownRenderer for text nodes.
 */
function HighlightedTextNode({ children }: { children: ReactNode }) {
  const highlightContext = useCommandHighlightContext();

  // If no context or children is not a string, render as-is
  if (!highlightContext || typeof children !== 'string') {
    return <>{children}</>;
  }

  const segments = highlightContext.parseText(children);

  // If no commands found, render as plain text
  if (segments.length === 1 && !segments[0].isCommand) {
    return <>{children}</>;
  }

  return <HighlightedSegments segments={segments} inline />;
}

export function MarkdownRenderer({
  content,
  className,
  enableCommandHighlighting = true
}: MarkdownRendererProps) {
  const highlightContext = useCommandHighlightContext();
  const shouldHighlight = enableCommandHighlighting && highlightContext !== null;

  // Handle empty content gracefully
  if (!content || content.trim() === '') {
    return null;
  }

  return (
    <div className={`markdown-content ${className || ''}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ node, className: codeClassName, children, ...props }) {
            const match = /language-(\w+)/.exec(codeClassName || '');
            const language = match ? match[1] : 'text';
            const codeString = String(children).replace(/\n$/, '');

            // Check if this is inline code (no newlines and no language specified in className)
            const isInline = !codeClassName && !String(children).includes('\n');

            if (isInline) {
              return (
                <code className="inline-code" {...props}>
                  {children}
                </code>
              );
            }

            return (
              <CodeBlock
                code={codeString}
                language={language}
              />
            );
          },
          // Customize links to open in external browser
          a({ node, children, href, ...props }) {
            return (
              <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
                {children}
              </a>
            );
          },
          // Ensure pre tags don't add extra wrapping
          pre({ children }) {
            return <>{children}</>;
          },
          // Custom text renderer for command highlighting
          ...(shouldHighlight && {
            text({ children }) {
              return <HighlightedTextNode>{children}</HighlightedTextNode>;
            },
            // Also handle paragraph content for command highlighting
            p({ node, children, ...props }) {
              return (
                <p {...props}>
                  {React.Children.map(children, (child) => {
                    if (typeof child === 'string') {
                      return <HighlightedTextNode>{child}</HighlightedTextNode>;
                    }
                    return child;
                  })}
                </p>
              );
            },
            // Handle list items
            li({ node, children, ...props }) {
              return (
                <li {...props}>
                  {React.Children.map(children, (child) => {
                    if (typeof child === 'string') {
                      return <HighlightedTextNode>{child}</HighlightedTextNode>;
                    }
                    return child;
                  })}
                </li>
              );
            },
          }),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
