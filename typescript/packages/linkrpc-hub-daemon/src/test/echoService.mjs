// A managed LinkRPC service for tests: registers `test.echo` under the
// service ID the daemon granted and exits when the hub connection closes.
import { hostParticipant } from '@hediet/linkrpc-hub/participant-host';
import { echoInterface } from './echoInterface.mjs';

if (process.env.ECHO_FAIL_AT_START) {
    console.error('failing on purpose');
    process.exit(7);
}

console.log(`echo service ${process.pid} starting`);
const host = await hostParticipant({
    registrationMode: 'grantedServiceId',
    setup: ({ services, connection, serviceId }) => {
        services.register(echoInterface, {
            echo: ({ text }) => ({ text: `${process.env.ECHO_PREFIX ?? ''}${text}`, pid: process.pid }),
        });
        if (process.env.ECHO_REFLECTION) connection.enableReflection({ serviceId });
    },
});
await host.done;
process.exit(0);
