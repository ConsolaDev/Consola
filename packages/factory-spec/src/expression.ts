/**
 * The `if:` expression language: a small fixed grammar over
 * `steps.<id>.<output>` and `item.<field>`, checked when a factory loads and
 * evaluated when a step's turn comes.
 *
 * ```
 * expr := or ;  or := and ("||" and)* ;  and := unary ("&&" unary)* ;  unary := "!" unary | compare
 * compare := primary (("=="|"!="|"<"|"<="|">"|">=") primary)?        # no chains
 * primary := path | literal | "(" expr ")"
 * path    := "steps" "." id "." output | "item" "." field
 * literal := 'text' | "text" | -?digits(.digits)? | true | false     # escapes: \' \" \\ only
 * ```
 *
 * `previous` is refused by name: an `if:` decides on this run's values only.
 *
 * Hand-written on purpose: a file is data that other people's agents may
 * write, so nothing here can reach a function, a property or the process.
 * Pure: no I/O.
 */

export const MAX_IF_LENGTH = 500;

export type PathExpr =
    | { kind: 'output'; step: string; output: string; text: string }
    | { kind: 'item'; field: string; text: string };

export type CompareOp = '==' | '!=' | '<' | '<=' | '>' | '>=';

export type Expr =
    | PathExpr
    | { kind: 'literal'; value: string | number | boolean; text: string }
    | { kind: 'not'; operand: Expr; text: string }
    | { kind: 'and' | 'or'; left: Expr; right: Expr; text: string }
    | { kind: 'compare'; op: CompareOp; left: Expr; right: Expr; text: string };

export type ExprType =
    | { kind: 'boolean' }
    | { kind: 'number' }
    | { kind: 'unknown' }
    | { kind: 'string'; enum?: { values: string[]; owner: string } }; // owner: "verdict of review"

export interface ExpressionScope {
    output(step: string, output: string): ExprType | { problem: string };
    item(field: string): ExprType | { problem: string };
}

export type ExprValue = string | number | boolean;

// --- Tokenizer ---------------------------------------------------------------

type Token =
    | { type: 'word'; value: string; start: number; end: number }
    | { type: 'string'; value: string; start: number; end: number }
    | { type: 'number'; value: number; start: number; end: number }
    | { type: 'punct'; value: string; start: number; end: number };

class ParseError extends Error {}

const WORD_START = /[A-Za-z_]/;
const WORD_PART = /[A-Za-z0-9_-]/;
const DIGIT = /[0-9]/;
const OPERATORS = ['==', '!=', '<=', '>=', '&&', '||', '<', '>', '!', '(', ')', '.'];
const COMPARE_OPS: ReadonlySet<string> = new Set(['==', '!=', '<', '<=', '>', '>=']);
const STEP_ID = /^[a-z][a-z0-9-]*$/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PREVIOUS_IN_IF =
    '`previous` is what the last run wrote, and an `if:` reads this run only (`previous` outputs in `if:` arrive with waiting runs).';

function tokenize(source: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    while (i < source.length) {
        const ch = source[i];
        if (/\s/.test(ch)) {
            i++;
            continue;
        }
        const start = i;
        if (ch === "'" || ch === '"') {
            let value = '';
            i++;
            let closed = false;
            while (i < source.length) {
                const c = source[i];
                if (c === ch) {
                    closed = true;
                    i++;
                    break;
                }
                if (c === '\\') {
                    const next = source[i + 1];
                    if (next === "'" || next === '"' || next === '\\') {
                        value += next;
                        i += 2;
                        continue;
                    }
                    throw new ParseError(String.raw`only \' \" and \\ can follow a backslash in a string`);
                }
                value += c;
                i++;
            }
            if (!closed) throw new ParseError(`unterminated string starting at \`${source.slice(start)}\``);
            tokens.push({ type: 'string', value, start, end: i });
            continue;
        }
        if (DIGIT.test(ch) || (ch === '-' && DIGIT.test(source[i + 1] ?? ''))) {
            i++;
            while (i < source.length && DIGIT.test(source[i])) i++;
            if (source[i] === '.' && DIGIT.test(source[i + 1] ?? '')) {
                i++;
                while (i < source.length && DIGIT.test(source[i])) i++;
            }
            tokens.push({ type: 'number', value: Number(source.slice(start, i)), start, end: i });
            continue;
        }
        if (WORD_START.test(ch)) {
            i++;
            while (i < source.length && WORD_PART.test(source[i])) i++;
            tokens.push({ type: 'word', value: source.slice(start, i), start, end: i });
            continue;
        }
        const op = OPERATORS.find((candidate) => source.startsWith(candidate, i));
        if (!op) throw new ParseError(`unexpected \`${ch}\``);
        i += op.length;
        tokens.push({ type: 'punct', value: op, start, end: i });
    }
    return tokens;
}

