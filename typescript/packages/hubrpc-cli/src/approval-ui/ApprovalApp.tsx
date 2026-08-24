import React from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import type { PendingApprovalRequest } from '../commands/approval';
import {
    approvalDetailLines,
    type ApprovalPresentationLine as DetailLine,
} from '../approvalPresentation';
import { useObservable } from '../ui/useObservable';
import { useScroll } from '../ui/scroll';
import { ApprovalUiModel, type ApprovalUiMessageKind } from './ApprovalUiModel';

export { approvalDetailLines } from '../approvalPresentation';

export interface ApprovalAppProps {
    readonly model: ApprovalUiModel;
}

interface TerminalSize {
    readonly columns: number;
    readonly rows: number;
}

const HEADER_HEIGHT = 2;
const FOOTER_HEIGHT = 2;
const PANE_CHROME_HEIGHT = 3;
const MIN_FULL_HEIGHT = 13;
const SPLIT_COLUMNS = 96;

export const ApprovalApp: React.FC<ApprovalAppProps> = ({ model }) => {
    const requests = useObservable(model.requests);
    const selectedId = useObservable(model.selectedRequestId);
    const connectionState = useObservable(model.connectionState);
    const mode = useObservable(model.mode);
    const busy = useObservable(model.busy);
    const message = useObservable(model.message);
    const denialReason = useObservable(model.denialReason);
    const detailOffset = useObservable(model.detailOffset);
    const preparedApproval = useObservable(model.preparedApproval);
    const size = useTerminalSize();
    const { exit } = useApp();

    const selectedIndex = requests.findIndex((item) => item.id === selectedId);
    const selected = selectedIndex >= 0 ? requests[selectedIndex] : undefined;
    const rawDetails = selected === undefined
        ? []
        : approvalDetailLines(selected, mode === 'approve' ? preparedApproval : undefined);
    const bodyHeight = Math.max(1, size.rows - HEADER_HEIGHT - FOOTER_HEIGHT);
    const sideBySide = size.columns >= SPLIT_COLUMNS;
    const listPaneHeight = sideBySide ? bodyHeight : Math.max(5, Math.floor(bodyHeight * 0.42));
    const detailPaneHeight = sideBySide ? bodyHeight : Math.max(1, bodyHeight - listPaneHeight);
    const detailViewport = Math.max(1, detailPaneHeight - PANE_CHROME_HEIGHT);
    const detailPaneWidth = sideBySide ? Math.floor(size.columns * 0.62) : size.columns;
    const details = wrapDetailLines(rawDetails, Math.max(1, detailPaneWidth - 6));
    const approvalReviewed = mode === 'approve'
        && preparedApproval !== undefined
        && details.length > 0
        && detailOffset + detailViewport >= details.length;

    useInput((input, key) => {
        const canReviewAuthority = size.rows >= MIN_FULL_HEIGHT;
        if (busy) return;
        if (mode === 'deny') {
            if (key.escape) model.cancelMode();
            return;
        }
        if (mode === 'approve') {
            if (key.escape) {
                model.cancelMode();
            } else if (key.pageUp) {
                model.scrollDetails(-detailViewport, details.length, detailViewport);
            } else if (key.pageDown) {
                model.scrollDetails(detailViewport, details.length, detailViewport);
            } else if (key.return && canReviewAuthority && approvalReviewed) {
                void model.confirmCurrentMode();
            }
            return;
        }
        if (mode === 'help') {
            if (key.escape || input === '?' || input === 'q') model.cancelMode();
            return;
        }
        if (input === 'q') {
            exit();
        } else if (input === '?' || key.f1) {
            model.showHelp();
        } else if (input === 'a' && canReviewAuthority) {
            void model.beginApprove();
        } else if (input === 'd' && canReviewAuthority) {
            model.beginDeny();
        } else if (input === 'r') {
            void model.refresh();
        } else if (key.upArrow || input === 'k') {
            model.selectBy(-1);
        } else if (key.downArrow || input === 'j') {
            model.selectBy(1);
        } else if (key.pageUp) {
            model.scrollDetails(-detailViewport, details.length, detailViewport);
        } else if (key.pageDown) {
            model.scrollDetails(detailViewport, details.length, detailViewport);
        }
    });

    if (size.rows < MIN_FULL_HEIGHT) {
        return (
            <CompactApprovalApp
                model={model}
                selected={selected}
                requestCount={requests.length}
                connectionState={connectionState}
                mode={mode}
                busy={busy}
                message={message}
                rows={size.rows}
            />
        );
    }

    return (
        <Box flexDirection="column" height={size.rows} width={size.columns}>
            <Header
                principalId={model.principalId}
                state={connectionState}
                requestCount={requests.length}
            />
            {mode === 'help' ? (
                <Help height={bodyHeight} />
            ) : (
                <Box
                    flexDirection={sideBySide ? 'row' : 'column'}
                    height={bodyHeight}
                >
                    <RequestList
                        requests={requests}
                        selectedIndex={selectedIndex}
                        height={listPaneHeight}
                        width={sideBySide ? '38%' : '100%'}
                    />
                    <RequestDetails
                        selected={selected}
                        lines={details}
                        offset={detailOffset}
                        height={detailPaneHeight}
                        width={sideBySide ? '62%' : '100%'}
                    />
                </Box>
            )}
            <Footer
                mode={mode}
                busy={busy}
                message={message}
                selected={selected}
                denialReason={denialReason}
                approvalReviewed={approvalReviewed}
                onReasonChange={(value) => model.setDenialReason(value)}
                onDeny={() => void model.confirmCurrentMode()}
            />
        </Box>
    );
};

