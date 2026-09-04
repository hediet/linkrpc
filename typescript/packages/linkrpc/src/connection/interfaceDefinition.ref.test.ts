import { describe, expect, expectTypeOf, it } from 'vitest';
import { object, string } from 'zod/mini';
import { defineInterface, type InterfaceMemberRef } from './interfaceDefinition';
import { notificationType, requestType } from '../schema/memberTypes';

describe('InterfaceDefinition.ref', () => {
    const iface = defineInterface(
        { id: 'demo.ref' },
        {
            echo: requestType(object({ value: string() }), object({ value: string() })),
            changed: notificationType(object({ value: string() })),
        },
    );

    it('creates stable wire references with the interface hash', () => {
        expect(iface.ref.echo).toEqual({
            interfaceId: 'demo.ref',
            interfaceHash: iface.schemaHash,
            member: 'echo',
        });
        expect(iface.ref.changed).toEqual({
            interfaceId: 'demo.ref',
            interfaceHash: iface.schemaHash,
            member: 'changed',
        });
    });

    it('preserves the member name in the reference type', () => {
        expectTypeOf(iface.ref.echo).toEqualTypeOf<InterfaceMemberRef<'echo'>>();
    });

    it('enumerates only actual interface members', () => {
        expect(Object.keys(iface.ref)).toEqual(['echo', 'changed']);
        expect('echo' in iface.ref).toBe(true);
        expect((iface.ref as Record<string, unknown>).missing).toBeUndefined();
    });
});
