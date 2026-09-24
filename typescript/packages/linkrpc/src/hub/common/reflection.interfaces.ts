import { array, boolean, int, nonnegative, number, object, optional, positive, string, union, unknown } from "zod/mini";
import type { output as zInfer } from "zod/v4/core";
import { defineInterface, type StreamApi } from "../../connection/interfaceDefinition";
import { requestType } from "../../schema/memberTypes";

export const defaultsInterface = defineInterface(
    {
        id: "hubrpc.defaults",
        description: "Reflection: preset default service / interface on this connection.",
    },
    {
        get: requestType(
            object({}),
            object({
                serviceId: optional(string()),
                interfaceId: optional(string()),
                /** Hash of the preset interface, if known. */
                interfaceHash: optional(string()),
            }),
        ),
        listBindings: requestType(
            object({}),
            object({
                bindings: array(object({
                    prefix: string(),
                    serviceId: optional(string()),
                    interfaceId: string(),
                    interfaceHash: string(),
                })),
            }),
        ),
    },
);

/**
 * A single root-principal requirement. `transitive: true` means the requirement
 * also applies to every service reachable *through* this one — i.e. when this
 * listing is a `hubrpc.directory` reference, everything it lists inherits the
 * requirement (also as transitive).
 */
const zRootPrincipalReq = object({
    principal: string(),
    transitive: optional(boolean()),
});

/** One OR-set. The set is satisfied by holding *any one* of its principals. */
const zRootPrincipalSet = array(zRootPrincipalReq);

export type RootPrincipalReq = zInfer<typeof zRootPrincipalReq>;
export type RootPrincipalSet = zInfer<typeof zRootPrincipalSet>;

export const zServiceIdPattern = union([
    object({ exact: string() }),
    object({ prefix: string() }),
]);

export type ServiceIdPattern = zInfer<typeof zServiceIdPattern>;

const zServiceListing = object({
    serviceId: string(),
    interfaceId: string(),
    /** Hash of the interface as implemented by this service. */
    interfaceHash: string(),
    /** Optional, non-authoritative discovery labels of this implemented interface. */
    tags: optional(array(string())),
    /** Optional non-normative description of the owning service. */
    serviceDescription: optional(string()),
    /**
     * Root principals required to access this service, in CNF: the caller must
     * satisfy **every** set (AND), and a set is satisfied by **any one** of its
     * principals (OR). Omitted/empty => no root-principal requirement.
     */
    rootPrincipalSets: optional(array(zRootPrincipalSet)),
    /**
     * Service-id regions reachable through this referral. Meaningful only for
     * `hubrpc.directory` entries; omission defaults to the referral service-id
     * subtree.
     */
    reachableServiceIds: optional(array(zServiceIdPattern)),
});

export const directoryInterface = defineInterface(
    {
        id: "hubrpc.directory",
        description:
            "Reflection: list services exposed by this endpoint. Can also list other directory services that can be explored.",
    },
    {
        list: requestType(
            object({
                /** Filter: only return services implementing this interface id. */
                interfaceId: optional(string()),
                /** Filter: only return services whose interface id starts with this prefix. */
                interfaceIdPrefix: optional(string()),
                /** Filter: only return entries for this service id. */
                serviceId: optional(string()),
                /** Union filter used to constrain a transitive directory walk. */
                serviceIdScopes: optional(array(zServiceIdPattern)),

                /** Paging: opaque continuation token from a previous response. */
                cursor: optional(string()),
                /** Paging: max items in this page. Server MAY return fewer. */
                limit: optional(number().check(int(), positive())),

                /** Soft cap on time the server spends gathering this page, in ms. */
                timeoutMs: optional(number().check(int(), nonnegative())),
            }),
            object({
                items: array(zServiceListing),
                /** Omitted => no more pages. */
                nextCursor: optional(string()),
                /** True if `timeoutMs` cut the page short before exhausting results. */
                truncated: optional(boolean()),
            }),
        ),
        /**
         * Coarse change tap on the directory.
         *
         * `watch` is a long-lived streaming request that emits an **empty tick**
         * whenever the (optionally filtered) directory *might* have changed. The
         * tick carries no delta and no payload — its only meaning is "re-`list`
         * now". The consumer reconciles against its own last snapshot.
         *
         * This keeps the server stateless: it never computes or replays
         * per-item deltas, never does an initial-sync replay. Over-emission is
         * allowed (the consumer re-lists and finds nothing new); under-emission
         * is not. Ticks are coalesced. The `interfaceId` / `serviceId` filters
         * mirror `list` and are a relevance hint, not a guarantee.
         *
         * The request resolves when the caller cancels (or the connection
         * drops); the runtime auto-detaches the stream when it settles.
         */
        watch: requestType(
            object({
                /** Relevance hint: changes touching this interface id. */
                interfaceId: optional(string()),
                /** Relevance hint: changes touching an interface id with this prefix. */
                interfaceIdPrefix: optional(string()),
                /** Relevance hint: changes touching this service id. */
                serviceId: optional(string()),
                /** Relevance hint: changes within any of these service-id regions. */
                serviceIdScopes: optional(array(zServiceIdPattern)),
            }),
            object({}),
        ).withStream({
            /** Empty tick: "the directory may have changed; re-list." */
            server: object({}),
        }),
    },
);

/**
 * A `directoryInterface.watch` handler for a **static** directory. It opens the
 * stream, never ticks, and resolves when the caller cancels. Dynamic providers,
 * including {@link LinkRpcConnection.enableReflection}, use a change-emitting
 * implementation instead.
 */
export function directoryWatchNever(
    _params: {
        interfaceId?: string;
        interfaceIdPrefix?: string;
        serviceId?: string;
        serviceIdScopes?: ServiceIdPattern[];
    },
    _ctx: unknown,
    stream: StreamApi<unknown, Record<string, never>>,
): Promise<Record<string, never>> {
    return new Promise((resolve) => {
        if (stream.signal.aborted) {
            resolve({});
            return;
        }
        stream.signal.addEventListener("abort", () => resolve({}), { once: true });
    });
}

export const schemasInterface = defineInterface(
    {
        id: "hubrpc.schemas",
        description:
            "Reflection: fetch interface schemas by id (+ optional hash). Must serve the interfaces advertised in this endpoint's directory.",
    },
    {
        get: requestType(
            object({
                interfaceId: string(),
                /** Omit => server picks the version it exposes. */
                hash: optional(string()),
            }),
            object({
                /** A full `SvcInterfaceSchema`. */
                schema: unknown(),
            }),
        ),
    },
);
