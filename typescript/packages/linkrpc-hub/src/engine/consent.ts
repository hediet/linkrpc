import type { ConsentDecision, ConsentPrompt } from '@hediet/linkrpc-infra/approval';
import * as readline from 'node:readline';

/**
 * Node-only terminal adapter. A non-TTY abstains until cancellation rather than
 * racing an out-of-band approval with an immediate denial.
 */
export function createTerminalConsentPrompt(): ConsentPrompt {
    return (request) =>
        new Promise<ConsentDecision>((resolve) => {
            if (request.signal.aborted) {
                resolve({ grant: false });
                return;
            }
            if (!process.stdin.isTTY) {
                process.stderr.write(
                    'hubAccess: stdin is not a TTY; the terminal prompt is abstaining '
                    + '(waiting for an out-of-band approval or cancellation).\n',
                );
                request.signal.addEventListener('abort', () => resolve({ grant: false }), { once: true });
                return;
            }
            const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
            const onAbort = () => {
                rl.close();
                resolve({ grant: false });
            };
            request.signal.addEventListener('abort', onAbort, { once: true });
            const lines = [
                '',
                `Access request from "${request.consumer.name}"`,
                ...(request.consumer.purpose ? [`  purpose: ${request.consumer.purpose}`] : []),
                `  node:    ${request.consumerPrincipalId}`,
                ...request.grants.map((g) => `  grant:   ${g}`),
                ...(request.duration ? [`  duration: ${request.duration}`] : []),
                '',
            ];
            process.stderr.write(lines.join('\n'));
            rl.question('Allow? [y/N] ', (answer) => {
                request.signal.removeEventListener('abort', onAbort);
                rl.close();
                resolve(/^y(es)?$/i.test(answer.trim()) ? { grant: true } : { grant: false });
            });
        });
}
