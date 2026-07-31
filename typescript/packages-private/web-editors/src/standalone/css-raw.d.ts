/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** `*.css?raw` imports resolve to the stylesheet's text (see rollup `rawCss`). */
declare module "*.css?raw" {
    const css: string;
    export default css;
}
