/**
 * Public completion API for `@hediet/linkrpc-cli`. Consumed by the CLI's own
 * `_complete` command and by external front-ends (the VS Code extension's
 * terminal completion provider) that want to reuse the completion engine
 * in-process rather than spawning the binary.
 */
export {
    completeForLine,
    type CompleteForLineOptions,
    type CompleteForLineResult,
} from './runComplete';
export { complete, type Completion, type CompleteOptions } from './complete';
export { parseLine, type ParsedLine, type Token } from './parse';
export { resolveSlot, type Slot, type ResolvedContext } from './resolve';
export { COMMAND_TREE, type CommandTree, type SlotType, type SubcommandDef, type FlagDef } from './tree';
export {
    type DirectorySource,
    type DirectoryEntry,
    ChannelDirectorySource,
} from './directorySource';
