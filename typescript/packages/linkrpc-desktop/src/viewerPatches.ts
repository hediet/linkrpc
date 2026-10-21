/** Patches the pinned noVNC client at the serving boundary, failing visibly on upstream drift. */
export function patchNoVnc(path: string, source: string): string {
    const replace = (old: string, replacement: string, expected = 1) => {
        if (source.split(old).length - 1 !== expected) throw new Error(`noVNC patch mismatch in ${path}: ${old}`);
        source = source.replaceAll(old, replacement);
    };
    if (path === 'core/rfb.js') {
        replace('            const size = this._screenSize();\n            this._display.autoscale(size.w, size.h);',
            '            this._display.scale = 1 / window.devicePixelRatio;');
        replace('        const size = this._screenSize();\n\n        // Do we actually change anything?',
            `        this._updateScale();
        const viewport = this._screenSize();
        const size = { w: Math.round(viewport.w * window.devicePixelRatio),
                       h: Math.round(viewport.h * window.devicePixelRatio) };

        // Do we actually change anything?`);
        // Advertise only lossless framebuffer encodings.
        replace('            if (supportsWebCodecsH264Decode) {\n                encs.push(encodings.encodingH264);\n            }\n', '');
        for (const encoding of ['Tight', 'JPEG']) replace(`            encs.push(encodings.encoding${encoding});\n`, '');
        replace('            encs.push(encodings.encodingTightPNG);', '            encs.push(encodings.encodingHextile);\n            encs.push(encodings.encodingTightPNG);');
        replace('            encs.push(encodings.encodingHextile);\n            encs.push(encodings.encodingRRE);', '            encs.push(encodings.encodingRRE);');
    }
    if (path === 'core/display.js') {
        replace("        this._targetCtx = this._target.getContext('2d');",
            "        this._targetCtx = this._target.getContext('2d');\n        this._targetCtx.imageSmoothingEnabled = false;\n        this._target.style.imageRendering = 'pixelated';");
        replace("        this._drawCtx = this._backbuffer.getContext('2d');",
            "        this._drawCtx = this._backbuffer.getContext('2d');\n        this._drawCtx.imageSmoothingEnabled = false;");
        replace('            canvas.height = height;\n\n', '            canvas.height = height;\n            this._targetCtx.imageSmoothingEnabled = false;\n\n');
        replace('            if (saveImg) {\n                this._drawCtx.putImageData',
            '            this._drawCtx.imageSmoothingEnabled = false;\n            if (saveImg) {\n                this._drawCtx.putImageData');
    }
    return source;
}
