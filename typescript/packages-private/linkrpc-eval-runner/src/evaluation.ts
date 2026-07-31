export interface Score {
    readonly name: string;
    readonly value: number;
    readonly details?: unknown;
}

export type Scorer<Input, Output> = (
    input: Input,
    output: Output,
) => Score | Promise<Score>;

export interface Evaluation<Input, Output> {
    readonly inputs: Iterable<Input> | AsyncIterable<Input>;
    readonly run: (input: Input) => Promise<Output>;
    readonly scorers: readonly Scorer<Input, Output>[];
}

export interface EvaluationResult<Input, Output> {
    readonly input: Input;
    readonly output: Output;
    readonly scores: readonly Score[];
}

export async function evaluate<Input, Output>(
    evaluation: Evaluation<Input, Output>,
): Promise<readonly EvaluationResult<Input, Output>[]> {
    const results: EvaluationResult<Input, Output>[] = [];
    for await (const input of evaluation.inputs) {
        const output = await evaluation.run(input);
        const scores = await Promise.all(
            evaluation.scorers.map((scorer) => scorer(input, output)),
        );
        results.push({ input, output, scores });
    }
    return results;
}