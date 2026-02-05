import { Plus, ArrowRight, Square, ChevronDown } from 'lucide-react';
import { ModelUsage } from '../../../../shared/types';
import { formatModelName, getContextUsage } from './useChatInput';

interface InputToolbarProps {
  model: string | null;
  modelUsage: ModelUsage | null;
  isRunning: boolean;
  canSend: boolean;
  disabled: boolean;
  onSend: () => void;
  onInterrupt: () => void;
  onAttach: () => void;
}

export function InputToolbar({
  model,
  modelUsage,
  isRunning,
  canSend,
  disabled,
  onSend,
  onInterrupt,
  onAttach
}: InputToolbarProps) {
  const { percentage, statusClass } = getContextUsage(modelUsage);

  return (
    <div className="chat-input-toolbar">
      <ToolbarLeft
        model={model}
        modelUsage={modelUsage}
        percentage={percentage}
        statusClass={statusClass}
        disabled={disabled}
        onAttach={onAttach}
      />
      <ToolbarRight
        isRunning={isRunning}
        canSend={canSend}
        onSend={onSend}
        onInterrupt={onInterrupt}
      />
    </div>
  );
}

interface ToolbarLeftProps {
  model: string | null;
  modelUsage: ModelUsage | null;
  percentage: number;
  statusClass: string;
  disabled: boolean;
  onAttach: () => void;
}

function ToolbarLeft({
  model,
  modelUsage,
  percentage,
  statusClass,
  disabled,
  onAttach
}: ToolbarLeftProps) {
  return (
    <div className="chat-input-toolbar-left">
      <AttachButton disabled={disabled} onClick={onAttach} />
      <ModeDropdown />
      <ContextStatus
        model={model}
        modelUsage={modelUsage}
        percentage={percentage}
        statusClass={statusClass}
      />
    </div>
  );
}

interface ToolbarRightProps {
  isRunning: boolean;
  canSend: boolean;
  onSend: () => void;
  onInterrupt: () => void;
}

function ToolbarRight({ isRunning, canSend, onSend, onInterrupt }: ToolbarRightProps) {
  return (
    <div className="chat-input-toolbar-right">
      {isRunning ? (
        <StopButton onClick={onInterrupt} />
      ) : (
        <SendButton disabled={!canSend} onClick={onSend} />
      )}
    </div>
  );
}

// Atomic button components

interface AttachButtonProps {
  disabled: boolean;
  onClick: () => void;
}

function AttachButton({ disabled, onClick }: AttachButtonProps) {
  return (
    <button
      className="chat-input-icon-btn attach"
      onClick={onClick}
      disabled={disabled}
      aria-label="Attach file"
    >
      <Plus size={16} strokeWidth={1.5} />
    </button>
  );
}

function ModeDropdown() {
  return (
    <button className="chat-input-dropdown-btn" disabled>
      <ChevronDown size={12} strokeWidth={2} />
      <span>Fast</span>
    </button>
  );
}

interface ContextStatusProps {
  model: string | null;
  modelUsage: ModelUsage | null;
  percentage: number;
  statusClass: string;
}

function ContextStatus({ model, modelUsage, percentage, statusClass }: ContextStatusProps) {
  return (
    <div className={`chat-input-context ${statusClass}`}>
      <ChevronDown size={12} strokeWidth={2} />
      <span className="chat-input-model">{formatModelName(model)}</span>
      {modelUsage && (
        <span className="chat-input-tokens">
          ({percentage.toFixed(0)}%)
        </span>
      )}
    </div>
  );
}

interface SendButtonProps {
  disabled: boolean;
  onClick: () => void;
}

function SendButton({ disabled, onClick }: SendButtonProps) {
  return (
    <button
      className="chat-input-send-btn"
      onClick={onClick}
      disabled={disabled}
      aria-label="Send message"
    >
      <ArrowRight size={16} strokeWidth={2} />
    </button>
  );
}

interface StopButtonProps {
  onClick: () => void;
}

function StopButton({ onClick }: StopButtonProps) {
  return (
    <button
      className="chat-input-send-btn stop"
      onClick={onClick}
      aria-label="Stop"
    >
      <Square size={14} />
    </button>
  );
}