// --- Parser ------------------------------------------------------------------

class Parser {
    private position = 0;
    /** A bare word is reported only if nothing more specific turns up later. */
    private deferred: string | undefined;

    constructor(
        private readonly source: string,
        private readonly tokens: Token[],
    ) {}

    parse(): Expr {
        const expr = this.or();
        const extra = this.peek();
        if (extra) throw new ParseError(`unexpected ${describe(extra)}`);
        if (this.deferred) throw new ParseError(this.deferred);
        return expr;
    }

    private peek(): Token | undefined {
        return this.tokens[this.position];
    }

    private next(): Token | undefined {
        return this.tokens[this.position++];
    }

    private isPunct(value: string): boolean {
        const token = this.peek();
        return token?.type === 'punct' && token.value === value;
    }

    private slice(from: number, to: number): string {
        return this.source.slice(from, to);
    }

    private lastEnd(): number {
        return this.tokens[this.position - 1].end;
    }

    private or(): Expr {
        const start = this.peek()?.start ?? 0;
        let left = this.and();
        while (this.isPunct('||')) {
            this.next();
            const right = this.and();
            left = { kind: 'or', left, right, text: this.slice(start, this.lastEnd()) };
        }
        return left;
    }

    private and(): Expr {
        const start = this.peek()?.start ?? 0;
        let left = this.unary();
        while (this.isPunct('&&')) {
            this.next();
            const right = this.unary();
            left = { kind: 'and', left, right, text: this.slice(start, this.lastEnd()) };
        }
        return left;
    }

    private unary(): Expr {
        if (this.isPunct('!')) {
            const start = this.next()!.start;
            const operand = this.unary();
            return { kind: 'not', operand, text: this.slice(start, this.lastEnd()) };
        }
        return this.compare();
    }

    private compare(): Expr {
        const start = this.peek()?.start ?? 0;
        const left = this.primary();
        const token = this.peek();
        if (token?.type !== 'punct' || !COMPARE_OPS.has(token.value)) return left;
        this.next();
        const right = this.primary();
        const following = this.peek();
        if (following?.type === 'punct' && COMPARE_OPS.has(following.value)) {
            throw new ParseError('a comparison cannot be chained; compare two values at a time (join comparisons with && or ||)');
        }
        return { kind: 'compare', op: token.value as CompareOp, left, right, text: this.slice(start, this.lastEnd()) };
    }

    private primary(): Expr {
        const token = this.next();
        if (!token) throw new ParseError('unexpected end of the expression');
        const text = this.slice(token.start, token.end);
        switch (token.type) {
            case 'string':
                return { kind: 'literal', value: token.value, text };
            case 'number':
                return { kind: 'literal', value: token.value, text };
            case 'punct': {
                if (token.value !== '(') throw new ParseError(`unexpected \`${token.value}\``);
                const inner = this.or();
                const close = this.next();
                if (!close || close.type !== 'punct' || close.value !== ')') {
                    throw new ParseError('missing `)` to close the parenthesis');
                }
                return inner;
            }
            case 'word':
                return this.word(token);
        }
    }

