import { create } from 'zustand';

/** How long a toast stays: long enough to read it and reach for Undo. */
export const TOAST_LIFE_MS = 5000;

export interface Toast {
  id: number;
  message: string;
  action?: { label: string; run: () => void };
}

interface ToastState {
  toasts: Toast[];
}

export const useToastStore = create<ToastState>(() => ({ toasts: [] }));

let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

export function dismissToast(id: number): void {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
  useToastStore.setState((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }));
}

/**
 * Say something transient, optionally with one action (Undo). It goes away on
 * its own after five seconds; running the action dismisses it first, so Undo
 * cannot be pressed twice.
 */
export function showToast(message: string, action?: { label: string; run: () => void }): number {
  const id = nextId++;
  const toast: Toast = {
    id,
    message,
    ...(action ? { action: { label: action.label, run: () => { dismissToast(id); action.run(); } } } : {}),
  };
  useToastStore.setState((state) => ({ toasts: [...state.toasts, toast] }));
  timers.set(id, setTimeout(() => dismissToast(id), TOAST_LIFE_MS));
  return id;
}
