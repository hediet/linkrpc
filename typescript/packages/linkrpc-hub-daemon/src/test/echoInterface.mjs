import { defineInterface, requestType } from '@hediet/linkrpc';
import { z } from 'zod';

export const echoInterface = defineInterface({ id: 'test.echo' }, {
    echo: requestType(z.object({ text: z.string() }), z.object({ text: z.string(), pid: z.number() })),
    ticks: requestType(z.object({ count: z.number() }), z.object({ done: z.literal(true) }))
        .withStream({ server: z.object({ tick: z.number() }) }),
});
