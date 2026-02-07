import OpenAI from "openai";
import { openaiModels, openaiDefaultModelId } from '../models';
import { LLMProvider, ProviderOptions, ModelInfo, ApiStream } from './types';

export class OpenAIProvider implements LLMProvider {
  static getAvailableModels(): { id: string; name: string }[] {
    return Object.entries(openaiModels).map(([id, model]) => ({ id, name: model.name }));
  }

  private options: ProviderOptions;
  private client: OpenAI;

  constructor(options: ProviderOptions) {
    this.options = options;
    this.client = new OpenAI({
      apiKey: this.options.apiKey,
      baseURL: this.options.baseUrl,
    });
  }

  async *createMessage(systemPrompt: string, messages: any[], tools?: any[]): ApiStream {
    const model = this.getModel();
    const modelId = model.id;
    const modelInfo = model.info;
    const isReasoningModel = !!modelInfo.isReasoningModel;

    const filteredMessages = messages.filter(message =>
      !(message.role === "user" && typeof message.content === "string" && message.content.startsWith("[SYSTEM INSTRUCTION:"))
    );

    const openaiMessages = [
      { role: "system", content: systemPrompt },
      ...filteredMessages.map((msg: any) => ({ role: msg.role, content: msg.content })),
    ];

    const options: any = {
      model: modelId,
      messages: openaiMessages,
      stream: true,
      stream_options: { include_usage: true },
    };

    if (isReasoningModel) {
      options.max_completion_tokens = modelInfo.maxTokens || 4096;
      options.temperature = 0;
    } else {
      options.max_tokens = modelInfo.maxTokens || 4096;
      options.temperature = 0;
    }

    if (tools && tools.length > 0) {
      const openAITools = tools.map(tool => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: {
            type: "object",
            properties: {
              input: { type: "string", description: "The input to the tool" },
              requires_approval: { type: "boolean", description: "Whether this tool call requires user approval" }
            },
            required: ["input"]
          }
        }
      }));
      options.tools = openAITools;
      options.tool_choice = "auto";
    }

    try {
      const stream = await this.client.chat.completions.create(options) as unknown as AsyncIterable<any>;
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (delta?.content) {
          yield { type: "text", text: delta.content };
        }
        if (chunk.usage) {
          yield {
            type: "usage",
            inputTokens: chunk.usage.prompt_tokens || 0,
            outputTokens: chunk.usage.completion_tokens || 0,
          };
        }
      }
    } catch (error) {
      yield { type: "text", text: "Error: Failed to stream response from OpenAI API. Please try again." };
    }
  }

  getModel(): { id: string; info: ModelInfo } {
    const modelId = this.options.apiModelId || openaiDefaultModelId;
    const info = openaiModels[modelId as keyof typeof openaiModels] || openaiModels[openaiDefaultModelId];
    return { id: modelId, info };
  }
}

