---
date: 2026-02-04T12:00:00-08:00
git_commit: edea55ed1c58fa7cae24ac0641b5c83926e5df05
branch: master
repository: console-1
topic: "Adding Unified Markdown Support (Agent Panel + File Rendering)"
tags: [research, codebase, markdown, agent-panel, file-viewer, react, syntax-highlighting]
status: complete
---

# Research: Adding Unified Markdown Support (Agent Panel + File Rendering)

**Date**: 2026-02-04
**Git Commit**: edea55ed1c58fa7cae24ac0641b5c83926e5df05
**Branch**: master
**Repository**: console-1

## Research Question

How to add markdown rendering support for:
1. **Agent panel chat** - User and assistant messages with proper formatting
2. **Content area file viewer** - Rendering .md files (planning docs, research files, etc.)
3. Syntax highlighting for code blocks
4. Collapsible/expandable sections for long code outputs

## Summary

The current agent panel (`src/renderer/components/Agent/`) renders messages as plain text with `white-space: pre-wrap`. To add markdown support across the application, the recommended approach is to use **react-markdown** with **react-syntax-highlighter** (Prism) as a **unified solution** for both the agent panel and file rendering.

### Why react-markdown (not Streamdown)

| Factor | Streamdown | react-markdown |
|--------|-----------|----------------|
| **Primary purpose** | AI streaming responses | General markdown rendering |
| **Static file rendering** | Not designed for this | ✅ Ideal for .md files |
| **Plugin ecosystem** | Limited | ✅ Large (remark/rehype) |
| **Consistency across contexts** | Chat-focused | ✅ Works everywhere |
| **Community/docs** | Newer, less docs | ✅ Mature, extensive |

Since we're **not rendering during streaming** and need **consistency across agent chat and file viewing**, react-markdown is the better choice.

---

## Current Implementation Analysis

### Key Files

| File | Purpose |
|------|---------|
| `src/renderer/components/Agent/ChatMessage.tsx` | Renders individual chat messages |
| `src/renderer/components/Agent/AgentPanel.tsx` | Main container orchestrating the chat UI |
| `src/renderer/components/Agent/styles.css` | Styling for all agent components |
| `src/renderer/stores/agentStore.ts` | Zustand store managing agent state |

### Current Message Rendering (`ChatMessage.tsx:21-51`)

```tsx
const renderContent = () => {
  if (isUser || !contentBlocks?.length) {
    return <Text as="div" className="message-content">{content}</Text>;
  }

  return (
    <Box className="message-content">
      {contentBlocks.map((block, idx) => {
        if (block.type === 'thinking') {
          return <ThinkingBlock key={idx} content={block.thinking} />;
        }
        if (block.type === 'text') {
          return <Text key={idx} as="div">{block.text}</Text>;
        }
        if (block.type === 'tool_use') {
          return (
            <Box key={idx} className="tool-use-inline">
              <Text size="1" color="gray">Used {block.name}</Text>
            </Box>
          );
        }
        return null;
      })}
    </Box>
  );
};
```

**Key Observations:**
- Messages are rendered as plain text via `<Text>` components from Radix UI
- Content blocks support: `thinking`, `text`, `tool_use`
- No markdown parsing or HTML rendering
- CSS uses `white-space: pre-wrap` for text preservation

### Current Dependencies (`package.json`)

```json
{
  "dependencies": {
    "@radix-ui/themes": "^3.3.0",
    "react": "^19.2.4",
    "zustand": "^5.0.11"
    // No markdown libraries currently installed
  }
}
```

---

## Recommended Solution

### Recommended Libraries

| Library | Purpose | Installation |
|---------|---------|--------------|
| `react-markdown` | Markdown parsing and rendering | `npm install react-markdown` |
| `react-syntax-highlighter` | Syntax highlighting for code blocks | `npm install react-syntax-highlighter` |
| `remark-gfm` | GitHub Flavored Markdown support (tables, task lists, strikethrough) | `npm install remark-gfm` |

### Installation Command

```bash
npm install react-markdown react-syntax-highlighter remark-gfm @types/react-syntax-highlighter
```

---

## Implementation Architecture

### Unified Component Structure

Create a shared `Markdown` component folder that can be used by both the Agent panel and the file viewer:

