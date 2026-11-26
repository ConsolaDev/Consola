/**
 * Typed output values: what a step may declare, how a value is checked, and
 * how text from a command becomes a typed value. Pure: the runner decides
 * where values come from.
 */

export type OutputType =
  | { type: 'enum'; values: string[] }
  | { type: 'integer' | 'number'; minimum?: number; maximum?: number }
  | { type: 'boolean' }
  | { type: 'string'; maxLength: number };

export type OutputValue = string | number | boolean;

/** What a value of this type looks like, in words that follow "must be". */
export function describeOutputType(type: OutputType): string {
  switch (type.type) {
    case 'enum':
      return `one of: ${type.values.join(', ')}`;
    case 'boolean':
      return 'true or false';
    case 'string':
      return `text of at most ${type.maxLength} characters`;
    case 'integer':
    case 'number': {
      const noun = type.type === 'integer' ? 'an integer' : 'a number';
      const { minimum, maximum } = type;
      if (minimum !== undefined && maximum !== undefined) {
        return `${noun} from ${minimum} to ${maximum}`;
      }
      if (minimum !== undefined) return `${noun} of at least ${minimum}`;
      if (maximum !== undefined) return `${noun} of at most ${maximum}`;
      return noun;
    }
  }
}

/** How a rejected value is shown back: text quoted, a long string by its length. */
function describeGot(type: OutputType, value: unknown): string {
  if (type.type === 'string' && typeof value === 'string') return String(value.length);
  if (typeof value === 'string') return `'${value}'`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  return typeof value === 'object' ? 'an object' : String(value);
}

/** True when `value` is a valid value of `type`. */
function isValid(type: OutputType, value: unknown): value is OutputValue {
  switch (type.type) {
    case 'enum':
      return typeof value === 'string' && type.values.includes(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'string':
      return typeof value === 'string' && value.length <= type.maxLength;
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return false;
      if (type.type === 'integer' && !Number.isSafeInteger(value)) return false;
      if (type.minimum !== undefined && value < type.minimum) return false;
      if (type.maximum !== undefined && value > type.maximum) return false;
      return true;
    }
  }
}

export function checkOutputs(
  declared: Record<string, OutputType>,
  raw: unknown,
): { valid: Record<string, OutputValue>; problems: string[] } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      valid: {},
      problems: ['Expected an object of outputs, e.g. { "verdict": "comment" }.'],
    };
  }
  const given = raw as Record<string, unknown>;
  const valid: Record<string, OutputValue> = {};
  const problems: string[] = [];
  const names = Object.keys(declared);
  for (const name of names) {
    if (!Object.prototype.hasOwnProperty.call(given, name)) continue;
    const value = given[name];
    const type = declared[name];
    if (isValid(type, value)) valid[name] = value;
    else {
      // The brief's wording drops the colon the standalone description has.
      const wanted =
        type.type === 'enum' ? `one of ${type.values.join(', ')}` : describeOutputType(type);
      problems.push(`${name} must be ${wanted} (got ${describeGot(type, value)})`);
    }
  }
  for (const name of Object.keys(given)) {
    if (Object.prototype.hasOwnProperty.call(declared, name)) continue;
    problems.push(`${name} is not an output of this step (it has: ${names.join(', ')})`);
  }
  return { valid, problems };
}

const INTEGER_TEXT = /^-?\d+$/;
// Digits after a point only follow the point, so no run of digits can be
// split two ways (`\d+\.?\d*` backtracks quadratically on `000…0x`).
const NUMBER_TEXT = /^-?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/** Text from a command (`key=value`) becomes a typed value, or says why not. */
export function coerceOutput(
  type: OutputType,
  text: string,
): { ok: true; value: OutputValue } | { ok: false; problem: string } {
  let value: OutputValue | undefined;
  switch (type.type) {
    case 'integer':
      if (INTEGER_TEXT.test(text)) value = Number(text);
      break;
    case 'number':
      if (NUMBER_TEXT.test(text)) value = Number(text);
      break;
    case 'boolean':
      if (text === 'true') value = true;
      else if (text === 'false') value = false;
      break;
    case 'enum':
    case 'string':
      value = text;
      break;
  }
  if (value !== undefined && isValid(type, value)) return { ok: true, value };
  return {
    ok: false,
    problem: `expected ${describeOutputType(type)} (got ${describeGot(type, text)})`,
  };
}
