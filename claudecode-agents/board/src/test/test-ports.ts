import { closeServer, listenOnEphemeralPort } from "./test-utils.ts";

/** An ephemeral loopback port that is free at the moment this resolves, for tests to bind. */
export async function unusedLoopbackPort(): Promise<number> {
	const { server: portProbe, port } = await listenOnEphemeralPort();
	await closeServer(portProbe);
	return port;
}
