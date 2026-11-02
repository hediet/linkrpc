// A managed LinkRPC service for tests: registers `test.echo` under the
// service ID the daemon granted and exits when the hub connection closes.
import { hostParticipant } from '@hediet/linkrpc-hub/participant-host';
import { echoInterface } from './echoInterface.mjs';

if (process.env.ECHO_FAIL_AT_START) {
    console.error('failing on purpose');
    process.exit(7);
}

// Linger after a stop request, so tests can observe the daemon while services stop.
if (process.env.ECHO_EXIT_DELAY_MS) process.on('SIGTERM', () => { /* exit after the delay */ });

console.log(`echo service ${process.pid} starting`);
const host = await hostParticipant({
    registrationMode: 'grantedServiceId',
    setup: ({ services, connection, serviceId }) => {
        services.register(echoInterface, {
            echo: ({ text }) => ({ text: `${process.env.ECHO_PREFIX ?? ''}${text}`, pid: process.pid }),
            ticks: async ({ count }, _context, stream) => {
                for (let tick = 0; tick < count; tick++) await stream.send({ tick });
                return { done: true };
            },
        });
        if (process.env.ECHO_REFLECTION) connection.enableReflection({ serviceId });
    },
});
await host.done;
if (process.env.ECHO_EXIT_DELAY_MS) await new Promise(resolve => setTimeout(resolve, Number(process.env.ECHO_EXIT_DELAY_MS)));
process.exit(0);
