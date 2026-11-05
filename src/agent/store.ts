import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { OrderSchema, type Order } from "./policy";

/** Project 7's public server. Its demo tokens are public on purpose: they only reach fake data. */
const DEFAULT_MCP_URL = "https://mcp-ecommerce-server.vercel.app/api/mcp";
const DEFAULT_MCP_TOKEN = "demo-support-agent";

export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema: unknown;
}

/** What the graph needs from the store. Every call goes through MCP; this project holds no store data. */
export interface Store {
  getOrder(orderId: string): Promise<Order | null>;
  listTools(): Promise<ToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export function storeFromClient(client: Client): Store {
  return {
    async getOrder(orderId) {
      const result = await client.callTool({ name: "get_order", arguments: { orderId } });
      return result.isError ? null : OrderSchema.parse(result.structuredContent);
    },
    async listTools() {
      return (await client.listTools()).tools;
    },
    async callTool(name, args) {
      const result = await client.callTool({ name, arguments: args });
      return result.isError ? { error: result.content } : (result.structuredContent ?? result.content);
    },
    close: () => client.close(),
  };
}

export async function connectStore(env: NodeJS.ProcessEnv = process.env): Promise<Store> {
  const client = new Client({ name: "post-sale-agent", version: "0.1.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(env.MCP_URL || DEFAULT_MCP_URL), {
      requestInit: { headers: { authorization: `Bearer ${env.MCP_TOKEN || DEFAULT_MCP_TOKEN}` } },
    }),
  );
  return storeFromClient(client);
}
