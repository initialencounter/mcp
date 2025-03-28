import { Anthropic } from "@anthropic-ai/sdk";
import {
  MessageParam,
  Tool,
} from "@anthropic-ai/sdk/resources/messages/messages.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import readline from "readline/promises";
import dotenv from "dotenv";
import axios from "axios";

interface ChatResponse {
  data: {
    choices: {
      index: string,
      message: {
        content: string
        role: string
        tool_calls?:
        {
          index: 0,
          id: string,
          type: 'function',
          function: any
        }[]
      },
      logprobs: any
      finish_reason: string
    }[];
  };
}


dotenv.config();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL;
if (!ANTHROPIC_API_KEY) {
  throw new Error("ANTHROPIC_API_KEY is not set");
}

class MCPClient {
  private mcp: Client;
  private anthropic: Anthropic;
  private transport: StdioClientTransport | null = null;
  private tools: any[] = [];
  private client: Axios.AxiosInstance;
  constructor() {
    this.anthropic = new Anthropic({
      apiKey: ANTHROPIC_API_KEY,
    });
    this.client = axios.create({
      baseURL: ANTHROPIC_BASE_URL,
      headers: {
        Authorization: `Bearer ${ANTHROPIC_API_KEY}`,
        'Content-Type': 'application/json',
      },
    }) as Axios.AxiosInstance;
    this.mcp = new Client({ name: "mcp-client-cli", version: "1.0.0" });
  }
  // methods will go here
  async connectToServer(serverScriptPath: string) {
    try {
      const isJs = serverScriptPath.endsWith(".js");
      const isPy = serverScriptPath.endsWith(".py");
      if (!isJs && !isPy) {
        throw new Error("Server script must be a .js or .py file");
      }
      const command = isPy
        ? process.platform === "win32"
          ? "python"
          : "python3"
        : process.execPath;

      this.transport = new StdioClientTransport({
        command,
        args: [serverScriptPath],
      });
      this.mcp.connect(this.transport);

      const toolsResult = await this.mcp.listTools();
      this.tools = toolsResult.tools.map((tool) => {
        return {
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          }
        };
      });
      console.log(
        "Connected to server with tools:",
        this.tools.map(({ name }) => name)
      );
    } catch (e) {
      console.log("Failed to connect to MCP server: ", e);
      throw e;
    }
  }

  async processQuery(query: string) {
    const messages: MessageParam[] = [
      {
        role: "user",
        content: query,
      },
    ];

    console.dir(JSON.stringify(this.tools), { depth: null });
    // What is the weather today in GuangZhou?
    const response: ChatResponse = await this.client.post("/chat/completions", {
      model: "deepseek-chat",
      messages,
      stream: false,
      tools: this.tools,
    })

    const finalText = [];
    const toolResults = [];
    const content = response.data?.choices[0].message;
    if (content.content) {
      finalText.push(content.content);
    } else if (content.tool_calls) {
      for(const tool of content.tool_calls){
        const func = tool.function;
        const toolName = func.name;
        const toolArgs = JSON.parse(func.arguments) as { [x: string]: unknown } | undefined;

        const result = await this.mcp.callTool({
          name: toolName,
          arguments: toolArgs,
        });
        toolResults.push(result);
        finalText.push(
          `[Calling tool ${toolName} with args ${JSON.stringify(toolArgs)}]`
        );

        messages.push({
          role: "user",
          content: result.content as string,
        });

        const response: ChatResponse = await this.client.post("/chat/completions", {
          model: "deepseek-chat",
          messages,
          stream: false,
        })

        finalText.push(
          response.data.choices[0].message.content as string
        );
      }
    }
    return finalText.join("\n");
  }

  async chatLoop() {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    try {
      console.log("\nMCP Client Started!");
      console.log("Type your queries or 'quit' to exit.");

      while (true) {
        const message = await rl.question("\nQuery: ");
        if (message.toLowerCase() === "quit") {
          break;
        }
        const response = await this.processQuery(message);
        console.log("\n" + response);
      }
    } catch (e) {
      console.log("Error in chatLoop: ", e);
    } finally {
      rl.close();
    }
  }

  async cleanup() {
    await this.mcp.close();
  }
}

async function main() {
  if (process.argv.length < 3) {
    console.log("Usage: node index.ts <path_to_server_script>");
    return;
  }
  const mcpClient = new MCPClient();
  try {
    await mcpClient.connectToServer(process.argv[2]);
    await mcpClient.chatLoop();
  } finally {
    await mcpClient.cleanup();
    process.exit(0);
  }
}

main();