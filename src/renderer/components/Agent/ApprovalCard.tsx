import { useState, useCallback } from 'react';
import { Box, Flex, Text, Button } from '@radix-ui/themes';
import { X, Check } from 'lucide-react';
import type { PendingInputRequest, Question } from '../../stores/agentStore';

interface ApprovalCardProps {
  request: PendingInputRequest;
  onRespond: (requestId: string, action: 'approve' | 'reject' | 'modify', options?: {
    modifiedInput?: Record<string, unknown>;
    feedback?: string;
    answers?: Record<string, string>;
  }) => void;
}

// Format tool name for display
function formatToolName(name: string): string {
  return name
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, str => str.toUpperCase())
    .trim();
}

// Get a human-readable description based on tool type
function getToolDescription(toolName?: string, toolInput?: Record<string, unknown>): string {
  if (!toolName) return 'Action requires approval';

  const tool = toolName.toLowerCase();

  if (tool === 'bash' && toolInput?.command) {
    return `Run command`;
  }
  if (tool === 'edit' || tool === 'write') {
    const path = toolInput?.file_path || toolInput?.filePath;
    return path ? `Modify file` : 'Modify file';
  }
  if (tool === 'read') {
    return 'Read file';
  }

  return formatToolName(toolName);
}

// Get the primary content to show (command, file path, etc.)
function getPrimaryContent(toolName?: string, toolInput?: Record<string, unknown>): string | null {
  if (!toolInput) return null;

  const tool = toolName?.toLowerCase() || '';

  if (tool === 'bash' && toolInput.command) {
    return String(toolInput.command);
  }
  if ((tool === 'edit' || tool === 'write' || tool === 'read') && (toolInput.file_path || toolInput.filePath)) {
    return String(toolInput.file_path || toolInput.filePath);
  }

  return null;
}

