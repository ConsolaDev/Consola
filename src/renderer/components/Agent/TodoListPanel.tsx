import { memo, useMemo, useState, useCallback, useEffect, useRef } from 'react';
import type { TodoItem } from '../../stores/agentStore';
import './todo-list.css';

interface TodoListPanelProps {
  todos: TodoItem[];
  isRunning: boolean;
}

const DISMISS_DELAY_MS = 2000;

export const TodoListPanel = memo(function TodoListPanel({ todos, isRunning }: TodoListPanelProps) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isDismissed, setIsDismissed] = useState(false);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const toggleCollapse = useCallback(() => {
    setIsCollapsed(prev => !prev);
  }, []);

  const stats = useMemo(() => {
    const completed = todos.filter(t => t.status === 'completed').length;
    const inProgress = todos.filter(t => t.status === 'in_progress').length;
    const pending = todos.filter(t => t.status === 'pending').length;
    const total = todos.length;
    const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
    return { completed, inProgress, pending, total, percent };
  }, [todos]);

  // Find the currently active task (in_progress)
  const activeTask = useMemo(
    () => todos.find(t => t.status === 'in_progress'),
    [todos]
  );

  // Check if all done
  const allDone = stats.total > 0 && stats.completed === stats.total;

  // Auto-dismiss after all tasks complete
  useEffect(() => {
    if (allDone) {
      dismissTimerRef.current = setTimeout(() => {
        setIsDismissed(true);
      }, DISMISS_DELAY_MS);
    } else {
      // Reset if new tasks come in
      setIsDismissed(false);
      if (dismissTimerRef.current) {
        clearTimeout(dismissTimerRef.current);
      }
    }
    return () => {
      if (dismissTimerRef.current) {
        clearTimeout(dismissTimerRef.current);
      }
    };
  }, [allDone]);

  // Don't render if no todos or dismissed after completion
  if (todos.length === 0 || isDismissed) return null;

  return (
    <div className={`todo-panel ${allDone ? 'done' : ''} ${isCollapsed ? 'collapsed' : ''}`}>
      {/* Header bar — always visible */}
      <button className="todo-panel-header" onClick={toggleCollapse}>
        <div className="todo-panel-header-left">
          <span className={`todo-panel-icon ${allDone ? 'done' : isRunning ? 'active' : ''}`}>
            {allDone ? (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M13.5 4.5L6.5 11.5L2.5 7.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.5"/>
                <path d="M5 8h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                <path d="M8 5v6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            )}
          </span>
          <span className="todo-panel-title">
            {allDone ? 'All tasks complete' : `${stats.completed}/${stats.total} tasks`}
          </span>
          {!allDone && activeTask && (
            <span className="todo-panel-active-label">
              {activeTask.activeForm}
            </span>
          )}
        </div>
        <div className="todo-panel-header-right">
          <span className="todo-panel-percent">{stats.percent}%</span>
          <span className={`todo-panel-chevron ${isCollapsed ? '' : 'open'}`}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M2.5 3.75L5 6.25L7.5 3.75" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </span>
        </div>
      </button>

      {/* Progress bar */}
      <div className="todo-progress-track">
        <div
          className={`todo-progress-fill ${allDone ? 'done' : ''}`}
          style={{ width: `${stats.percent}%` }}
        />
      </div>

      {/* Task list — collapsible */}
      {!isCollapsed && (
        <div className="todo-panel-body">
          {todos.map((todo, i) => (
            <div
              key={`${todo.content}-${i}`}
              className={`todo-item ${todo.status}`}
            >
              <span className="todo-item-indicator">
                {todo.status === 'completed' ? (
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                    <circle cx="8" cy="8" r="6" fill="currentColor" opacity="0.15"/>
                    <path d="M11 5.5L7 10.5L5 8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                ) : todo.status === 'in_progress' ? (
                  <span className="todo-item-spinner" />
                ) : (
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                    <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1" opacity="0.4"/>
                  </svg>
                )}
              </span>
              <span className="todo-item-text">
                {todo.status === 'in_progress' ? todo.activeForm : todo.content}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});
