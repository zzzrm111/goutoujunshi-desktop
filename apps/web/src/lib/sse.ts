export type SsePayload = Record<string, unknown>;
export type SseEventHandler = (event: string, payload: SsePayload) => void;

export function parseSseFrames(input: string, onEvent: SseEventHandler, flush = false): string {
  const frames = input.split(/\r?\n\r?\n/);
  const remainder = flush ? "" : (frames.pop() ?? "");
  for (const frame of frames) {
    let event = "";
    const dataLines: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (!event || dataLines.length === 0) continue;
    try {
      onEvent(event, JSON.parse(dataLines.join("\n")) as SsePayload);
    } catch {
      // Ignore malformed frames so one upstream event cannot crash the chat UI.
    }
  }
  return remainder;
}

export async function consumeSseResponse(response: Response, onEvent: SseEventHandler): Promise<void> {
  const body = response.body;
  const canStream = body && typeof body.getReader === "function" && typeof TextDecoder !== "undefined";
  if (!canStream) {
    parseSseFrames(await response.text(), onEvent, true);
    return;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = parseSseFrames(buffer, onEvent);
  }
  buffer += decoder.decode();
  parseSseFrames(buffer, onEvent, true);
}
