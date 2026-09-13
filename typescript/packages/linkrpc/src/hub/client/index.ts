/**
 * linkrpc hub — **client** entry.
 *
 * The participant-side façade for talking to a hub over an established
 * connection. Transport-neutral; pairs with the {@link ../common common}
 * primitives.
 */
export { Hub, hubFromConnection } from './hubFacade';
export type { SlotPrerequest, SlotReservation } from './hubFacade';
export { HubSigningSender } from './hubSigningSender';
