import { applicationError, defineInterface, requestType } from '@hediet/linkrpc';
import { z } from 'zod';

const detail = z.strictObject({
    label: z.string(),
    get children() { return z.array(detail); },
});

export const tsErrors = defineInterface({ id: 'dev.linkrpc.ts-errors' }, {
    check: requestType(z.object({ mode: z.string() }), z.string()).withErrors([
        applicationError(2001, 'Missing', z.strictObject({ resource: z.string() })),
        applicationError(2002, 'Busy'),
        applicationError(2003, 'Nullable', z.nullable(z.string())),
        applicationError(2004, 'Recursive', detail),
        applicationError(2005, 'Numeric', z.number()),
    ]),
});
