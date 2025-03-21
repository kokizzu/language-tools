import { isEqual, sum, uniqWith } from 'lodash';
import { FoldingRange, Node } from 'vscode-html-languageservice';
import { Position, Range } from 'vscode-languageserver';
import { URI } from 'vscode-uri';
import { Document, TagInformation } from './lib/documents';

type Predicate<T> = (x: T) => boolean;

export function not<T>(predicate: Predicate<T>) {
    return (x: T) => !predicate(x);
}

export function or<T>(...predicates: Array<Predicate<T>>) {
    return (x: T) => predicates.some((predicate) => predicate(x));
}

export function and<T>(...predicates: Array<Predicate<T>>) {
    return (x: T) => predicates.every((predicate) => predicate(x));
}

export function unique<T>(array: T[]): T[] {
    return uniqWith(array, isEqual);
}

export function clamp(num: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, num));
}

export function urlToPath(stringUrl: string): string | null {
    const url = URI.parse(stringUrl);
    if (url.scheme !== 'file') {
        return null;
    }
    return url.fsPath.replace(/\\/g, '/');
}

export function pathToUrl(path: string) {
    return URI.file(path).toString();
}

/**
 * Some paths (on windows) start with a upper case driver letter, some don't.
 * This is normalized here.
 */
export function normalizePath(path: string): string {
    return URI.file(path).fsPath.replace(/\\/g, '/');
}

/**
 * URIs coming from the client could be encoded in a different
 * way than expected / than the internal services create them.
 * This normalizes them to be the same as the internally generated ones.
 */
export function normalizeUri(uri: string): string {
    return URI.parse(uri).toString();
}

/**
 * Given a path like foo/bar or foo/bar.svelte , returns its last path
 * (bar or bar.svelte in this example).
 */
export function getLastPartOfPath(path: string): string {
    return path.replace(/\\/g, '/').split('/').pop() || '';
}

export function flatten<T>(arr: Array<T | T[]>): T[] {
    return arr.reduce(
        (all: T[], item) => (Array.isArray(item) ? [...all, ...item] : [...all, item]),
        []
    );
}

/**
 * Map or keep original (passthrough) if the mapper returns undefined.
 */
export function passMap<T>(array: T[], mapper: (x: T) => void | T[]) {
    return array.map((x) => {
        const mapped = mapper(x);
        return mapped === undefined ? x : mapped;
    });
}

export function isInRange(range: Range, positionToTest: Position): boolean {
    return (
        isBeforeOrEqualToPosition(range.end, positionToTest) &&
        isBeforeOrEqualToPosition(positionToTest, range.start)
    );
}

export function isZeroLengthRange(range: Range): boolean {
    return isPositionEqual(range.start, range.end);
}

export function isRangeStartAfterEnd(range: Range): boolean {
    return (
        range.end.line < range.start.line ||
        (range.end.line === range.start.line && range.end.character < range.start.character)
    );
}

export function swapRangeStartEndIfNecessary(range: Range): Range {
    if (isRangeStartAfterEnd(range)) {
        const start = range.start;
        range.start = range.end;
        range.end = start;
    }
    return range;
}

export function moveRangeStartToEndIfNecessary(range: Range): Range {
    if (isRangeStartAfterEnd(range)) {
        range.start = range.end;
    }
    return range;
}

export function isBeforeOrEqualToPosition(position: Position, positionToTest: Position): boolean {
    return (
        positionToTest.line < position.line ||
        (positionToTest.line === position.line && positionToTest.character <= position.character)
    );
}

export function isPositionEqual(position1: Position, position2: Position): boolean {
    return position1.line === position2.line && position1.character === position2.character;
}

export function isNotNullOrUndefined<T>(val: T | undefined | null): val is T {
    return val !== undefined && val !== null;
}

/**
 * Debounces a function but cancels previous invocation only if
 * a second function determines it should.
 *
 * @param fn The function with it's argument
 * @param determineIfSame The function which determines if the previous invocation should be canceld or not
 * @param miliseconds Number of miliseconds to debounce
 */
export function debounceSameArg<T>(
    fn: (arg: T) => void,
    shouldCancelPrevious: (newArg: T, prevArg?: T) => boolean,
    miliseconds: number
): (arg: T) => void {
    let timeout: any;
    let prevArg: T | undefined;

    return (arg: T) => {
        if (shouldCancelPrevious(arg, prevArg)) {
            clearTimeout(timeout);
        }

        prevArg = arg;
        timeout = setTimeout(() => {
            fn(arg);
            prevArg = undefined;
        }, miliseconds);
    };
}

/**
 * Debounces a function but also waits at minimum the specified number of miliseconds until
 * the next invocation. This avoids needless calls when a synchronous call (like diagnostics)
 * took too long and the whole timeout of the next call was eaten up already.
 *
 * @param fn The function
 * @param miliseconds Number of miliseconds to debounce/throttle
 */
export function debounceThrottle(fn: () => void, miliseconds: number): () => void {
    let timeout: any;
    let lastInvocation = Date.now() - miliseconds;

    function maybeCall() {
        clearTimeout(timeout);

        timeout = setTimeout(() => {
            if (Date.now() - lastInvocation < miliseconds) {
                maybeCall();
                return;
            }

            fn();
            lastInvocation = Date.now();
        }, miliseconds);
    }

    return maybeCall;
}

/**
 * Like str.lastIndexOf, but for regular expressions. Note that you need to provide the g-flag to your RegExp!
 */
