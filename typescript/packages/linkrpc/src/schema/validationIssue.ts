export interface JsonSchemaValidationIssue {
    readonly path: string;
    readonly message: string;
}

export function jsonPointerSegment(key: PropertyKey): string {
    return `/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;
}
