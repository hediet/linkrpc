import { describe, expect, it } from 'vitest';
import { complete } from './complete';
import type { DirectoryEntry, DirectorySource } from './directorySource';

function makeDir(opts: {
    entries: readonly DirectoryEntry[];
    methods?: ReadonlyMap<string, readonly string[]>;
    params?: ReadonlyMap<string, readonly string[]>;
}): DirectorySource {
    return {
        entries: () => Promise.resolve(opts.entries),
        methodsOnInterface: (sid, iid) => {
            const key = `${sid ?? ''}::${iid}`;
            const m = opts.methods?.get(key);
            return Promise.resolve(m ?? []);
        },
        paramNamesForMethod: (sid, iid, method) => {
            const key = `${sid ?? ''}::${iid}::${method}`;
            const p = opts.params?.get(key);
            return Promise.resolve(p ?? []);
        },
    };
}

describe('complete (static-only)', () => {
    it('returns subcommand names at the top level', async () => {
        const r = await complete({ line: 'hub ', point: 4 });
        const texts = r.map((c) => c.text);
        expect(texts).toContain('call');
        expect(texts).toContain('ls');
        expect(texts).toContain('tunnel');
        // Internal commands stay hidden.
        expect(texts).not.toContain('_complete');
    });

    it('keeps hub-only commands out of the RPC profile', async () => {
        const r = await complete({ line: 'rpc ', point: 4 });
        const texts = r.map((c) => c.text);
        expect(texts).toContain('call');
        expect(texts).toContain('hub');
        expect(texts).not.toContain('topology');
        expect(texts).not.toContain('tunnel');

        const flags = await complete({ line: 'rpc call --c', point: 'rpc call --c'.length });
        expect(flags.map((candidate) => candidate.text)).not.toContain('--config');
    });

    it('offers hub-only commands below the linkrpc hub profile', async () => {
        const r = await complete({ line: 'linkrpc hub ', point: 'linkrpc hub '.length });
        const texts = r.map((c) => c.text);
        expect(texts).toContain('call');
        expect(texts).toContain('topology');
        expect(texts).toContain('tunnel');

        const flags = await complete({
            line: 'linkrpc hub call --c',
            point: 'linkrpc hub call --c'.length,
        });
        expect(flags.map((candidate) => candidate.text)).toContain('--config');
    });

    it('normalizes path-qualified hub executable variants', async () => {
        const line = 'C:\\tools\\hub.cmd ';
        const r = await complete({ line, point: line.length });
        expect(r.map((candidate) => candidate.text)).toContain('topology');
    });

    it('filters subcommands by prefix', async () => {
        const r = await complete({ line: 'hub cal', point: 7 });
        expect(r.map((c) => c.text)).toEqual(['call']);
    });

    it('returns nested connection subcommands', async () => {
        const r = await complete({ line: 'hub connection ', point: 'hub connection '.length });
        expect(r.map((c) => c.text)).toEqual([
            'create',
            'destroy',
            'notifications',
            'status',
        ]);
    });

    it('includes parent options on nested commands', async () => {
        const r = await complete({
            line: 'hub topology participants --s',
            point: 'hub topology participants --s'.length,
        });
        expect(r.map((c) => c.text)).toContain('--source');
    });

    it('lists flag names after `call --`', async () => {
        const r = await complete({ line: 'hub call --', point: 11 });
        const texts = r.map((c) => c.text);
        expect(texts).toContain('--params');
        expect(texts).toContain('--param');
        expect(texts).toContain('--no-validate');
        // Global flags merge in too.
        expect(texts).toContain('--endpoint');
        expect(texts).toContain('--principal');
    });

    it('completes `completions <shell>` to known shells', async () => {
        const r = await complete({ line: 'hub completions ', point: 16 });
        expect(r.map((c) => c.text)).toEqual(['bash', 'fish', 'powershell', 'zsh']);
    });

    it('returns empty when no directory and a dynamic slot is requested', async () => {
        const r = await complete({ line: 'hub call ', point: 9 });
        expect(r).toEqual([]);
    });
});

