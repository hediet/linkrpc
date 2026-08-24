import { jcsCanonicalize, type Pattern, type Permission } from '@hediet/linkrpc';
import type { HubAccessManifestRequest } from '@hediet/linkrpc/hub/common';
import type { AccessDirectPermission } from '@hediet/linkrpc-hub/hub/server';

export interface ApprovalPresentationLine {
    readonly label?: string;
    readonly text: string;
    readonly tone?: 'normal' | 'muted' | 'warning';
}

export interface ApprovalPresentationRequest {
    readonly id: string;
    readonly request: HubAccessManifestRequest;
    readonly sourceServiceId?: string;
}

export interface PreparedApprovalPresentation {
    readonly pending: ApprovalPresentationRequest;
    readonly permissions: readonly Permission[];
    readonly resolvedSlot?: {
        readonly serviceId: string;
        readonly satisfiedInterfaces: readonly string[];
    };
}

export interface ApprovalPresentation {
    readonly heading: string;
    readonly details: readonly ApprovalPresentationLine[];
}

export function createApprovalPresentation(
    item: ApprovalPresentationRequest,
    prepared?: PreparedApprovalPresentation,
): ApprovalPresentation {
    const request = item.request;
    const details: ApprovalPresentationLine[] = [
        { label: 'Consumer', text: request.consumer.name },
        { label: 'Principal', text: request.consumer.principal, tone: 'muted' },
        ...(request.consumer.origin !== undefined
            ? [{ label: 'Origin', text: request.consumer.origin } satisfies ApprovalPresentationLine]
            : []),
        ...(request.consumer.purpose !== undefined
            ? [{ label: 'Purpose', text: request.consumer.purpose } satisfies ApprovalPresentationLine]
            : []),
        ...(request.reason !== undefined
            ? [{ label: 'Reason', text: request.reason } satisfies ApprovalPresentationLine]
            : []),
        ...(item.sourceServiceId === undefined
            ? []
            : [{
                label: 'Manifest source',
                text: item.sourceServiceId.length === 0 ? '<root>' : item.sourceServiceId,
            } satisfies ApprovalPresentationLine]),
        {
            label: 'Duration',
            text: request.duration ?? 'unspecified',
            tone: durationTone(request.duration),
        },
        { label: 'Request ID', text: item.id, tone: 'muted' },
        ...(prepared?.resolvedSlot === undefined
            ? []
            : [
                {
                    label: 'Resolved service',
                    text: prepared.resolvedSlot.serviceId,
                    tone: 'warning',
                } satisfies ApprovalPresentationLine,
                {
                    label: 'Satisfied interfaces',
                    text: prepared.resolvedSlot.satisfiedInterfaces.join(', '),
                } satisfies ApprovalPresentationLine,
            ]),
        {
            text: prepared !== undefined
                ? 'Exact authority to be signed'
                : request.kind === 'direct' ? 'Requested authority' : 'Required service shape',
            tone: 'muted',
        },
    ];

    const reviewedPermissions = prepared?.pending.request.kind === 'direct'
        ? prepared.pending.request.permissions
        : undefined;
    details.push(...(
        prepared === undefined
            ? authorityLines(request)
            : permissionLines(prepared.permissions, reviewedPermissions)
    ));
    return {
        heading: `${item.id}  ${request.kind}  ${request.consumer.name}`,
        details,
    };
}

export function approvalDetailLines(
    item: ApprovalPresentationRequest,
    prepared?: PreparedApprovalPresentation,
): readonly ApprovalPresentationLine[] {
    return createApprovalPresentation(item, prepared).details;
}

function authorityLines(
    request: HubAccessManifestRequest,
): readonly ApprovalPresentationLine[] {
    if (request.kind === 'direct') {
        return permissionLines(request.permissions);
    }
    return [
        ...request.interfaces.map((item) => ({
            text: `• interface ${item.id}${item.required === false ? ' (optional)' : ''}`,
        } satisfies ApprovalPresentationLine)),
        ...request.members.map((item) => ({
            text: `• member ${item.interfaceId}::${patternText(item.member)}`
                + `${item.required === false ? ' (optional)' : ''}`,
        } satisfies ApprovalPresentationLine)),
    ];
}

function permissionLines(
    permissions: readonly Permission[],
    reviewedPermissions?: readonly AccessDirectPermission[],
): readonly ApprovalPresentationLine[] {
    return permissions.flatMap((permission, index) => {
        const service = patternText(permission.target.serviceId);
        const iface = patternText(permission.target.interfaceId);
        const members = permission.target.members.map(patternText).join(', ');
        const actions = [
            ...(permission.canInvoke === true ? ['invoke'] : []),
            ...(permission.canDelegate === true ? ['delegate'] : []),
        ].join(' + ') || 'none';
        const callIntent = reviewedPermissions?.[index]?.callIntent;
        return [
            {
                text: `• ${service}::${iface} {${members}}`,
                tone: [
                    permission.target.serviceId,
                    permission.target.interfaceId,
                    ...permission.target.members,
                ].some(isBroadPattern)
                    ? 'warning' as const
                    : 'normal' as const,
            },
            {
                label: `  Actions ${index + 1}`,
                text: actions,
                tone: permission.canDelegate ? 'warning' : 'normal',
            } satisfies ApprovalPresentationLine,
            ...(permission.target.interfaceHash === undefined
                ? []
                : [{
                    label: '  Interface hash',
                    text: permission.target.interfaceHash,
                } satisfies ApprovalPresentationLine]),
            ...(permission.params === undefined
                ? [{
                    label: '  Parameters',
                    text: 'any',
                    tone: 'warning',
                } satisfies ApprovalPresentationLine]
                : [{
                    label: '  Parameters',
                    text: jcsCanonicalize(permission.params),
                } satisfies ApprovalPresentationLine]),
            ...(permission.callBind === undefined
                ? []
                : [{
                    label: '  Exact-call binding',
                    text: jcsCanonicalize(permission.callBind),
                } satisfies ApprovalPresentationLine]),
            ...(callIntent === undefined
                ? []
                : [
                    ...(callIntent.summary === undefined
                        ? []
                        : [{
                            label: '  Call summary',
                            text: callIntent.summary,
                        } satisfies ApprovalPresentationLine]),
                    {
                        label: '  Call method',
                        text: callIntent.method,
                    } satisfies ApprovalPresentationLine,
                    {
                        label: '  Call parameters',
                        text: callIntent.params === undefined
                            ? '{}'
                            : jcsCanonicalize(callIntent.params),
                    } satisfies ApprovalPresentationLine,
                    ...(callIntent.interfaceHash === undefined
                        ? []
                        : [{
                            label: '  Call interface hash',
                            text: callIntent.interfaceHash,
                        } satisfies ApprovalPresentationLine]),
                ]),
        ];
    });
}

function patternText(pattern: Pattern | undefined): string {
    if (pattern === undefined) return 'any';
    if ('exact' in pattern) return `exact(${JSON.stringify(pattern.exact)})`;
    if ('prefix' in pattern) return `prefix(${JSON.stringify(pattern.prefix)})`;
    return 'any';
}

function isBroadPattern(pattern: Pattern | undefined): boolean {
    return pattern === undefined || 'prefix' in pattern;
}

function durationTone(
    duration: string | undefined,
): ApprovalPresentationLine['tone'] {
    return duration === 'persistent' || duration === undefined ? 'warning' : 'normal';
}
