import { defineInterface, requestType } from '@hediet/linkrpc';
import { z } from 'zod';

export const echoInterface = defineInterface({ id: 'test.echo' }, {
    echo: requestType(z.object({ text: z.string() }), z.object({ text: z.string(), pid: z.number() })),
});
