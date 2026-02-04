import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeBlock } from './CodeBlock';
import './styles.css';

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

export function MarkdownRenderer({ content, className }: MarkdownRendererProps) {
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
          }
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
