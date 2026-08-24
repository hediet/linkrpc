import type { PrincipalSource, SigningSession } from '@vscode/hubrpc-client';
import { formatPrincipalSource } from '@vscode/hubrpc-client';
import { formatJson } from '../output';

export interface CliIdentity {
    readonly principal: string;
    readonly source: PrincipalSource;
}

export function cliIdentity(session: SigningSession): CliIdentity {
    return {
        principal: session.principal.id,
        source: session.principalSource,
    };
}

export function formatCliIdentity(identity: CliIdentity, json = false): string {
    if (json) {
        return formatJson({
            version: 1,
            principal: identity.principal,
            source: identity.source,
        });
    }
    return [
        formatPrincipalSource(identity.source, identity.principal),
        `principal: ${identity.principal}`,
    ].join('\n');
}
