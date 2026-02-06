import { Plus, ArrowRight, Square } from 'lucide-react';

interface InputToolbarProps {
  isRunning: boolean;
  canSend: boolean;
  disabled: boolean;
  onSend: () => void;
  onInterrupt: () => void;
  onAttach: () => void;
}

export function InputToolbar({
  isRunning,
  canSend,
  disabled,
  onSend,
  onInterrupt,
  onAttach
}: InputToolbarProps) {
  return (
    <div className="chat-input-toolbar">
      <ToolbarLeft
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
  disabled: boolean;
  onAttach: () => void;
}

function ToolbarLeft({
  disabled,
  onAttach
}: ToolbarLeftProps) {
  return (
    <div className="chat-input-toolbar-left">
      <AttachButton disabled={disabled} onClick={onAttach} />
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