const Header: React.FC<{
    principalId: string;
    state: 'connecting' | 'live' | 'stale';
    requestCount: number;
}> = ({ principalId, state, requestCount }) => (
    <Box flexDirection="column" height={HEADER_HEIGHT}>
        <Box justifyContent="space-between">
            <Text bold>Hub access approvals</Text>
            <Text color={state === 'live' ? 'green' : state === 'stale' ? 'yellow' : 'cyan'}>
                {state === 'live' ? '● live' : state === 'stale' ? '● reconnecting' : '○ connecting'}
                <Text color="white">  {requestCount} pending</Text>
            </Text>
        </Box>
        <Text dimColor wrap="truncate-end">approver: {safeTerminalText(principalId)}</Text>
    </Box>
);

const RequestList: React.FC<{
    requests: readonly PendingApprovalRequest[];
    selectedIndex: number;
    height: number;
    width: number | `${number}%`;
}> = ({ requests, selectedIndex, height, width }) => {
    const viewport = Math.max(1, height - PANE_CHROME_HEIGHT);
    const window = useScroll(requests.length, Math.max(0, selectedIndex), viewport);

    return (
        <Pane title="Requests" height={height} width={width}>
            {requests.length === 0 ? (
                <Box flexDirection="column">
                    <Text color="green">No pending access requests.</Text>
                    <Text dimColor>Watching the Hub for new requests...</Text>
                </Box>
            ) : (
                <>
                    <ScrollMarker direction="up" count={window.above} />
                    {requests.slice(window.start, window.end).map((item, index) => {
                        const actualIndex = window.start + index;
                        const selected = actualIndex === selectedIndex;
                        const duration = item.request.duration ?? 'unspecified';
                        return (
                            <Text
                                key={item.id}
                                color={selected ? 'cyan' : undefined}
                                bold={selected}
                                inverse={selected}
                                wrap="truncate-end"
                            >
                                {selected ? '› ' : '  '}
                                {safeTerminalText(item.request.consumer.name)}
                                <Text dimColor>
                                    {'  '}{safeTerminalText(item.request.kind)} / {safeTerminalText(duration)}
                                </Text>
                            </Text>
                        );
                    })}
                    <ScrollMarker direction="down" count={window.below} />
                </>
            )}
        </Pane>
    );
};

