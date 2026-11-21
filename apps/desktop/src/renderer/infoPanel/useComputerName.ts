import { useEffect, useState } from 'react';
import { windowBridge } from '../services/windowBridge';

/** The answer once it is in: a name, or null for none. Undefined until main has answered. */
let known: string | null | undefined;
let asking: Promise<string | null> | undefined;

function ask(): Promise<string | null> {
  asking ??= windowBridge
    .getComputerName()
    .catch((error: unknown) => {
      console.warn('Could not read the computer’s name:', error);
      return null;
    })
    .then((name) => {
      known = name;
      return name;
    });
  return asking;
}

/**
 * The name this computer goes by, or null while main has not answered and
 * when it has none. Asked once per window, whatever mounts it, and then kept:
 * the name does not change while the app runs (main reads it once per run).
 */
export function useComputerName(): string | null {
  const [name, setName] = useState<string | null>(known ?? null);
  useEffect(() => {
    // Asks main only the first time; after that it is the same answer.
    let current = true;
    void ask().then((answer) => {
      if (current) setName(answer);
    });
    return () => {
      current = false;
    };
  }, []);
  return name;
}
