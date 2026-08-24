/**
 * Render the dynamic "Method parameters" block appended to `hub call --help`
 * and `hub notify --help`. Pure: takes a `MethodSchema` (already fetched by
 * the caller) plus the live interface schema for ref resolution, and returns
 * the formatted block. The caller concatenates it after commander's
 * static help text.
 *
 * Param names show up as `--p:<name>`; the type / required-ness / one-line
 * description is derived from the params object's `properties` map.
 *
 * If the method's params schema isn't a plain object schema (e.g. a
 * union, or a top-level array), we render a coarse fallback instead of
 * pretending each branch is its own `--p:` flag.
 */
import type {
    MethodSchema,
    LinkRpcInterfaceSchema as SvcInterfaceSchema,
    LinkRpcJsonSchema as SvcJsonSchema,
} from '@hediet/linkrpc';

export interface RenderedParamHelp {
    /** Multi-line block, or empty when the method takes no params. */
    readonly text: string;
    /**
     * Param names suitable for completion. Empty when the params descriptor
     * isn't a plain object (no `--p:<name>` flag-name to suggest).
     */
    readonly paramNames: readonly string[];
}

export function renderMethodParamHelp(
    method: MethodSchema,
    schema: SvcInterfaceSchema,
): RenderedParamHelp {
    const resolved = _resolve(method.params, schema.components?.schemas ?? {});
    if (!_isObjectSchema(resolved)) {
        return {
            text:
                `Method parameters (${schema.id}@${schema.hash}):\n`
                + `  (params is not a plain object — pass with --params <json>)\n`,
            paramNames: [],
        };
    }

    const props = resolved.properties ?? {};
    const required = new Set<string>(resolved.required ?? []);
    const names = Object.keys(props);
    if (names.length === 0) {
        return {
            text:
                `Method parameters (${schema.id}@${schema.hash}):\n`
                + `  (no parameters)\n`,
            paramNames: [],
        };
    }

    const rows: string[][] = [];
    for (const name of names) {
        const propSchema = _resolve(props[name], schema.components?.schemas ?? {});
        const flag = `--p:${name} <${_typeLabel(propSchema)}>`;
        const reqMark = required.has(name) ? 'required' : 'optional';
        const desc = _oneLineDescription(propSchema);
        rows.push([flag, reqMark, desc]);
    }

    const flagCol = Math.max(...rows.map((r) => r[0].length));
    const reqCol = Math.max(...rows.map((r) => r[1].length));

    const lines = [`Method parameters (${schema.id}@${schema.hash}):`];
    for (const [flag, req, desc] of rows) {
        const padded = `  ${flag.padEnd(flagCol)}  ${req.padEnd(reqCol)}${desc ? '  ' + desc : ''}`;
        lines.push(padded.trimEnd());
    }
    return { text: lines.join('\n') + '\n', paramNames: names };
}

function _isObjectSchema(
    s: SvcJsonSchema,
): s is Extract<SvcJsonSchema, { type: 'object' }> {
    return typeof s === 'object' && s !== null && (s as { type?: string }).type === 'object';
}

function _resolve(
    s: SvcJsonSchema,
    components: Record<string, SvcJsonSchema>,
): SvcJsonSchema {
    if (typeof s === 'object' && s !== null && '$ref' in s) {
        const ref = (s as { $ref: string }).$ref;
        const m = /^#\/components\/schemas\/(.+)$/.exec(ref);
        if (m) {
            const target = components[m[1]];
            if (target !== undefined) return target;
        }
    }
    return s;
}

function _typeLabel(s: SvcJsonSchema): string {
    if (s === true) return 'any';
    if (s === false) return 'never';
    const obj = s as unknown as Record<string, unknown>;

    if (typeof obj.type === 'string') {
        if (obj.type === 'array') {
            const items = obj.items as SvcJsonSchema | undefined;
            if (items !== undefined) return `${_typeLabel(items)}[]`;
            return 'array';
        }
        const fmt = obj.format !== undefined ? `:${obj.format}` : '';
        return `${obj.type as string}${fmt}`;
    }
    if (Array.isArray(obj.enum)) {
        return `enum(${obj.enum.map((v) => JSON.stringify(v)).join('|')})`;
    }
    if ('const' in obj) {
        return JSON.stringify(obj.const);
    }
    if (Array.isArray(obj.oneOf) || Array.isArray(obj.anyOf)) {
        return 'union';
    }
    if ('$ref' in obj) {
        const ref = obj.$ref as string;
        const m = /^#\/components\/schemas\/(.+)$/.exec(ref);
        return m ? m[1] : 'ref';
    }
    return 'value';
}

function _oneLineDescription(propSchema: SvcJsonSchema): string {
    const obj = propSchema as unknown as Record<string, unknown>;
    const raw = (obj.description as string | undefined) ?? (obj.title as string | undefined) ?? '';
    if (!raw) return '';
    const firstLine = raw.split(/\r?\n/, 1)[0];
    return firstLine.length > 80 ? firstLine.slice(0, 77) + '…' : firstLine;
}
