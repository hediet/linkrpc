import { describe, expect, it } from 'vitest';
import { MethodRefWithOptHash } from './methodRef';
import { formatSuggestion, HubSnapshot, type SnapshotEntry } from './suggest';

// A single fixed hub used by every case below. Mirrors the matrix discussed
// in the design: a hub root + three "domain" services + an admin variant.
const FIXTURE_ENTRIES: SnapshotEntry[] = [
    { serviceId: '', interfaceId: 'hubrpc.directory', hash: 'a3f2b1', methods: ['list'] },
    { serviceId: '', interfaceId: 'hubrpc.defaults', hash: 'a3f2b1', methods: ['get'] },
    { serviceId: '', interfaceId: 'hubrpc.schemas', hash: 'a3f2b1', methods: ['get'] },
    {
        serviceId: 'hub',
        interfaceId: 'hubAccess',
        hash: 'a3f2b1',
        methods: ['login', 'logout', 'getStatus', 'listSubscriptions'],
    },
    { serviceId: 'hub', interfaceId: 'hubrpc.directory', hash: 'a3f2b1', methods: ['list'] },
    {
        serviceId: 'vscode',
        interfaceId: 'vscode.lm',
        hash: 'a3f2b1',
        methods: ['sendChatRequest', 'listModels'],
    },
    {
        serviceId: 'vscode',
        interfaceId: 'vscode.fs',
        hash: 'a3f2b1',
        methods: ['readFile', 'writeFile', 'stat'],
    },
    {
        serviceId: 'vscode',
        interfaceId: 'vscode.commands',
        hash: 'a3f2b1',
        methods: ['executeCommand', 'getCommands'],
    },
    {
        serviceId: 'github',
        interfaceId: 'github.workspace',
        hash: 'a3f2b1',
        methods: ['getRepo', 'listFiles'],
    },
    {
        serviceId: 'github',
        interfaceId: 'github.faults',
        hash: 'a3f2b1',
        methods: ['reportFault'],
    },
    {
        serviceId: 'github',
        interfaceId: 'github.pos',
        hash: 'a3f2b1',
        methods: ['getCursorPosition'],
    },
    {
        serviceId: 'azure-cli',
        interfaceId: 'Runner',
        hash: 'a3f2b1',
        methods: ['runCommand', 'getStatus'],
    },
    { serviceId: 'azure-cli', interfaceId: 'hubrpc.directory', hash: 'a3f2b1', methods: ['list'] },
    {
        serviceId: 'hub-admin',
        interfaceId: 'hubAccess',
        hash: 'a3f2b1',
        methods: ['grantCap', 'revokeCap'],
    },
    {
        serviceId: 'hub-admin',
        interfaceId: 'hub-admin',
        hash: 'a3f2b1',
        methods: ['listConnections'],
    },
];

const FIXTURE = new HubSnapshot(FIXTURE_ENTRIES);

function suggest(input: string): string {
    const ref = MethodRefWithOptHash.parseMethodRef(input);
    return formatSuggestion({ ref, snapshot: FIXTURE, verb: 'call' });
}

