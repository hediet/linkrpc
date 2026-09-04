import { describe, expect, it } from 'vitest';
import { parseLine } from './parse';
import { resolveSlot } from './resolve';
import { COMMAND_TREE } from './tree';

function slotFor(line: string, point: number = line.length) {
    const parsed = parseLine(line, point);
    return resolveSlot(parsed, COMMAND_TREE);
}

describe('resolveSlot', () => {
    it('detects the subcommand slot when the user types the first token', () => {
        const r = slotFor('hub ca');
        expect(r.slot.kind).toBe('subcommand');
        expect(r.subcommand).toBeUndefined();
    });

    it('detects a positional methodRef slot after `call`', () => {
        const r = slotFor('hub call ');
        expect(r.slot.kind).toBe('positional');
        expect(r.slot).toMatchObject({ type: 'methodRef', index: 0 });
        expect(r.subcommand?.name).toBe('call');
    });

    it('detects a flag-name slot when current word starts with `-`', () => {
        const r = slotFor('hub call --par');
        expect(r.slot.kind).toBe('flag-name');
        expect(r.subcommand?.name).toBe('call');
    });

    it('detects flag-value slot for a flag consumed but value missing', () => {
        const r = slotFor('hub --endpoint ');
        expect(r.slot.kind).toBe('flag-value');
        if (r.slot.kind === 'flag-value') {
            expect(r.slot.flag.name).toBe('--endpoint');
        }
    });

    it('records seenFlagValues for known flags with values', () => {
        const r = slotFor('hub --endpoint wss://hub call ');
        expect(r.seenFlagValues.get('--endpoint')).toBe('wss://hub');
        expect(r.subcommand?.name).toBe('call');
    });

    it('handles --flag=value form', () => {
        const r = slotFor('hub --endpoint=wss://hub call ');
        expect(r.seenFlagValues.get('--endpoint')).toBe('wss://hub');
        expect(r.subcommand?.name).toBe('call');
    });

    it('treats `--foo=` as flag-value slot when --foo takes a value', () => {
        const r = slotFor('hub --endpoint=', 'hub --endpoint='.length);
        expect(r.slot.kind).toBe('flag-value');
        if (r.slot.kind === 'flag-value') expect(r.slot.flag.name).toBe('--endpoint');
    });

    it('returns flag-value typed `serviceId` for ls --service', () => {
        const r = slotFor('hub ls --service ');
        expect(r.slot.kind).toBe('flag-value');
        if (r.slot.kind === 'flag-value') expect(r.slot.flag.valueType).toBe('serviceId');
    });

    it('does NOT consume a value after a boolean flag', () => {
        const r = slotFor('hub --provision-identity call ');
        // After the boolean flag, `call` is consumed as the subcommand.
        expect(r.subcommand?.name).toBe('call');
        expect(r.slot.kind).toBe('positional');
    });

    it('returns no-slot for an unknown subcommand', () => {
        const r = slotFor('hub bogus ');
        expect(r.slot.kind).toBe('none');
    });

    it('advances positional index across positionals', () => {
        const r = slotFor('hub schema check-compat foo ');
        expect(r.slot.kind).toBe('positional');
        if (r.slot.kind === 'positional') {
            expect(r.slot.index).toBe(1);
            expect(r.slot.type).toBe('free'); // local schema path
        }
    });

    it('classifies `completions <shell>` positional as shell type', () => {
        const r = slotFor('hub completions ');
        expect(r.slot.kind).toBe('positional');
        if (r.slot.kind === 'positional') expect(r.slot.type).toBe('shell');
    });

    it('records seenPositionals after the subcommand', () => {
        const r = slotFor('hub call acme.email::send ');
        expect(r.seenPositionals).toEqual(['acme.email::send']);
    });

    it('records all positionals for multi-positional commands', () => {
        const r = slotFor('hub schema check-compat acme.email ./local.json ');
        expect(r.seenPositionals).toEqual(['acme.email', './local.json']);
    });

    it('detects nested subcommand slots', () => {
        const r = slotFor('hub connection ');
        expect(r.slot).toMatchObject({ kind: 'subcommand' });
        expect(r.subcommand?.name).toBe('connection');
    });

    it('resolves a nested command positional', () => {
        const r = slotFor('hub schema show ');
        expect(r.slot).toMatchObject({ kind: 'positional', type: 'interfaceRef', index: 0 });
        expect(r.subcommand?.name).toBe('show');
    });

    it('resolves parent options after a nested command', () => {
        const r = slotFor('hub topology participants --source ');
        expect(r.slot.kind).toBe('flag-value');
        if (r.slot.kind === 'flag-value') {
            expect(r.slot.flag.name).toBe('--source');
            expect(r.slot.flag.valueType).toBe('serviceId');
        }
    });
});
