import { useState, useEffect } from 'react';
import { Flex, Text } from '@radix-ui/themes';

const THINKING_VERBS = [
  'Thinking',
  'Pondering',
  'Processing',
  'Analyzing',
  'Considering',
  'Computing',
  'Reasoning',
  'Evaluating',
  'Deliberating',
  'Cogitating'
];

export function ProcessingIndicator() {
  const [verbIndex, setVerbIndex] = useState(
    () => Math.floor(Math.random() * THINKING_VERBS.length)
  );

  useEffect(() => {
    const interval = setInterval(() => {
      setVerbIndex(prev => (prev + 1) % THINKING_VERBS.length);
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  return (
    <Flex align="center" gap="2" className="processing-indicator">
      <span className="spinner" />
      <Text size="2" color="gray">{THINKING_VERBS[verbIndex]}...</Text>
    </Flex>
  );
}