    private word(token: Token & { type: 'word' }): Expr {
        const { value, start } = token;
        if (value === 'true' || value === 'false') {
            return { kind: 'literal', value: value === 'true', text: value };
        }
        if (value === 'steps') {
            this.expectDot('steps.<step>.<output>');
            const step = this.segment('steps.<step>.<output>');
            this.expectDot('steps.<step>.<output>');
            const output = this.segment('steps.<step>.<output>');
            if (!STEP_ID.test(step)) {
                throw new ParseError(`\`${step}\` is not a step id (lowercase letters, digits and hyphens): steps.<step>.<output>`);
            }
            if (!NAME.test(output)) throw new ParseError(`\`${output}\` is not an output name: steps.<step>.<output>`);
            if (this.isPunct('.')) throw new ParseError('a path is steps.<step>.<output>, with nothing after the output');
            return { kind: 'output', step, output, text: this.slice(start, this.lastEnd()) };
        }
        if (value === 'item') {
            this.expectDot('item.<field>');
            const field = this.segment('item.<field>');
            if (!NAME.test(field)) throw new ParseError(`\`${field}\` is not a field name: item.<field>`);
            if (this.isPunct('.')) throw new ParseError('a path is item.<field>, with nothing after the field');
            return { kind: 'item', field, text: this.slice(start, this.lastEnd()) };
        }
        if (value === 'previous') throw new ParseError(PREVIOUS_IN_IF);
        this.deferred ??= `\`${value}\` is not a path or a literal (paths are steps.<step>.<output> and item.<field>; strings are quoted)`;
        return { kind: 'literal', value: false, text: value };
    }

    private expectDot(shape: string): void {
        if (!this.isPunct('.')) throw new ParseError(`a path is ${shape}`);
        this.next();
    }

    private segment(shape: string): string {
        const token = this.next();
        if (!token || token.type !== 'word') throw new ParseError(`a path is ${shape}`);
        return token.value;
    }
}

function describe(token: Token): string {
    return `\`${token.type === 'string' ? `'${token.value}'` : String(token.value)}\``;
}

export function parseExpression(source: string): { ok: true; expr: Expr } | { ok: false; problem: string } {
    if (source.trim() === '') return { ok: false, problem: 'the expression is empty' };
    try {
        return { ok: true, expr: new Parser(source, tokenize(source)).parse() };
    } catch (error) {
        if (error instanceof ParseError) return { ok: false, problem: error.message };
        throw error;
    }
}

// --- Type checker --------------------------------------------------------------

function typeName(type: ExprType): string {
    return type.kind === 'unknown' ? 'an item field' : `a ${type.kind}`;
}

function isProblem(result: ExprType | { problem: string }): result is { problem: string } {
    return 'problem' in result;
}

/**
 * Every issue in the expression, each quoting the text it is about. Types are
 * inferred bottom-up; a node that already has an issue has no type, so one
 * mistake is reported once rather than at every operator above it.
 */
