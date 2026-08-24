import { describe, expect, it } from 'vitest';
import { MethodRefWithOptHash } from './methodRef';

describe('parseMethodRef', () => {
    it('parses form 1 (bare method)', () => {
        const r = MethodRefWithOptHash.parseMethodRef('send');
        expect(r).toMatchObject({
            serviceId: undefined,
            interfaceId: undefined,
            methodName: 'send',
            hash: undefined,
        });
        expect(r.getMethodOnWire()).toBe('send');
    });

    it('parses form 2 (interface::method)', () => {
        const r = MethodRefWithOptHash.parseMethodRef('acme.email::send');
        expect(r).toMatchObject({
            serviceId: undefined,
            interfaceId: 'acme.email',
            methodName: 'send',
        });
        expect(r.getMethodOnWire()).toBe('acme.email::send');
    });

    it('parses form 3 (service::interface::method)', () => {
        const r = MethodRefWithOptHash.parseMethodRef('acme.mailer::acme.email::send');
        expect(r).toMatchObject({
            serviceId: 'acme.mailer',
            interfaceId: 'acme.email',
            methodName: 'send',
        });
        expect(r.getMethodOnWire()).toBe('acme.mailer::acme.email::send');
    });

    it('strips trailing @<hash> and surfaces it separately', () => {
        const r = MethodRefWithOptHash.parseMethodRef('acme.email::send@abc123');
        expect(r.hash).toBe('abc123');
        expect(r.getMethodOnWire()).toBe('acme.email::send');
        expect(r.methodName).toBe('send');
    });

    it('rejects empty segments', () => {
        expect(() => MethodRefWithOptHash.parseMethodRef('::send')).toThrow();
        expect(() => MethodRefWithOptHash.parseMethodRef('acme::')).toThrow();
        expect(() => MethodRefWithOptHash.parseMethodRef('')).toThrow();
    });

    it('rejects more than three segments', () => {
        expect(() => MethodRefWithOptHash.parseMethodRef('a::b::c::d')).toThrow();
    });
});