```
src/renderer/components/
├── Markdown/                      # NEW: Shared markdown components
│   ├── MarkdownRenderer.tsx       # Main markdown component
│   ├── CodeBlock.tsx              # Collapsible code block component
│   ├── index.ts                   # Exports
│   └── styles.css                 # Shared markdown styles
│
├── Agent/
│   ├── ChatMessage.tsx            # UPDATE: Use <MarkdownRenderer />
│   └── ...
│
└── Views/
    ├── MarkdownFileView.tsx       # NEW: .md file viewer component
    └── ContentView.tsx            # UPDATE: Route .md files to viewer
```

### Key Benefits of Unified Architecture

1. **Single source of truth** - One markdown renderer for the entire app
2. **Consistent styling** - Same code blocks, tables, links everywhere
3. **Easier maintenance** - Fix bugs or add features in one place
4. **Reusable** - Future features (notes, documentation) use same renderer

### 1. MarkdownRenderer Component

Create `src/renderer/components/Markdown/MarkdownRenderer.tsx`:

```tsx
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeBlock } from './CodeBlock';

interface MarkdownRendererProps {
  content: string;
}

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code({ node, inline, className, children, ...props }) {
          const match = /language-(\w+)/.exec(className || '');
          const language = match ? match[1] : 'text';
          const codeString = String(children).replace(/\n$/, '');

          if (inline) {
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
        // Customize other elements as needed
        a({ node, children, href, ...props }) {
          return (
            <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
              {children}
            </a>
          );
        }
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
```

### 2. Collapsible CodeBlock Component

Create `src/renderer/components/Markdown/CodeBlock.tsx`:

```tsx
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
```

### 3. Update ChatMessage Component

Update `src/renderer/components/Agent/ChatMessage.tsx`:

```tsx
import { Box, Text } from '@radix-ui/themes';
import { ThinkingBlock } from './ThinkingBlock';
import { MarkdownRenderer } from '../Markdown';
import type { ContentBlock } from '../../stores/agentStore';

interface ChatMessageProps {
  type: 'user' | 'assistant';
  content: string;
  contentBlocks?: ContentBlock[];
  timestamp: number;
}

export function ChatMessage({
  type,
  content,
  contentBlocks,
  timestamp
}: ChatMessageProps) {
  const isUser = type === 'user';

  const renderContent = () => {
    // User messages: render as markdown (supports code blocks, links, etc.)
    if (isUser) {
      return (
        <Box className="message-content markdown-content">
          <MarkdownRenderer content={content} />
        </Box>
      );
    }

    // Assistant messages with content blocks
    if (contentBlocks?.length) {
      return (
        <Box className="message-content markdown-content">
          {contentBlocks.map((block, idx) => {
            if (block.type === 'thinking') {
              return (
                <ThinkingBlock
                  key={idx}
                  content={block.thinking}
                />
              );
            }
            if (block.type === 'text') {
              return <MarkdownRenderer key={idx} content={block.text} />;
            }
            if (block.type === 'tool_use') {
              return (
                <Box key={idx} className="tool-use-inline">
                  <Text size="1" color="gray">Used {block.name}</Text>
                </Box>
              );
            }
            return null;
          })}
        </Box>
      );
    }

    // Fallback: plain content as markdown
    return (
      <Box className="message-content markdown-content">
        <MarkdownRenderer content={content} />
      </Box>
    );
  };

  return (
    <Box className={`chat-message ${isUser ? 'user' : 'assistant'}`}>
      <Text size="1" className="message-meta">
        {isUser ? 'You' : 'Claude'} · {new Date(timestamp).toLocaleTimeString()}
      </Text>
      {renderContent()}
    </Box>
  );
}
```

### 4. MarkdownFileView Component (For Content Area)