const RequestDetails: React.FC<{
    selected: PendingApprovalRequest | undefined;
    lines: readonly DetailLine[];
    offset: number;
    height: number;
    width: number | `${number}%`;
}> = ({ selected, lines, offset, height, width }) => {
    const viewport = Math.max(1, height - PANE_CHROME_HEIGHT);
    const safeOffset = Math.min(offset, Math.max(0, lines.length - viewport));
    const visible = lines.slice(safeOffset, safeOffset + viewport);
    const range = lines.length > viewport
        ? ` (${safeOffset + 1}-${safeOffset + visible.length} of ${lines.length})`
        : '';

    return (
        <Pane title={`Request details${range}`} height={height} width={width}>
            {selected === undefined ? (
                <Text dimColor>Select a request to inspect its exact authority.</Text>
            ) : (
                <>
                    {visible.map((line, index) => (
                        <Text
                            key={`${safeOffset + index}:${line.label ?? ''}:${line.text}`}
                            color={line.tone === 'warning' ? 'yellow' : undefined}
                            dimColor={line.tone === 'muted'}
                            wrap="truncate-end"
                        >
                            {line.label !== undefined && <Text bold>{safeTerminalText(line.label)}: </Text>}
                            {safeTerminalText(line.text) || '—'}
                        </Text>
                    ))}
                </>
            )}
        </Pane>
    );
};

const Footer: React.FC<{
    mode: 'browse' | 'approve' | 'deny' | 'help';
    busy: boolean;
    message: { readonly kind: ApprovalUiMessageKind; readonly text: string } | undefined;
    selected: PendingApprovalRequest | undefined;
    denialReason: string;
    approvalReviewed: boolean;
    onReasonChange(value: string): void;
    onDeny(): void;
}> = ({
    mode,
    busy,
    message,
    selected,
    denialReason,
    approvalReviewed,
    onReasonChange,
    onDeny,
}) => {
    if (busy) {
        return (
            <Box flexDirection="column" height={FOOTER_HEIGHT}>
                <Text color="cyan">Working... The manifest will be rechecked before the decision is applied.</Text>
                <Text dimColor>Please wait.</Text>
            </Box>
        );
    }
    if (mode === 'approve') {
        return (
            <Box flexDirection="column" height={FOOTER_HEIGHT}>
                <Text color="yellow" wrap="truncate-end">
                    Approve all displayed authority for{' '}
                    <Text bold>{safeTerminalText(selected?.request.consumer.name ?? '')}</Text>?
                </Text>
                {approvalReviewed ? (
                    <Text><Text bold>Enter</Text> confirm  <Text bold>Esc</Text> cancel</Text>
                ) : (
                    <Text><Text bold>PgDn</Text> review all authority before confirming  <Text bold>Esc</Text> cancel</Text>
                )}
            </Box>
        );
    }
    if (mode === 'deny') {
        return (
            <Box flexDirection="column" height={FOOTER_HEIGHT}>
                <Box>
                    <Text color="red">Denial reason (optional): </Text>
                    <TextInput value={denialReason} onChange={onReasonChange} onSubmit={onDeny} />
                </Box>
                <Text><Text bold>Enter</Text> deny  <Text bold>Esc</Text> cancel</Text>
            </Box>
        );
    }

    return (
        <Box flexDirection="column" height={FOOTER_HEIGHT}>
            <Text
                color={messageColor(message?.kind)}
                dimColor={message === undefined}
                wrap="truncate-end"
            >
                {safeTerminalText(message?.text ?? 'Review the exact authority before approving.')}
            </Text>
            <Text dimColor wrap="truncate-end">
                ↑/↓ or j/k select  a approve  d deny  PgUp/PgDn details  r refresh  ? help  q quit
            </Text>
        </Box>
    );
};

const Help: React.FC<{ height: number }> = ({ height }) => (
    <Pane title="Keyboard help" height={height} width="100%">
        <Text><Text bold>↑/↓, j/k</Text>  Move through pending requests</Text>
        <Text><Text bold>PgUp/PgDn</Text> Scroll long request details</Text>
        <Text><Text bold>a</Text>          Review and confirm approval</Text>
        <Text><Text bold>d</Text>          Deny with an optional reason</Text>
        <Text><Text bold>r</Text>          Refresh the authoritative manifest snapshot</Text>
        <Text><Text bold>?, F1</Text>      Toggle this help</Text>
        <Text><Text bold>q</Text>          Quit without deciding remaining requests</Text>
        <Text dimColor>Press Esc, ?, or q to return.</Text>
    </Pane>
);

