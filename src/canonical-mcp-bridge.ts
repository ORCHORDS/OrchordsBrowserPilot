import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

import type { Session } from "./session.js";
import { buildServer } from "./server.js";

export interface CanonicalMcpBridgeOptions {
  policyMode?: "audit" | "enforce";
}

export class CanonicalMcpBridge {
  private constructor(
    private readonly client: Client,
    private readonly closeServer: () => Promise<void>,
  ) {}

  static async create(
    session: Session,
    solver: { url?: string; token?: string },
    options: CanonicalMcpBridgeOptions = {},
  ): Promise<CanonicalMcpBridge> {
    const server = buildServer(session, solver, { policyMode: options.policyMode });
    const client = new Client({ name: "orchords-native-bridge", version: "0.1.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return new CanonicalMcpBridge(client, async () => {
      await Promise.all([client.close(), server.close()]);
    });
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options: { signal?: AbortSignal } = {},
  ) {
    return this.client.request(
      { method: "tools/call", params: { name, arguments: args } },
      CallToolResultSchema,
      options.signal ? { signal: options.signal } : undefined,
    );
  }

  async close(): Promise<void> {
    await this.closeServer();
  }
}