export function checkExpression(expr: Expr, scope: ExpressionScope): string[] {
    const issues: string[] = [];

    const requireBoolean = (node: Expr, type: ExprType | undefined, operator: string): void => {
        if (!type || type.kind === 'boolean') return;
        issues.push(`\`${node.text}\` is ${typeName(type)}; \`${operator}\` takes true or false`);
    };

    const infer = (node: Expr): ExprType | undefined => {
        switch (node.kind) {
            case 'literal':
                return { kind: typeof node.value === 'string' ? 'string' : typeof node.value === 'number' ? 'number' : 'boolean' };
            case 'output':
            case 'item': {
                const resolved = node.kind === 'output' ? scope.output(node.step, node.output) : scope.item(node.field);
                if (isProblem(resolved)) {
                    issues.push(`\`${node.text}\`: ${resolved.problem}`);
                    return undefined;
                }
                return resolved;
            }
            case 'not':
                requireBoolean(node.operand, infer(node.operand), '!');
                return { kind: 'boolean' };
            case 'and':
            case 'or': {
                const operator = node.kind === 'and' ? '&&' : '||';
                requireBoolean(node.left, infer(node.left), operator);
                requireBoolean(node.right, infer(node.right), operator);
                return { kind: 'boolean' };
            }
            case 'compare':
                checkCompare(node);
                return { kind: 'boolean' };
        }
    };

    const checkCompare = (node: Extract<Expr, { kind: 'compare' }>): void => {
        const { left, right, op } = node;
        const leftType = infer(left);
        const rightType = infer(right);
        if (!leftType || !rightType) return;

        const items = [left, right].filter((side) => side.kind === 'item');
        if (items.length > 0) {
            const other = left.kind === 'item' ? right : left;
            if (items.length === 2 || other.kind !== 'literal') {
                issues.push(`\`${node.text}\`: an item field compares only with a literal`);
                return;
            }
            if (op !== '==' && op !== '!=' && typeof other.value !== 'number') {
                issues.push(`\`${node.text}\`: \`${op}\` compares numbers`);
            }
            return;
        }

        if (op !== '==' && op !== '!=') {
            if (leftType.kind !== 'number' || rightType.kind !== 'number') {
                issues.push(`\`${node.text}\`: \`${op}\` compares numbers, not ${typeName(leftType.kind === 'number' ? rightType : leftType)}`);
            }
            return;
        }

        if (leftType.kind !== rightType.kind) {
            issues.push(`\`${node.text}\` compares ${typeName(leftType)} with ${typeName(rightType)}`);
            return;
        }
        for (const [side, type] of [
            [left, leftType],
            [right, rightType],
        ] as const) {
            const other = side === left ? right : left;
            if (type.kind === 'string' && type.enum && other.kind === 'literal' && typeof other.value === 'string') {
                if (!type.enum.values.includes(other.value)) {
                    issues.push(`\`${other.value}\` is not a ${type.enum.owner} (${type.enum.values.join(', ')})`);
                }
            }
        }
    };

    const type = infer(expr);
    if (type && type.kind !== 'boolean') {
        issues.push(
            type.kind === 'unknown'
                ? `\`${expr.text}\` is an item field; \`if:\` needs true or false, so compare it with a literal`
                : `\`${expr.text}\` is ${typeName(type)}; \`if:\` needs true or false`,
        );
    }
    return issues;
}

// --- Evaluator -----------------------------------------------------------------

/**
 * Evaluates over recorded values. `&&` and `||` short-circuit, so a path the
 * result does not depend on is never asked for; the first absent path that is
 * needed comes back as `missing`.
 */
export function evaluateExpression(
    expr: Expr,
    value: (path: PathExpr) => ExprValue | undefined,
): { ok: true; value: boolean } | { ok: false; missing: PathExpr } {
    type Result = { ok: true; value: ExprValue } | { ok: false; missing: PathExpr };

    const run = (node: Expr): Result => {
        switch (node.kind) {
            case 'literal':
                return { ok: true, value: node.value };
            case 'output':
            case 'item': {
                const found = value(node);
                return found === undefined ? { ok: false, missing: node } : { ok: true, value: found };
            }
            case 'not': {
                const operand = run(node.operand);
                return operand.ok ? { ok: true, value: operand.value !== true } : operand;
            }
            case 'and':
            case 'or': {
                const left = run(node.left);
                if (!left.ok) return left;
                const decided = node.kind === 'and' ? left.value !== true : left.value === true;
                if (decided) return { ok: true, value: node.kind === 'or' };
                const right = run(node.right);
                return right.ok ? { ok: true, value: right.value === true } : right;
            }
            case 'compare': {
                const left = run(node.left);
                if (!left.ok) return left;
                const right = run(node.right);
                if (!right.ok) return right;
                return { ok: true, value: compare(node.op, left.value, right.value) };
            }
        }
    };

    const result = run(expr);
    return result.ok ? { ok: true, value: result.value === true } : result;
}

function compare(op: CompareOp, left: ExprValue, right: ExprValue): boolean {
    if (op === '==') return left === right;
    if (op === '!=') return left !== right;
    if (typeof left !== 'number' || typeof right !== 'number') return false;
    switch (op) {
        case '<':
            return left < right;
        case '<=':
            return left <= right;
        case '>':
            return left > right;
        case '>=':
            return left >= right;
    }
}

/** Every path the expression reads, left to right, one entry per mention. */
export function expressionPaths(expr: Expr): PathExpr[] {
    switch (expr.kind) {
        case 'output':
        case 'item':
            return [expr];
        case 'literal':
            return [];
        case 'not':
            return expressionPaths(expr.operand);
        default:
            return [...expressionPaths(expr.left), ...expressionPaths(expr.right)];
    }
}
