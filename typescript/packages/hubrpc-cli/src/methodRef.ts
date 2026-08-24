/**
 * A method reference as accepted on the CLI: `[serviceId::][interfaceId::]name[@hash]`.
 */
export class MethodRefWithOptHash {
    public static parseMethodRef(input: string): MethodRefWithOptHash {
        if (input.length === 0) throw new Error('Method reference is empty.');

        let hash: string | undefined;
        let core = input;
        const atIdx = input.lastIndexOf('@');
        if (atIdx >= 0) {
            const candidate = input.slice(atIdx + 1);
            // `@` is only the hash separator if it follows the local name and the
            // hash itself contains no `::`. (Interface ids are allowed to contain
            // `.`/`-` so a stray `@` inside the name is a user error.)
            if (candidate.length > 0 && !candidate.includes('::')) {
                hash = candidate;
                core = input.slice(0, atIdx);
            }
        }

        const parts = core.split('::');
        if (parts.length === 0 || parts.some((p) => p.length === 0)) {
            throw new Error(`Invalid method reference: "${input}"`);
        }
        if (parts.length > 3) {
            throw new Error(`Invalid method reference: too many "::" separators in "${input}"`);
        }

        if (parts.length === 1) {
            return new MethodRefWithOptHash(undefined, undefined, parts[0], hash);
        }
        if (parts.length === 2) {
            return new MethodRefWithOptHash(undefined, parts[0], parts[1], hash);
        }
        return new MethodRefWithOptHash(parts[0], parts[1], parts[2], hash);
    }

    constructor(
        public readonly serviceId: string | undefined,
        public readonly interfaceId: string | undefined,
        public readonly methodName: string,
        public readonly hash: string | undefined,
    ) {}

    /** Method name as it goes on the wire (no hash, no whitespace). */
    getMethodOnWire(): string {
        if (this.serviceId !== undefined && this.interfaceId !== undefined) {
            return `${this.serviceId}::${this.interfaceId}::${this.methodName}`;
        }
        if (this.interfaceId !== undefined) {
            return `${this.interfaceId}::${this.methodName}`;
        }
        return this.methodName;
    }
}
