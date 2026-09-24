import { applicationError, defineInterface, defineInterfaceTemplate, requestType, type Schema } from '@hediet/linkrpc';
import { z } from 'zod';

const Store = defineInterfaceTemplate(
    { id: 'interop.store', parameters: ['Value'] },
    <Value>({ Value }: { Value: Schema<Value> }) => ({
        get: requestType(Value, Value).withErrors([
            applicationError('Missing', { data: Value }),
        ]),
        exchange: requestType(Value, Value).withStream({ client: Value, server: Value }),
    }),
);

export const numbers = Store({ Value: z.number() });
export const templateInterop = defineInterface({ id: 'interop.templates' }, {
    numbers: numbers.mapMembers({ get: 'readNumber', exchange: 'numbers$exchange' }),
});
