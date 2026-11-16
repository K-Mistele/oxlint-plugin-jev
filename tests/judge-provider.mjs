// An AI SDK provider for the LLM-judge tests. Its one language model forwards the prompt to the
// mock server named by JEV_JUDGE_URL and returns the mock's text as the model output.
const url = process.env.JEV_JUDGE_URL ?? '';

const usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

function languageModel(modelId) {
  return {
    specificationVersion: 'v4',
    provider: 'judge-mock',
    modelId,
    supportedUrls: {},
    async doGenerate(options) {
      const prompt = options.prompt
        .filter((message) => message.role === 'user')
        .flatMap((message) => message.content)
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('');
      const response = await fetch(`${url}/judge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt }),
        signal: options.abortSignal,
      });
      const { text } = await response.json();
      return {
        content: [{ type: 'text', text }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage,
        warnings: [],
        response: { modelId: `${modelId}-answered` },
      };
    },
    async doStream() {
      throw new Error('not supported');
    },
  };
}

export default { specificationVersion: 'v4', languageModel };
