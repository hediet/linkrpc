/**
 * Static overlap guard for {@link module:./runHub}. The hub's forwarding table
 * silently overwrites a duplicate prefix; this catches a misconfigured hub at
 * startup instead — two transports claiming the same service id, or two
 * default routes — with a message naming both owners.
 *
 * Only *statically configured* routes are tracked here. Service ids that peers
 * claim dynamically through a listener are authorized by the hub's claim
 * policy, not this table.
 */
export class RouteTable {
    private readonly _claimed = new Map<string, string>();
    private _defaultOwner: string | undefined;

    /** Record that `owner` routes `serviceId`. Throws on a conflicting claim. */
    public claim(serviceId: string, owner: string): void {
        const existing = this._claimed.get(serviceId);
        if (existing !== undefined && existing !== owner) {
            throw new Error(
                `route conflict: service id '${serviceId}' is claimed by both `
                + `'${existing}' and '${owner}'`,
            );
        }
        this._claimed.set(serviceId, owner);
    }

    /** Record `owner` as the single default route. Throws on a second one. */
    public setDefault(owner: string): void {
        if (this._defaultOwner !== undefined && this._defaultOwner !== owner) {
            throw new Error(
                `default-route conflict: both '${this._defaultOwner}' and '${owner}' `
                + `set defaultRoute; at most one is allowed`,
            );
        }
        this._defaultOwner = owner;
    }
}