const CompactApprovalApp: React.FC<{
    model: ApprovalUiModel;
    selected: PendingApprovalRequest | undefined;
    requestCount: number;
    connectionState: 'connecting' | 'live' | 'stale';
    mode: 'browse' | 'approve' | 'deny' | 'help';
    busy: boolean;
    message: { readonly kind: ApprovalUiMessageKind; readonly text: string } | undefined;
    rows: number;
}> = ({
    model,
    selected,
    requestCount,
    connectionState,
    mode,
    busy,
    message,
    rows,
}) => (
    <Box flexDirection="column" height={Math.max(1, rows)}>
        <Text bold wrap="truncate-end">Hub approvals  {connectionState}  {requestCount} pending</Text>
        <Text wrap="truncate-end">
            {selected === undefined
                ? 'No pending access requests.'
                : safeTerminalText(
                    `${selected.request.consumer.name} · ${selected.request.kind} · ${selected.request.duration ?? 'unspecified'}`,
                )}
        </Text>
        {rows >= 4 && (
            <Text color={messageColor(message?.kind)} wrap="truncate-end">
                {safeTerminalText(busy ? 'Resolving request...' : message?.text ?? model.principalId)}
            </Text>
        )}
        {rows >= 5 && (
            <Text color="yellow" wrap="truncate-end">
                Enlarge to at least {MIN_FULL_HEIGHT} rows to review and decide.  ↑/↓ select  q quit
            </Text>
        )}
    </Box>
);

const Pane: React.FC<{
    title: string;
    height: number;
    width: number | `${number}%`;
    children: React.ReactNode;
}> = ({ title, height, width, children }) => (
    <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="gray"
        height={height}
        width={width}
        paddingX={1}
        overflow="hidden"
    >
        <Text bold>{title}</Text>
        {children}
    </Box>
);

const ScrollMarker: React.FC<{ direction: 'up' | 'down'; count: number }> = ({ direction, count }) => {
    if (count === 0) return null;
    return <Text dimColor>{direction === 'up' ? '▲' : '▼'} {count} more</Text>;
};

function wrapDetailLines(lines: readonly DetailLine[], width: number): readonly DetailLine[] {
    return lines.flatMap((line) => {
        const text = safeTerminalText(`${line.label === undefined ? '' : `${line.label}: `}${line.text || '—'}`);
        return wrapTerminalText(text, width).map((chunk) => ({
            text: chunk,
            ...(line.tone === undefined ? {} : { tone: line.tone }),
        }));
    });
}

function wrapTerminalText(text: string, width: number): readonly string[] {
    const lines: string[] = [];
    let current = '';
    let currentWidth = 0;
    for (const character of text) {
        const characterWidth = terminalCharacterWidth(character);
        if (current.length > 0 && currentWidth + characterWidth > width) {
            lines.push(current);
            current = '';
            currentWidth = 0;
        }
        current += character;
        currentWidth += characterWidth;
    }
    if (current.length > 0 || lines.length === 0) lines.push(current);
    return lines;
}

function terminalCharacterWidth(character: string): number {
    if (/^\p{Mark}$/u.test(character)) return 0;
    return character.codePointAt(0)! <= 0x7e ? 1 : 2;
}

export function safeTerminalText(text: string): string {
    let result = '';
    for (const character of text) {
        result += /^[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]$/u.test(character)
            ? `\\u{${character.codePointAt(0)!.toString(16).padStart(4, '0')}}`
            : character;
    }
    return result;
}

function messageColor(kind: ApprovalUiMessageKind | undefined): 'red' | 'green' | 'cyan' | undefined {
    if (kind === 'error') return 'red';
    if (kind === 'success') return 'green';
    if (kind === 'info') return 'cyan';
    return undefined;
}

function useTerminalSize(): TerminalSize {
    const { stdout } = useStdout();
    const [size, setSize] = React.useState<TerminalSize>({
        columns: stdout.columns ?? 100,
        rows: stdout.rows ?? 30,
    });
    React.useEffect(() => {
        const onResize = () => setSize({
            columns: stdout.columns ?? 100,
            rows: stdout.rows ?? 30,
        });
        stdout.on('resize', onResize);
        return () => stdout.off('resize', onResize);
    }, [stdout]);
    return size;
}