describe('complete (with directory)', () => {
    const entries: readonly DirectoryEntry[] = [
        { serviceId: '', interfaceId: 'hubrpc.directory', hash: 'h1' },
        { serviceId: '', interfaceId: 'hubrpc.schemas', hash: 'h2' },
        { serviceId: 'azure-cli', interfaceId: 'Runner', hash: 'ha' },
        { serviceId: 'azure-cli', interfaceId: 'hubrpc.directory', hash: 'h1' },
        { serviceId: 'github', interfaceId: 'github.workspace', hash: 'hg' },
        { serviceId: 'github', interfaceId: 'github.repos', hash: 'hr' },
    ];

    const methods = new Map<string, readonly string[]>([
        ['azure-cli::Runner', ['getStatus', 'login', 'logout', 'runCommand']],
        ['github::github.workspace', ['list', 'open']],
    ]);

    const dir = makeDir({ entries, methods });

    it('lists known serviceIds for `tunnel <serviceId>`', async () => {
        const r = await complete({ line: 'hub tunnel ', point: 11, directory: dir });
        expect(r.map((c) => c.text)).toEqual(['azure-cli', 'github']);
    });

    it('filters serviceIds by prefix', async () => {
        const r = await complete({ line: 'hub tunnel azu', point: 14, directory: dir });
        expect(r.map((c) => c.text)).toEqual(['azure-cli']);
    });

    it('lists serviceIds and root-hosted interfaceIds (no trailing ::) for `call <0-sep>`', async () => {
        const r = await complete({ line: 'hub call ', point: 9, directory: dir });
        const texts = r.map((c) => c.text);
        // Bare suggestions — user adds `::` to drill in. Service-bound
        // interfaces (e.g. azure-cli::Runner) are NOT suggested bare since
        // they wouldn't route as form-2.
        expect(texts).toContain('azure-cli');
        expect(texts).toContain('github');
        expect(texts).toContain('hubrpc.directory'); // root-hosted
        expect(texts).toContain('hubrpc.schemas');   // root-hosted
        expect(texts).not.toContain('Runner');        // service-bound only
        expect(texts).not.toContain('github.workspace');
        expect(texts).not.toContain('azure-cli::');
        expect(texts).not.toContain('hubrpc.directory::');
    });

    it('lists interfaces on a serviceId (no trailing ::) for `call <sid>::`', async () => {
        const r = await complete({ line: 'hub call azure-cli::', point: 20, directory: dir });
        const texts = r.map((c) => c.text);
        expect(texts).toContain('azure-cli::Runner');
        expect(texts).toContain('azure-cli::hubrpc.directory');
        expect(texts).not.toContain('azure-cli::Runner::');
    });

    it('does NOT attempt form-2 method completion when first is not a root interface', async () => {
        // `github` is a serviceId, not a root interface. Without the
        // root-interface guard we'd fetch a schema for "github" on every TAB.
        const calls: string[] = [];
        const trackingDir = makeDir({
            entries,
            methods,
        });
        const wrapped = {
            ...trackingDir,
            methodsOnInterface: (sid: string | undefined, iid: string) => {
                calls.push(`${sid ?? ''}::${iid}`);
                return trackingDir.methodsOnInterface(sid, iid);
            },
        };
        const r = await complete({ line: 'hub call github::', point: 17, directory: wrapped });
        // Suggestions should only be the interfaces of the `github` service.
        const texts = r.map((c) => c.text);
        expect(texts).toContain('github::github.workspace');
        expect(texts).toContain('github::github.repos');
        // And we should NOT have fetched any schema (form-2 was skipped).
        expect(calls).toEqual([]);
    });

    it('attempts form-2 method completion when first IS a root interface', async () => {
        // `hubrpc.directory` is registered at root → form-2 valid.
        const dirWithRootMethods = makeDir({
            entries,
            methods: new Map([
                ['::hubrpc.directory', ['list', 'get']],
                ...methods,
            ]),
        });
        const r = await complete({
            line: 'hub call hubrpc.directory::',
            point: 'hub call hubrpc.directory::'.length,
            directory: dirWithRootMethods,
        });
        const texts = r.map((c) => c.text);
        expect(texts).toContain('hubrpc.directory::list');
        expect(texts).toContain('hubrpc.directory::get');
    });

    it('lists methods for `call <sid>::<iface>::`', async () => {
        const r = await complete({
            line: 'hub call azure-cli::Runner::',
            point: 'hub call azure-cli::Runner::'.length,
            directory: dir,
        });
        expect(r.map((c) => c.text)).toEqual([
            'azure-cli::Runner::getStatus',
            'azure-cli::Runner::login',
            'azure-cli::Runner::logout',
            'azure-cli::Runner::runCommand',
        ]);
    });

    it('filters method-name suggestions by typed prefix', async () => {
        const r = await complete({
            line: 'hub call azure-cli::Runner::lo',
            point: 'hub call azure-cli::Runner::lo'.length,
            directory: dir,
        });
        expect(r.map((c) => c.text)).toEqual([
            'azure-cli::Runner::login',
            'azure-cli::Runner::logout',
        ]);
    });

    it('uses interfaceIds for the `schema show <interfaceRef>` positional', async () => {
        const r = await complete({
            line: 'hub schema show gith',
            point: 'hub schema show gith'.length,
            directory: dir,
        });
        expect(r.map((c) => c.text)).toEqual(['github.repos', 'github.workspace']);
    });

    it('completes legacy command forms', async () => {
        const commands = await complete({ line: 'hub che', point: 'hub che'.length });
        expect(commands.map((candidate) => candidate.text)).toEqual(['check-compat']);

        const schemas = await complete({
            line: 'hub schema gith',
            point: 'hub schema gith'.length,
            directory: dir,
        });
        expect(schemas.map((candidate) => candidate.text))
            .toEqual(['github.repos', 'github.workspace']);
    });

    it('uses serviceIds for `ls --service `', async () => {
        const r = await complete({ line: 'hub ls --service ', point: 17, directory: dir });
        expect(r.map((c) => c.text)).toEqual(['azure-cli', 'github']);
    });
});

