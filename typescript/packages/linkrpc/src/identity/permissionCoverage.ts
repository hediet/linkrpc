import { matchParams, type ParamMatcher, type Pattern, type Permission } from "../protocol/capability";

/** Conservative call-set containment; ability flags are checked by the caller. */
export function permissionScopeCovers(granted: Permission, requested: Permission): boolean {
    const g = granted.target;
    const r = requested.target;
    if (!patternCovers(g.serviceId, r.serviceId, "/")
        || !patternCovers(g.interfaceId, r.interfaceId, ".")
        || (g.interfaceHash !== undefined && g.interfaceHash !== r.interfaceHash)
        || !r.members.every(member => g.members.some(allowed => patternCovers(allowed, member, "")))) {
        return false;
    }
    if (granted.callBind !== undefined
        && (requested.callBind?.alg !== granted.callBind.alg
            || requested.callBind.payloadHash !== granted.callBind.payloadHash)) return false;
    if (granted.params === undefined) return true;
    if (requested.params === undefined) return false;
    const requestedParams = requested.params;
    const keys = Object.keys(granted.params);
    return keys.length === Object.keys(requestedParams).length
        && keys.every(key => Object.hasOwn(requestedParams, key)
            && paramCovers(granted.params![key], requestedParams[key]));
}

function patternCovers(granted: Pattern, requested: Pattern, delimiter: string): boolean {
    if ("exact" in granted) return "exact" in requested && granted.exact === requested.exact;
    const value = "exact" in requested ? requested.exact : requested.prefix;
    return granted.prefix === "" || value === granted.prefix || value.startsWith(granted.prefix + delimiter);
}

function paramCovers(granted: ParamMatcher, requested: ParamMatcher): boolean {
    if (Object.keys(granted).length !== 1 || Object.keys(requested).length !== 1) return false;
    if ("any" in granted) return true;
    if ("any" in requested) return false;
    if ("exact" in requested) return matchParams({ value: granted }, { value: requested.exact }).ok;
    if ("enum" in requested) {
        return requested.enum.every(value => matchParams({ value: granted }, { value }).ok);
    }
    if ("prefix" in requested) return "prefix" in granted && requested.prefix.startsWith(granted.prefix);
    return "subsetOf" in requested && "subsetOf" in granted
        && requested.subsetOf.every(value => granted.subsetOf.includes(value));
}