describe('formatSuggestion — form 1 (bare token)', () => {
    it('A1: token is a serviceId', () => {
        expect(suggest('azure-cli')).toBe(
            [
                '"azure-cli" is a serviceId, not a method.',
                '  See its interfaces:',
                '    hub ls --service azure-cli',
                '  Or call one:',
                '    hub call azure-cli::Runner::runCommand',
                '    hub call azure-cli::Runner::getStatus',
            ].join('\n'),
        );
    });

    it('A2: token is an interfaceId on multiple services', () => {
        expect(suggest('hubAccess')).toBe(
            [
                `"hubAccess" is an interface, not a method. It's hosted on services: hub, hub-admin.`,
                '  Try a call:',
                '    hub call hub::hubAccess::login',
                '    hub call hub::hubAccess::logout',
                '    hub call hub::hubAccess::getStatus',
            ].join('\n'),
        );
    });

    it('A3: method exists on exactly one (service, interface)', () => {
        expect(suggest('login')).toBe(
            [
                `"login" is not callable without an interface (no preset is set).`,
                '  Did you mean:',
                '    hub call hub::hubAccess::login',
            ].join('\n'),
        );
    });

    it('A4: method exists on multiple (service, interface)', () => {
        expect(suggest('getStatus')).toBe(
            [
                `"getStatus" is not callable without an interface (no preset is set).`,
                '  Did you mean:',
                '    hub call hub::hubAccess::getStatus',
                '    hub call azure-cli::Runner::getStatus',
            ].join('\n'),
        );
    });

    it('A5: typo of a method name', () => {
        expect(suggest('lgin')).toBe(
            [
                `"lgin" matches no known service, interface, or method.`,
                '  Closest methods:',
                '    hub call hub::hubAccess::login',
            ].join('\n'),
        );
    });

    it('A6: typo of a service id', () => {
        expect(suggest('azur-cli')).toBe(
            [
                `"azur-cli" matches no known service, interface, or method.`,
                '  Closest services:',
                '    azure-cli  (try hub ls --service azure-cli)',
            ].join('\n'),
        );
    });

    it('A7: nothing within distance', () => {
        expect(suggest('totallyMadeUp')).toBe(
            [
                `"totallyMadeUp" matches no known service, interface, or method.`,
                '  Tip: run `hub ls` to see what\'s available.',
            ].join('\n'),
        );
    });
});

describe('formatSuggestion — form 2 (iface::method)', () => {
    it('B1: interface valid (multi-host), method typo', () => {
        expect(suggest('hubAccess::lgin')).toBe(
            [
                'Method "lgin" not found on interface "hubAccess".',
                '  Did you mean:',
                '    hub call hub::hubAccess::login',
            ].join('\n'),
        );
    });

    it('B2: interface typo, method exists on the corrected interface', () => {
        expect(suggest('hbAccess::login')).toBe(
            [
                'Interface "hbAccess" not found.',
                '  Did you mean:',
                '    hub call hub::hubAccess::login',
            ].join('\n'),
        );
    });

    it('B3: first token is a serviceId, second token is a real method on it', () => {
        expect(suggest('azure-cli::runCommand')).toBe(
            [
                'Interface "runCommand" not found on service "azure-cli", but "runCommand" is a method name there.',
                '  Did you mean:',
                '    hub call azure-cli::Runner::runCommand',
            ].join('\n'),
        );
    });

    it('B3b: first token is a serviceId, second is a prefix of interfaces on it', () => {
        expect(suggest('vscode::vscode.')).toBe(
            [
                `Interfaces on "vscode" starting with "vscode.":`,
                '    hub call vscode::vscode.lm::sendChatRequest',
                '    hub call vscode::vscode.fs::readFile',
                '    hub call vscode::vscode.commands::executeCommand',
            ].join('\n'),
        );
    });

    it('B3c: first token is a serviceId, second matches neither method nor prefix', () => {
        expect(suggest('azure-cli::xyz')).toBe(
            [
                `Interface "xyz" not found on service "azure-cli". Interfaces on "azure-cli":`,
                '    hub call azure-cli::Runner::runCommand',
            ].join('\n'),
        );
    });

    it('B4: interface valid (single host), method typo — shows host', () => {
        expect(suggest('vscode.lm::sendChatRequst')).toBe(
            [
                'Method "sendChatRequst" not found on interface "vscode.lm" (service: vscode).',
                '  Did you mean:',
                '    hub call vscode::vscode.lm::sendChatRequest',
            ].join('\n'),
        );
    });

    it('B5: interface valid, method has no fuzzy hits — falls back to enumeration', () => {
        expect(suggest('hubAccess::xyz')).toBe(
            [
                'Method "xyz" not found on interface "hubAccess".',
                '  Available methods:',
                '    hub call hub::hubAccess::login',
                '    hub call hub::hubAccess::logout',
                '    hub call hub::hubAccess::getStatus',
                '    hub call hub::hubAccess::listSubscriptions',
                '    hub call hub-admin::hubAccess::grantCap',
                '    hub call hub-admin::hubAccess::revokeCap',
            ].join('\n'),
        );
    });

    it('B6: interface typo with no close match', () => {
        expect(suggest('completelyMadeUpIface::login')).toBe(
            [
                'Interface "completelyMadeUpIface" not found.',
                '  Tip: run `hub ls` to see what\'s available.',
            ].join('\n'),
        );
    });
});

