/**
 * IPC Client for communicating with the CLI from the agent
 *
 * This enables the agent to signal session completion, send heartbeats,
 * and communicate experiment metadata back to the CLI.
 *
 * The CLI exposes its socket path via the SIA_CLI_SOCKET_PATH environment variable.
 */

import net from "node:net";

export interface CliMessage {
  type: "heartbeat" | "session_complete" | "experiment_info";
  payload?: Record<string, unknown>;
}

/**
 * Check if CLI socket communication is available
 */
export function isCliSocketAvailable(): boolean {
  return !!process.env.SIA_CLI_SOCKET_PATH;
}

/**
 * Send a message to the CLI socket
 *
 * @param message - The message to send
 * @returns Promise<boolean> - true if sent successfully, false otherwise
 */
export async function sendToCliSocket(message: CliMessage): Promise<boolean> {
  const socketPath = process.env.SIA_CLI_SOCKET_PATH;
  if (!socketPath) {
    return false;
  }

  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath, () => {
      // Message format: 4-byte big-endian length + JSON payload
      const messageBuffer = Buffer.from(JSON.stringify(message));
      const lengthBuffer = Buffer.alloc(4);
      lengthBuffer.writeInt32BE(messageBuffer.length, 0);
      socket.write(Buffer.concat([lengthBuffer, messageBuffer]));
      socket.end();
      resolve(true);
    });

    socket.on("error", () => {
      resolve(false);
    });

    // Don't block process exit
    socket.unref();
  });
}

/**
 * Signal that the experiment session is complete
 *
 * @param summary - Optional summary of what was accomplished
 * @returns Promise<boolean> - true if sent successfully
 */
export async function signalSessionComplete(
  summary?: string,
): Promise<boolean> {
  return sendToCliSocket({
    type: "session_complete",
    payload: { summary, timestamp: new Date().toISOString() },
  });
}

/**
 * Send a heartbeat to indicate activity
 *
 * @param activity - Description of the activity
 * @param toolName - Optional tool name if this is a tool invocation
 * @returns Promise<boolean> - true if sent successfully
 */
export async function sendHeartbeat(
  activity: string,
  toolName?: string,
): Promise<boolean> {
  return sendToCliSocket({
    type: "heartbeat",
    payload: {
      activity,
      toolName,
      timestamp: new Date().toISOString(),
    },
  });
}

/**
 * Send experiment info to the CLI
 *
 * @param info - Experiment metadata to send
 * @returns Promise<boolean> - true if sent successfully
 */
export async function sendExperimentInfo(
  info: Record<string, unknown>,
): Promise<boolean> {
  return sendToCliSocket({
    type: "experiment_info",
    payload: info,
  });
}