Create `src/renderer/components/Views/MarkdownFileView.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Box, Flex, Text, ScrollArea } from '@radix-ui/themes';
import { MarkdownRenderer } from '../Markdown';
import { FileText } from 'lucide-react';

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
        // Use Electron's file reading API
        const fileContent = await window.electronAPI.readFile(filePath);
        setContent(fileContent);
      } catch (err) {
        setError(`Failed to load file: ${err}`);
      } finally {
        setLoading(false);
      }
    }
    loadFile();
  }, [filePath]);

  if (loading) {
    return (
      <Flex align="center" justify="center" className="markdown-file-view loading">
        <Text color="gray">Loading...</Text>
      </Flex>
    );
  }

  if (error) {
    return (
      <Flex align="center" justify="center" className="markdown-file-view error">
        <Text color="red">{error}</Text>
      </Flex>
    );
  }

  const fileName = filePath.split('/').pop() || 'Untitled';

  return (
    <Box className="markdown-file-view">
      {/* File header */}
      <Flex className="file-header" align="center" gap="2">
        <FileText size={16} />
        <Text size="2" weight="medium">{fileName}</Text>
      </Flex>

      {/* Markdown content */}
      <ScrollArea className="file-content">
        <Box className="markdown-content" p="4">
          <MarkdownRenderer content={content} />
        </Box>
      </ScrollArea>
    </Box>
  );
}
```

### 5. CSS Styles

Create `src/renderer/components/Markdown/styles.css`:

```css
/* Markdown Content Styles */
.markdown-content {
  line-height: var(--line-height-relaxed);
}

.markdown-content p {
  margin: 0 0 var(--space-2) 0;
}

.markdown-content p:last-child {
  margin-bottom: 0;
}

.markdown-content h1,
.markdown-content h2,
.markdown-content h3,
.markdown-content h4 {
  margin: var(--space-3) 0 var(--space-2) 0;
  font-weight: var(--font-weight-semibold);
}

.markdown-content h1:first-child,
.markdown-content h2:first-child,
.markdown-content h3:first-child {
  margin-top: 0;
}

.markdown-content ul,
.markdown-content ol {
  margin: var(--space-2) 0;
  padding-left: var(--space-5);
}

.markdown-content li {
  margin: var(--space-1) 0;
}

.markdown-content blockquote {
  margin: var(--space-2) 0;
  padding-left: var(--space-3);
  border-left: 3px solid var(--color-border-strong);
  color: var(--color-text-secondary);
}

.markdown-content a {
  color: var(--color-accent);
  text-decoration: none;
}

.markdown-content a:hover {
  text-decoration: underline;
}

/* Inline code */
.markdown-content .inline-code,
.markdown-content code:not([class*="language-"]) {
  background: var(--color-bg-hover);
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: 0.9em;
}

/* Tables (GFM) */
.markdown-content table {
  width: 100%;
  border-collapse: collapse;
  margin: var(--space-2) 0;
}

.markdown-content th,
.markdown-content td {
  border: 1px solid var(--color-border);
  padding: var(--space-2);
  text-align: left;
}

.markdown-content th {
  background: var(--color-bg-secondary);
  font-weight: var(--font-weight-medium);
}

/* Task lists (GFM) */
.markdown-content input[type="checkbox"] {
  margin-right: var(--space-2);
}

/* Code Block Wrapper */
.code-block-wrapper {
  margin: var(--space-2) 0;
  border-radius: var(--radius-md);
  overflow: hidden;
  background: #282c34; /* oneDark background */
  border: 1px solid var(--color-border);
}

.code-block-header {
  padding: var(--space-2) var(--space-3);
  background: rgba(0, 0, 0, 0.2);
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

.code-language {
  color: var(--color-text-tertiary);
  font-family: var(--font-mono);
  text-transform: uppercase;
}

.code-block-content {
  position: relative;
  overflow: hidden;
}

.code-block-content pre {
  margin: 0 !important;
}

/* Gradient fade for collapsed code */
.code-block-fade {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 60px;
  background: linear-gradient(
    to bottom,
    transparent,
    #282c34
  );
  pointer-events: none;
}

.code-block-toggle {
  width: 100%;
  justify-content: center;
  padding: var(--space-2);
  background: rgba(0, 0, 0, 0.2);
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  color: var(--color-text-secondary);
  gap: var(--space-1);
}

.code-block-toggle:hover {
  background: rgba(0, 0, 0, 0.3);
  color: var(--color-text-primary);
}
```

---

## Performance Optimization

### Option A: Use Light Build for Better Bundle Size