export function regexLastIndexOf(text: string, regex: RegExp, endPos?: number) {
    if (endPos === undefined) {
        endPos = text.length;
    } else if (endPos < 0) {
        endPos = 0;
    }

    const stringToWorkWith = text.substring(0, endPos + 1);
    let lastIndexOf = -1;
    let result: RegExpExecArray | null = null;
    while ((result = regex.exec(stringToWorkWith)) !== null) {
        lastIndexOf = result.index;
    }
    return lastIndexOf;
}

/**
 * Like str.indexOf, but for regular expressions.
 */
export function regexIndexOf(text: string, regex: RegExp, startPos?: number) {
    if (startPos === undefined || startPos < 0) {
        startPos = 0;
    }

    const stringToWorkWith = text.substring(startPos);
    const result: RegExpExecArray | null = regex.exec(stringToWorkWith);
    return result?.index ?? -1;
}

/**
 * Get all matches of a regexp.
 */
export function getRegExpMatches(regex: RegExp, str: string) {
    const matches: RegExpExecArray[] = [];
    let match: RegExpExecArray | null;
    while ((match = regex.exec(str))) {
        matches.push(match);
    }
    return matches;
}

/**
 * Function to modify each line of a text, preserving the line break style (`\n` or `\r\n`)
 */
export function modifyLines(
    text: string,
    replacementFn: (line: string, lineIdx: number) => string
): string {
    let idx = 0;
    return text
        .split('\r\n')
        .map((l1) =>
            l1
                .split('\n')
                .map((line) => replacementFn(line, idx++))
                .join('\n')
        )
        .join('\r\n');
}

export function isSamePosition(position: Position, another: Position) {
    return position.line === another.line && position.character === another.character;
}
/**
 * Like array.filter, but asynchronous
 */
export async function filterAsync<T>(
    array: T[],
    predicate: (t: T, idx: number) => Promise<boolean>
): Promise<T[]> {
    const fail = Symbol();
    return (
        await Promise.all(
            array.map(async (item, idx) => ((await predicate(item, idx)) ? item : fail))
        )
    ).filter((i) => i !== fail) as T[];
}

export function getIndent(text: string) {
    return /^[ |\t]+/.exec(text)?.[0] ?? '';
}

/**
 *
 * The html language service is case insensitive, and would provide
 * hover/ completion info for Svelte components like `Option` which have
 * the same name like a html tag.
 *
 * Also, svelte directives like action and event modifier only work
 * with element not component
 */
export function possiblyComponent(node: Node): boolean;
export function possiblyComponent(tagName: string): boolean;
export function possiblyComponent(nodeOrTagName: Node | string): boolean {
    return !!(typeof nodeOrTagName === 'object' ? nodeOrTagName.tag : nodeOrTagName)?.[0].match(
        /[A-Z]/
    );
}

/**
 * If the object if it has entries, else undefined
 */
export function returnObjectIfHasKeys<T>(obj: T | undefined): T | undefined {
    if (Object.keys(obj || {}).length > 0) {
        return obj;
    }
}

const fileNameLowerCaseRegExp = /[^\u0130\u0131\u00DFa-z0-9\\/:\-_\. ]+/g;

/**
 * adopted from https://github.com/microsoft/TypeScript/blob/8192d550496d884263e292488e325ae96893dc78/src/compiler/core.ts#L1769-L1807
 * see the comment there about why we can't just use String.prototype.toLowerCase() here
 */
export function toFileNameLowerCase(x: string) {
    return fileNameLowerCaseRegExp.test(x) ? x.replace(fileNameLowerCaseRegExp, toLowerCase) : x;
}

function toLowerCase(x: string) {
    return x.toLowerCase();
}

export type GetCanonicalFileName = (fileName: string) => string;
/**
 * adopted from https://github.com/microsoft/TypeScript/blob/8192d550496d884263e292488e325ae96893dc78/src/compiler/core.ts#L2312
 */
export function createGetCanonicalFileName(
    useCaseSensitiveFileNames: boolean
): GetCanonicalFileName {
    return useCaseSensitiveFileNames ? identity : toFileNameLowerCase;
}

function identity<T>(x: T) {
    return x;
}

export function memoize<T>(callback: () => T): () => T {
    let value: T;
    let callbackInner: typeof callback | undefined = callback;

    return () => {
        if (callbackInner) {
            value = callback();
            callbackInner = undefined;
        }
        return value;
    };
}

export function removeLineWithString(str: string, keyword: string) {
    const lines = str.split('\n');
    const filteredLines = lines.filter((line) => !line.includes(keyword));
    return filteredLines.join('\n');
}

/**
 * Traverses a string and returns the index of the end character, taking into account quotes, curlies and generic tags.
 */
export function traverseTypeString(str: string, start: number, endChar: string): number {
    let singleQuoteOpen = false;
    let doubleQuoteOpen = false;
    let countCurlyBrace = 0;
    let countAngleBracket = 0;

    for (let i = start; i < str.length; i++) {
        const char = str[i];

        if (!doubleQuoteOpen && char === "'") {
            singleQuoteOpen = !singleQuoteOpen;
        } else if (!singleQuoteOpen && char === '"') {
            doubleQuoteOpen = !doubleQuoteOpen;
        } else if (!doubleQuoteOpen && !singleQuoteOpen) {
            if (char === '{') {
                countCurlyBrace++;
            } else if (char === '}') {
                countCurlyBrace--;
            } else if (char === '<') {
                countAngleBracket++;
            } else if (char === '>') {
                countAngleBracket--;
            }
        }

        if (
            !singleQuoteOpen &&
            !doubleQuoteOpen &&
            countCurlyBrace === 0 &&
            countAngleBracket === 0 &&
            char === endChar
        ) {
            return i;
        }
    }

    return -1;
}