describe('formatSuggestion — form 3 (svc::iface::method)', () => {
    it('C1: service + interface valid; method typo', () => {
        expect(suggest('azure-cli::Runner::runCommnd')).toBe(
            [
                'Method "runCommnd" not found on azure-cli::Runner.',
                '  Did you mean:',
                '    hub call azure-cli::Runner::runCommand',
            ].join('\n'),
        );
    });

    it('C2: service valid; interface typo; method exists on suggestion', () => {
        expect(suggest('azure-cli::Ruunner::runCommand')).toBe(
            [
                'Interface "Ruunner" not found on service "azure-cli".',
                '  Did you mean:',
                '    hub call azure-cli::Runner::runCommand',
            ].join('\n'),
        );
    });

    it('C2b: form-3, interface part is a prefix on the service — list matches', () => {
        expect(suggest('vscode::vscode.::readFile')).toBe(
            [
                `Interface "vscode." not found on service "vscode". Interfaces starting with "vscode.":`,
                '    hub call vscode::vscode.lm::sendChatRequest',
                '    hub call vscode::vscode.fs::readFile',
                '    hub call vscode::vscode.commands::executeCommand',
            ].join('\n'),
        );
    });

    it('C3: service valid; interface exists elsewhere — footnote, not swap', () => {
        expect(suggest('azure-cli::vscode.fs::readFile')).toBe(
            [
                'Interface "vscode.fs" not found on service "azure-cli".',
                '  Interfaces on "azure-cli": Runner',
                '  Note: "vscode.fs" exists on service "vscode". Did you mean:',
                '    hub call vscode::vscode.fs::readFile',
            ].join('\n'),
        );
    });

    it('C4: service typo; corrected service makes the call valid', () => {
        expect(suggest('azur-cli::Runner::runCommand')).toBe(
            [
                'Service "azur-cli" not found.',
                '  Did you mean:',
                '    hub call azure-cli::Runner::runCommand',
            ].join('\n'),
        );
    });

    it('C7: service unknown, no close match', () => {
        expect(suggest('totallyMadeUp::Runner::runCommand')).toBe(
            [
                'Service "totallyMadeUp" not found.',
                '  Tip: run `hub ls` to see what\'s available.',
            ].join('\n'),
        );
    });
});

describe('formatSuggestion — verb', () => {
    it('emits "hub notify ..." copy-paste lines when verb is notify', () => {
        const ref = MethodRefWithOptHash.parseMethodRef('login');
        expect(formatSuggestion({ ref, snapshot: FIXTURE, verb: 'notify' })).toBe(
            [
                `"login" is not callable without an interface (no preset is set).`,
                '  Did you mean:',
                '    hub notify hub::hubAccess::login',
            ].join('\n'),
        );
    });
});

describe('HubSnapshot indexing', () => {
    it('groups by service, interface, and method name', () => {
        const snap = FIXTURE;
        expect(snap.services()).toContain('hub');
        expect(snap.services()).toContain('azure-cli');
        expect(snap.interfacesOnService('azure-cli')).toEqual(['Runner', 'hubrpc.directory']);
        expect(snap.servicesHostingInterface('hubAccess')).toEqual(['hub', 'hub-admin']);
        expect(snap.methodsOn('vscode', 'vscode.lm')).toEqual(['sendChatRequest', 'listModels']);
        expect(snap.locationsOfMethod('getStatus')).toEqual([
            { serviceId: 'hub', interfaceId: 'hubAccess' },
            { serviceId: 'azure-cli', interfaceId: 'Runner' },
        ]);
    });
});
