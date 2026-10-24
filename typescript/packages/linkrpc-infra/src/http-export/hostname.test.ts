import { describe, expect, it } from 'vitest';
import { formatHttpExportHost, parseHttpExportHost, resolveServiceReference } from './hostname';

describe('http export hostnames', () => {
    it('round-trips readable service IDs with inline parameters', () => {
        const hosts = [
            { serviceId: 'hediet/tablet/compute', params: {} },
            { serviceId: 'hediet/tablet/compute', params: { port: 3000 } },
            { serviceId: 'hediet/tablet/compute', params: { port: 80, named: { path: 'api', mode: 'raw' } } },
        ].map(target => formatHttpExportHost(target));
        expect({
            hosts,
            parsed: hosts.map(host => parseHttpExportHost(`${host}:8080`)),
        }).toEqual({
            hosts: [
                'compute.tablet.hediet.localhost',
                '3000.compute.tablet.hediet.localhost',
                '80--mode-raw--path-api.compute.tablet.hediet.localhost',
            ],
            parsed: [
                { kind: 'service', service: { kind: 'readable', serviceId: 'hediet/tablet/compute' }, params: {} },
                { kind: 'service', service: { kind: 'readable', serviceId: 'hediet/tablet/compute' }, params: { port: 3000 } },
                { kind: 'service', service: { kind: 'readable', serviceId: 'hediet/tablet/compute' }, params: { port: 80, named: { mode: 'raw', path: 'api' } } },
            ],
        });
    });

    it('hashes service IDs that are not DNS labels or exceed DNS limits, and resolves them', () => {
        const dotted = 'hediet/tablet/ahp/ahp.code-insiders-editor';
        const long = `hediet/${'a'.repeat(70)}/compute`;
        const deep = Array.from({ length: 40 }, (_, index) => `segment${index}`).join('/');
        const hosts = [dotted, long, deep].map(serviceId => formatHttpExportHost({ serviceId, params: { port: 3000 } }));
        expect({
            fitDns: hosts.every(host => host.length <= 253 && host.split('.').every(label => label.length <= 63)),
            shapes: hosts.map(host => host.replace(/[a-f0-9]{12}\.localhost$/, '<hash>.localhost')),
            resolved: hosts.map(host => {
                const parsed = parseHttpExportHost(host);
                return parsed?.kind === 'service' ? resolveServiceReference(parsed.service, [dotted, long, deep, 'hediet/other']) : undefined;
            }),
        }).toEqual({
            fitDns: true,
            shapes: [
                '3000.hediet-tablet-ahp-ahp-code-insiders-editor--h<hash>.localhost',
                `3000.hediet-${'a'.repeat(41)}--h<hash>.localhost`,
                '3000.segment0-segment1-segment2-segment3-segment4-seg--h<hash>.localhost',
            ],
            resolved: [dotted, long, deep],
        });
    });

    it('distinguishes the index, unrelated hosts, and malformed labels', () => {
        expect([
            'localhost',
            'localhost:80',
            'example.com',
            '99999.compute.localhost',
            '3000.localhost',
            'Compute.Tablet.localhost',
            'foo--bar.localhost',
        ].map(host => parseHttpExportHost(host))).toEqual([
            { kind: 'index' },
            { kind: 'index' },
            undefined,
            undefined,
            undefined,
            { kind: 'service', service: { kind: 'readable', serviceId: 'tablet/compute' }, params: {} },
            undefined,
        ]);
    });
});