export function ApprovalCard({ request, onRespond }: ApprovalCardProps) {
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedback, setFeedback] = useState('');
  // For question type: track selected options per question (by index)
  const [selectedOptions, setSelectedOptions] = useState<Record<number, string[]>>({});

  const isPending = request.status === 'pending';
  const isResolved = request.status !== 'pending';
  const isQuestion = request.type === 'question' && request.questions && request.questions.length > 0;

  // Permission handlers
  const handleApprove = useCallback(() => {
    onRespond(request.requestId, 'approve');
  }, [request.requestId, onRespond]);

  const handleReject = useCallback(() => {
    if (feedback.trim()) {
      onRespond(request.requestId, 'reject', { feedback: feedback.trim() });
    } else {
      setShowFeedback(true);
    }
  }, [request.requestId, onRespond, feedback]);

  const handleRejectWithFeedback = useCallback(() => {
    onRespond(request.requestId, 'reject', { feedback: feedback.trim() || 'User declined' });
    setShowFeedback(false);
  }, [request.requestId, onRespond, feedback]);

  // Question handlers
  const handleOptionSelect = useCallback((questionIndex: number, optionLabel: string, multiSelect?: boolean) => {
    setSelectedOptions(prev => {
      const current = prev[questionIndex] || [];
      if (multiSelect) {
        // Toggle selection for multi-select
        if (current.includes(optionLabel)) {
          return { ...prev, [questionIndex]: current.filter(o => o !== optionLabel) };
        } else {
          return { ...prev, [questionIndex]: [...current, optionLabel] };
        }
      } else {
        // Single select - replace
        return { ...prev, [questionIndex]: [optionLabel] };
      }
    });
  }, []);

  const handleSubmitAnswers = useCallback(() => {
    if (!request.questions) return;

    // Build answers object: question text -> selected option(s)
    const answers: Record<string, string> = {};
    request.questions.forEach((q, idx) => {
      const selected = selectedOptions[idx] || [];
      if (selected.length > 0) {
        answers[q.question] = selected.join(', ');
      }
    });

    onRespond(request.requestId, 'approve', { answers });
  }, [request.requestId, request.questions, selectedOptions, onRespond]);

  const handleCancelQuestion = useCallback(() => {
    onRespond(request.requestId, 'reject', { feedback: 'User cancelled' });
  }, [request.requestId, onRespond]);

  // Check if all questions have at least one selection
  const allQuestionsAnswered = request.questions?.every((_, idx) => {
    const selected = selectedOptions[idx] || [];
    return selected.length > 0;
  }) ?? false;

  const description = request.description || getToolDescription(request.toolName, request.toolInput);
  const primaryContent = getPrimaryContent(request.toolName, request.toolInput);

  // Render question UI
  if (isQuestion) {
    return (
      <Box className={`approval-card ${isResolved ? 'resolved' : ''} ${request.status}`}>
        <div className="approval-status-line" />

        <Flex direction="column" gap="3" className="approval-content">
          {/* Header */}
          <Flex align="center" gap="2">
            <div className={`approval-indicator ${request.status}`} />
            <Text size="2" weight="medium" className="approval-title">
              {isPending ? 'Question from Claude' : request.status === 'approved' ? 'Answered' : 'Cancelled'}
            </Text>
          </Flex>

          {/* Questions */}
          {isPending && request.questions?.map((question, qIdx) => (
            <Flex key={qIdx} direction="column" gap="2" className="question-block">
              <Text size="2" weight="medium">{question.question}</Text>
              <Flex direction="column" gap="1" className="question-options">
                {question.options.map((opt, oIdx) => {
                  const isSelected = (selectedOptions[qIdx] || []).includes(opt.label);
                  return (
                    <button
                      key={oIdx}
                      className={`question-option ${isSelected ? 'selected' : ''}`}
                      onClick={() => handleOptionSelect(qIdx, opt.label, question.multiSelect)}
                    >
                      <span className="option-checkbox">
                        {isSelected ? <Check size={12} /> : null}
                      </span>
                      <Flex direction="column" gap="0" className="option-content">
                        <Text size="2" className="option-label">{opt.label}</Text>
                        {opt.description && (
                          <Text size="1" className="option-description">{opt.description}</Text>
                        )}
                      </Flex>
                    </button>
                  );
                })}
              </Flex>
            </Flex>
          ))}

          {/* Action buttons for questions */}
          {isPending && (
            <Flex gap="2" className="approval-actions">
              <Button
                size="1"
                variant="soft"
                className="approval-btn reject"
                onClick={handleCancelQuestion}
              >
                <X size={14} />
                Cancel
              </Button>
              <Button
                size="1"
                variant="solid"
                className="approval-btn approve"
                onClick={handleSubmitAnswers}
                disabled={!allQuestionsAnswered}
              >
                <Check size={14} />
                Submit
              </Button>
            </Flex>
          )}

          {/* Resolved state */}
          {isResolved && (
            <Text size="1" className="approval-resolved-text">
              {request.status === 'approved' ? 'You answered this question' : 'You cancelled this question'}
            </Text>
          )}
        </Flex>
      </Box>
    );
  }

  // Render permission UI (original)
  return (
    <Box className={`approval-card ${isResolved ? 'resolved' : ''} ${request.status}`}>
      {/* Status indicator */}
      <div className="approval-status-line" />

      <Flex direction="column" gap="2" className="approval-content">
        {/* Header */}
        <Flex align="center" gap="2">
          <div className={`approval-indicator ${request.status}`} />
          <Text size="2" weight="medium" className="approval-title">
            {isPending ? 'Waiting for approval' : request.status === 'approved' ? 'Approved' : 'Rejected'}
          </Text>
        </Flex>

        {/* Description */}
        <Text size="2" className="approval-description">
          {description}
        </Text>

        {/* Primary content (command/file) */}
        {primaryContent && (
          <code className="approval-code">
            {primaryContent}
          </code>
        )}

        {/* Action buttons */}
        {isPending && !showFeedback && (
          <Flex gap="2" className="approval-actions">
            <Button
              size="1"
              variant="soft"
              className="approval-btn reject"
              onClick={handleReject}
            >
              <X size={14} />
              Reject
            </Button>
            <Button
              size="1"
              variant="solid"
              className="approval-btn approve"
              onClick={handleApprove}
            >
              <Check size={14} />
              Accept
            </Button>
          </Flex>
        )}

        {/* Feedback input */}
        {isPending && showFeedback && (
          <Flex direction="column" gap="2" className="approval-feedback">
            <textarea
              className="approval-feedback-input"
              placeholder="Why are you rejecting this? (optional)"
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              rows={2}
              autoFocus
            />
            <Flex gap="2" justify="end">
              <Button
                size="1"
                variant="ghost"
                onClick={() => setShowFeedback(false)}
              >
                Cancel
              </Button>
              <Button
                size="1"
                variant="soft"
                className="approval-btn reject"
                onClick={handleRejectWithFeedback}
              >
                <X size={14} />
                Reject
              </Button>
            </Flex>
          </Flex>
        )}

        {/* Resolved state */}
        {isResolved && (
          <Text size="1" className="approval-resolved-text">
            {request.status === 'approved' ? 'You approved this action' : 'You rejected this action'}
          </Text>
        )}
      </Flex>
    </Box>
  );
}