describe('complete (--p:<name> shortcuts)', () => {
    const entries: readonly DirectoryEntry[] = [
        { serviceId: '', interfaceId: 'acme.email', hash: 'h' },
        { serviceId: 'acme.mailer', interfaceId: 'acme.email', hash: 'h' },
    ];
    const params = new Map<string, readonly string[]>([
        ['::acme.email::send', ['to', 'subject', 'body']],
        ['acme.mailer::acme.email::send', ['to', 'subject', 'body']],
    ]);
    const dir = (() => {
        const make = (entries: readonly DirectoryEntry[]) => ({
            entries: () => Promise.resolve(entries),
            methodsOnInterface: () => Promise.resolve([]),
            paramNamesForMethod: (sid: string | undefined, iid: string, m: string) => {
                const key = `${sid ?? ''}::${iid}::${m}`;
                return Promise.resolve(params.get(key) ?? []);
            },
        });
        return make(entries);
    })();

    it('suggests --p:<name> after the methodRef on `call`', async () => {
        const line = 'hub call acme.email::send ';
        const r = await complete({ line, point: line.length, directory: dir });
        const ps = r.filter((c) => c.text.startsWith('--p:'));
        expect(ps.map((c) => c.text)).toEqual(['--p:body', '--p:subject', '--p:to']);
    });

    it('filters --p:<name> by prefix', async () => {
        const line = 'hub call acme.email::send --p:s';
        const r = await complete({ line, point: line.length, directory: dir });
        const texts = r.map((c) => c.text);
        expect(texts).toContain('--p:subject');
        expect(texts).not.toContain('--p:to');
        expect(texts).not.toContain('--p:body');
    });

    it('also works for `notify`', async () => {
        const line = 'hub notify acme.email::send --p:';
        const r = await complete({ line, point: line.length, directory: dir });
        const ps = r.filter((c) => c.text.startsWith('--p:'));
        expect(ps.map((c) => c.text)).toEqual(['--p:body', '--p:subject', '--p:to']);
    });

    it('works for form-3 (service::iface::method) refs', async () => {
        const line = 'hub call acme.mailer::acme.email::send --p:';
        const r = await complete({ line, point: line.length, directory: dir });
        const ps = r.filter((c) => c.text.startsWith('--p:'));
        expect(ps.map((c) => c.text)).toEqual(['--p:body', '--p:subject', '--p:to']);
    });

    it('does NOT suggest --p:<name> before a methodRef is present', async () => {
        const line = 'hub call --p:';
        const r = await complete({ line, point: line.length, directory: dir });
        const ps = r.filter((c) => c.text.startsWith('--p:'));
        expect(ps).toEqual([]);
    });

    it('does NOT suggest --p:<name> on subcommands other than call/notify', async () => {
        const line = 'hub ls --p:';
        const r = await complete({ line, point: line.length, directory: dir });
        const ps = r.filter((c) => c.text.startsWith('--p:'));
        expect(ps).toEqual([]);
    });
});
