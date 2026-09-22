import { applicationError, defineInterface, requestType, rpcError } from '@hediet/linkrpc';
import { z } from 'zod';

const detail = z.strictObject({
    label: z.string(),
    get children() { return z.array(detail); },
});

export const tsErrors = defineInterface({ id: 'dev.linkrpc.ts-errors' }, {
    check: requestType(z.object({ mode: z.string() }), z.string()).withErrors([
        applicationError('Missing', { message: 'Missing', data: z.strictObject({ resource: z.string() }) }),
        applicationError('Busy', { message: 'Busy' }),
        applicationError('Nullable', { code: 2003, message: 'Nullable', data: z.nullable(z.string()) }),
        applicationError('Recursive', { code: 2004, message: 'Recursive', data: detail }),
        applicationError('Numeric', { code: 2005, message: 'Numeric', data: z.number() }),
        rpcError(-32001, {
            message: z.string(),
            data: z.strictObject({ retryAfter: z.number() }),
        }),
        rpcError(-32002, { message: z.string(), data: z.unknown().optional() }),
        rpcError(-32003, { message: z.string(), data: z.union([z.string(), z.number()]) }),
    ]),
});
