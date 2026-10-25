import { describe, expect, it } from 'vitest';
import { formatHttpExportHost, parseHttpExportHost, resolveServiceReference } from './hostname';

describe('http export hostnames', () => {
    it('writes each service as one label below localhost, with the port in front', () => {
        const hosts = [
            { serviceId: 'hediet/tablet/compute', params: {} },
            { serviceId: 'hediet/tablet/compute', params: { port: 3000 } },
            { serviceId: 'hediet/code-insiders/compute', params: { port: 80 } },
        ].map(target => formatHttpExportHost(target));
        expect({
            hosts,
            parsed: hosts.map(host => parseHttpExportHost(`${host}:8080`)),
        }).toEqual({
            hosts: [
                'hediet--tablet--compute.localhost',
                '3000.hediet--tablet--compute.localhost',
                '80.hediet--code-insiders--compute.localhost',
            ],
            parsed: [
                { kind: 'service', service: { kind: 'readable', serviceId: 'hediet/tablet/compute' }, params: {} },
                { kind: 'service', service: { kind: 'readable', serviceId: 'hediet/tablet/compute' }, params: { port: 3000 } },
                { kind: 'service', service: { kind: 'readable', serviceId: 'hediet/code-insiders/compute' }, params: { port: 80 } },
            ],
        });
    });

    it('hashes service IDs that are not plain labels, are too long, or resemble reserved labels, and resolves them', () => {
        const dotted = 'hediet/tablet/ahp/ahp.code-insiders-editor';
        const long = `hediet/${'a'.repeat(70)}/compute`;
        const hashLike = 'other/h0123456789ab';
        const idna = 'xn/compute';
        const serviceIds = [dotted, long, hashLike, idna];
        const hosts = serviceIds.map(serviceId => formatHttpExportHost({ serviceId, params: { port: 3000 } }));
        expect({
            twoLabels: hosts.every(host => host.split('.').length === 3 && host.split('.').every(label => label.length <= 63)),
            shapes: hosts.map(host => host.replace(/[a-f0-9]{12}\.localhost$/, '<hash>.localhost')),
            resolved: hosts.map(host => {
                const parsed = parseHttpExportHost(host);
                return parsed?.kind === 'service' ? resolveServiceReference(parsed.service, [...serviceIds, 'hediet/other']) : undefined;
            }),
        }).toEqual({
            twoLabels: true,
            shapes: [
                '3000.hediet-tablet-ahp-ahp-code-insiders-editor--h<hash>.localhost',
                `3000.hediet-${'a'.repeat(41)}--h<hash>.localhost`,
                '3000.other-h0123456789ab--h<hash>.localhost',
                '3000.xn-compute--h<hash>.localhost',
            ],
            resolved: serviceIds,
        });
    });

    it('distinguishes the index, unrelated hosts, and malformed labels', () => {
        expect([
            'localhost',
            'localhost:80',
            'example.com',
            '99999.compute.localhost',
            '3000.localhost',
            'Tablet--Compute.localhost',
            '3000.compute.tablet.localhost',
            'api.tablet--compute.localhost',
            'tablet---compute.localhost',
        ].map(host => parseHttpExportHost(host))).toEqual([
            { kind: 'index' },
            { kind: 'index' },
            undefined,
            undefined,
            undefined,
            { kind: 'service', service: { kind: 'readable', serviceId: 'tablet/compute' }, params: {} },
            undefined,
            undefined,
            undefined,
        ]);
    });
});
