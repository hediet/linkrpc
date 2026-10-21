import { hostParticipant, type ParticipantHostHandle, type ParticipantHostOptions } from '@hediet/linkrpc-hub/participant-host';
import { DesktopHost, desktopHandlers, desktopInterface } from '@hediet/linkrpc-infra/desktop';
import { VncBackend, type VncSource } from './vncBackend';

export async function hostVncDesktop(
    source: VncSource,
    options: Pick<ParticipantHostOptions, 'endpoint' | 'serviceId' | 'signal' | 'managedIdentity'> = {},
): Promise<ParticipantHostHandle> {
    // Shared across all participant connections, so separate callers cannot each acquire a controller.
    const desktop = new DesktopHost(new VncBackend(source));
    try {
        const host = await hostParticipant({
            ...options,
            registrationMode: 'grantedServiceId',
            setup: ({ services, connection, serviceId }) => {
                services.register(desktopInterface, { desktop: desktopHandlers(() => desktop) });
                connection.enableReflection();
                if (serviceId !== undefined) connection.enableReflection({ serviceId });
            },
        });
        void host.done.then(() => desktop.dispose(), () => desktop.dispose());
        return host;
    } catch (error) {
        desktop.dispose();
        throw error;
    }
}
