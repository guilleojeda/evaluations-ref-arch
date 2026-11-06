export interface BackendEvent {
  readonly message?: string;
}

export interface BackendResponse {
  readonly statusCode: number;
  readonly body: string;
}

export async function handler(event: BackendEvent = {}): Promise<BackendResponse> {
  return {
    statusCode: 200,
    body: JSON.stringify({
      component: "controller",
      message: event.message ?? "Incident Triage controller backend is ready",
    }),
  };
}