```tsx
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx';
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript';
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript';
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python';
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash';
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

// Register only the languages you need
SyntaxHighlighter.registerLanguage('tsx', tsx);
SyntaxHighlighter.registerLanguage('typescript', typescript);
SyntaxHighlighter.registerLanguage('javascript', javascript);
SyntaxHighlighter.registerLanguage('python', python);
SyntaxHighlighter.registerLanguage('bash', bash);
SyntaxHighlighter.registerLanguage('json', json);
```

---

## Accessibility Considerations

### Code Block Toggle Button

```tsx
<Button
  aria-expanded={isExpanded}
  aria-controls="code-content"
  onClick={() => setIsExpanded(!isExpanded)}
>
  {isExpanded ? 'Collapse' : `Show ${hiddenLines} more lines`}
</Button>
<Box id="code-content" aria-hidden={!isExpanded && shouldCollapse}>
  {/* code content */}
</Box>
```

### Keyboard Navigation

- Ensure toggle buttons are focusable
- Support Enter and Space for activation
- Maintain focus after expand/collapse

---

## Alternative: Native `<details>` Element

For simpler implementation with built-in accessibility:

```tsx
function SimpleCollapsibleCode({ code, language }: CodeBlockProps) {
  const lines = code.split('\n');
  const shouldCollapse = lines.length > 15;

  if (!shouldCollapse) {
    return <SyntaxHighlighter language={language}>{code}</SyntaxHighlighter>;
  }

  return (
    <details className="code-details">
      <summary>
        View code ({lines.length} lines)
      </summary>
      <SyntaxHighlighter language={language}>{code}</SyntaxHighlighter>
    </details>
  );
}
```

---

## File Changes Summary

| File | Action | Description |
|------|--------|-------------|
| `package.json` | UPDATE | Add react-markdown, react-syntax-highlighter, remark-gfm |
| `src/renderer/components/Markdown/MarkdownRenderer.tsx` | CREATE | Shared markdown rendering component |
| `src/renderer/components/Markdown/CodeBlock.tsx` | CREATE | Collapsible code block component |
| `src/renderer/components/Markdown/styles.css` | CREATE | Shared markdown styles |
| `src/renderer/components/Markdown/index.ts` | CREATE | Module exports |
| `src/renderer/components/Agent/ChatMessage.tsx` | UPDATE | Use shared MarkdownRenderer |
| `src/renderer/components/Views/MarkdownFileView.tsx` | CREATE | .md file viewer component |
| `src/renderer/components/Views/ContentView.tsx` | UPDATE | Route .md files to viewer |

---

## Implementation Order

### Phase 1: Core Markdown Components
1. Install dependencies: `npm install react-markdown react-syntax-highlighter remark-gfm @types/react-syntax-highlighter`
2. Create `src/renderer/components/Markdown/` folder
3. Create `CodeBlock.tsx` component
4. Create `MarkdownRenderer.tsx` component
5. Create `styles.css` with shared styles
6. Create `index.ts` with exports

### Phase 2: Agent Panel Integration
7. Update `ChatMessage.tsx` to use `<MarkdownRenderer />`
8. Test agent panel with markdown messages

### Phase 3: File Viewer Integration
9. Create `MarkdownFileView.tsx` component
10. Update `ContentView.tsx` to route .md files
11. Test file viewing with research/planning documents

### Phase 4: Polish
12. Test with various markdown edge cases
13. (Optional) Optimize with light Prism build if bundle size is a concern

---

## Code References

- `src/renderer/components/Agent/ChatMessage.tsx:21-51` - Current renderContent implementation (to be updated)
- `src/renderer/components/Agent/styles.css:50-54` - Current message-content styling
- `src/renderer/components/Agent/ThinkingBlock.tsx` - Existing collapsible pattern (reference for CodeBlock)
- `src/renderer/components/Views/ContentView.tsx` - Content area that will route .md files
- `package.json` - Current dependencies (no markdown libraries)

---

## Sources

- [react-markdown GitHub](https://github.com/remarkjs/react-markdown)
- [react-syntax-highlighter](https://github.com/react-syntax-highlighter/react-syntax-highlighter)
- [remark-gfm](https://github.com/remarkjs/remark-gfm)
- [MDN aria-expanded](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Attributes/aria-expanded)
- [Harvard Accessibility: Expandable Sections](https://accessibility.huit.harvard.edu/technique-expandable-sections)
