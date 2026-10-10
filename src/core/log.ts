/**
 * The one place this package writes a log line.
 *
 * The host's `client.app.log` is optional — a host that has none must still
 * work — and a log line is never worth failing the flow that asked for it,
 * so every write here swallows its own failure. Lines carry the service
 * name and the vendor's id, so one log view can tell the two vendors apart
 * (the host prefixes its own spec anyway; this is for the message itself).
 */

import type { PluginClient } from "./types.ts"

export const LOG_SERVICE = "cn-ai"

export interface VendorLogger {
  warn(message: string): Promise<void>
  info(message: string): Promise<void>
}

export function vendorLogger(client: PluginClient, vendor: string): VendorLogger {
  const write = async (level: string, message: string): Promise<void> => {
    try {
      await client.app?.log?.({ service: LOG_SERVICE, level, message: `${vendor}: ${message}` })
    } catch {
      // A host whose log refuses the line has nothing to say about the flow.
    }
  }
  return {
    warn: (message) => write("warn", message),
    info: (message) => write("info", message),
  }
}
