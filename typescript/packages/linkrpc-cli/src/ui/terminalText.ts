export function safeTerminalText(text: string): string {
    let result = '';
    for (const character of text) {
        result += /^[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]$/u.test(character)
            ? `\\u{${character.codePointAt(0)!.toString(16).padStart(4, '0')}}`
            : character;
    }
    return result;
}
